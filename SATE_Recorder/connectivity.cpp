// SATE Recorder connectivity implementation. See connectivity.h.
//
// Threading model: NimBLE callbacks only copy bytes into buffers and set
// flags; ALL real work (JSON ops, SD access, Wi-Fi, HTTP, notifications)
// runs from connLoop(), which the sketch calls from loop(). This mirrors
// the touch-callback rule used by the UI.

#include "connectivity.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Update.h>
#include <WiFiClientSecure.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
#include <SD_MMC.h>
#include <WiFi.h>

#include "esp_heap_caps.h"
#include "esp_wifi.h"
#include "esp_coexist.h"
#include "esp_ota_ops.h"
#include "esp_system.h"   // esp_reset_reason(): boot cause for heartbeat + banner

// ---- protocol constants (mirror src/protocol.ts) ---------------------------

static const char *SATE_SERVICE = "53415445-0001-4a7e-8c5e-000000000001";
static const char *CHAR_INFO    = "53415445-0001-4a7e-8c5e-000000000010";
static const char *CHAR_CONTROL = "53415445-0001-4a7e-8c5e-000000000020";
static const char *CHAR_STATUS  = "53415445-0001-4a7e-8c5e-000000000030";
static const char *CHAR_DATA    = "53415445-0001-4a7e-8c5e-000000000040";

static const uint8_t FRAME_PARTIAL = 0x01;
static const uint8_t FRAME_FINAL   = 0x02;

static const uint8_t ADV_MAGIC             = 0x5A;
static const uint8_t ADV_FLAG_UNPROVISIONED = 0x01;
static const uint8_t ADV_FLAG_NEEDS_SYNC    = 0x02;

// BLE write payload per packet on the app side is 180; we use the same for
// notifications so the link works regardless of the negotiated MTU.
static const size_t BLE_CHUNK = 180;

// ---- timing -----------------------------------------------------------------

// millis()-wrap-safe deadline test: true once `now` has reached `deadline`.
// A plain `now > deadline` inverts for the whole wrap window (~49.7 days of
// uptime), latching timers permanently expired or permanently pending.
static inline bool timeAfter(uint32_t now, uint32_t deadline)
{
  return (int32_t)(now - deadline) >= 0;
}

// ---- PSRAM placement ---------------------------------------------------------
// The 2nd TLS handshake (OTA, fresh poll after a drop) needs ~40 KB CONTIGUOUS
// internal RAM; while recording the largest block was measured at ~51 KB. Every
// big buffer here that is NOT DMA/ISR-touched therefore lives in PSRAM: static
// .bss carved out of internal DRAM is exactly the headroom the handshake loses.
// (ioChunk stays internal: it is the SD/BLE DMA work buffer.)
static void *psAlloc(size_t n)
{
  void *p = heap_caps_malloc(n, MALLOC_CAP_SPIRAM);
  return p ? p : malloc(n);   // PSRAM missing/full: fall back, never crash
}

// ArduinoJson allocator backed by PSRAM so the parse churn of every command
// poll / roster fetch / upload-metadata read stays off the internal heap it
// used to fragment between boot and record.
struct PsramAllocator : ArduinoJson::Allocator {
  void *allocate(size_t n) override { return psAlloc(n); }
  void  deallocate(void *p) override { free(p); }
  void *reallocate(void *p, size_t n) override {
    void *np = heap_caps_realloc(p, n, MALLOC_CAP_SPIRAM);
    return np ? np : realloc(p, n);
  }
};
static PsramAllocator s_jsonPsram;

static const uint32_t WIFI_BOOT_TIMEOUT_MS  = 18000;
static const uint32_t WIFI_PROV_TIMEOUT_MS  = 28000;
static const uint32_t WIFI_PROV_RETRY_MS    = 8000;    // re-begin every 8s if stalled (~3 tries in the window)
static const uint32_t WIFI_RETRY_PERIOD_MS  = 90000;
// Command poll is FAST so app->device commands (record / sync) feel
// near-instant. The heavy pending-scan (walks the SD) stays slow and reports a
// cached count, so the fast poll adds only a tiny HTTP GET each time.
// Each poll is a blocking HTTPS request. Against Supabase the gateway closes the
// keep-alive socket, so every poll pays a full TLS handshake (~1-2 s) that
// freezes the single-core GUI. Poll less often so the screen stays responsive;
// remote commands still land within ~12 s (we also keep the socket warm below).
static const uint32_t CMD_POLL_PERIOD_MS    = 12000;
static const uint32_t HEARTBEAT_PERIOD_MS   = 15000;  // pending-scan cadence
static const uint32_t ADV_REFRESH_PERIOD_MS = 30000;

// ---- state -------------------------------------------------------------------

static ConnMode   mode = CONN_OFF;
static char       fwVersion[40]  = "0.5.0";
static char       otaPhase[16]   = "idle";  // "idle" | "updating", sent each heartbeat
static char       serialStr[16]  = "SATE-000000";
static bool       provisioned    = false;
static char       cfgSsid[33]    = "";
static char       cfgPass[65]    = "";
static char       cfgServer[96]  = "";
static char       cfgDeviceId[48] = "";
static char       cfgDeviceKey[64] = "";

// Supabase project anon (publishable) key. The Supabase Edge Functions gateway
// requires an `apikey` header on every request; this key is public by design
// (the web app ships it in its JS bundle), so embedding it here is the same
// trust level. Sent on all device-api calls when cfgServer points at Supabase.
static const char *SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
  "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpsZ2RwaXZjYm1hb2Rnb2trZHZ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk3NTY5NTgsImV4cCI6MjA2NTMzMjk1OH0."
  "x58hiBi5EeRwbedrsrBzRkw7y2tFBw5ztIdmujZoPMQ";

// True when the provisioned server is a Supabase Functions endpoint (so we add
// the apikey header). Plain mock-server / self-hosted endpoints skip it.
static inline bool serverIsSupabase()
{
  return strstr(cfgServer, "supabase.co") != nullptr;
}

static Preferences prefs;

static uint32_t wifiDeadline   = 0;
static uint32_t nextWifiRetry  = 0;
static uint32_t nextHeartbeat  = 0;   // next full pending-scan
static uint32_t nextCmdPoll    = 0;   // next fast command poll
static uint32_t nextAdvRefresh = 0;
static bool     uploadSweepDue = false;
static bool     patientsFetchDue = false;
static bool     rebootRequested = false;
static uint32_t rebootAtMs     = 0;
static bool     factoryResetRequested = false;  // BLE factory_reset op pending
static uint32_t factoryResetAtMs      = 0;
// OTA that arrived while a take was live is DEFERRED (never flash + reboot
// under a capture): the payload is latched here and re-run from connLoop()
// once the take ends. Lost on reboot - the dashboard re-queues.
static bool     otaDeferred     = false;
static char     otaPendUrl[256] = "";
static char     otaPendVer[32]  = "";
// The pending reboot was scheduled by a successful OTA flash: hold it while a
// take is live (a button-started take can begin mid-download on the UI core).
// A plain remote `reboot` never sets this - it stays the recovery path for a
// wedged take.
static bool     rebootHoldForTake = false;

// --- OTA rollback safety -----------------------------------------------------
// arduino-esp32's initArduino() commits a freshly-flashed image (marks the OTA
// slot valid) BEFORE setup() even runs, so a bootable-but-wedged build - hangs
// in setup(), SD/display init blocks, loop() never reached - would be committed
// forever, with USB reflash the only field recovery. Returning true keeps the
// image in ESP_OTA_IMG_PENDING_VERIFY; connLoop() commits it only once this
// build has provably been servicing the device (see the health check there).
// Until then, a power cycle makes the bootloader roll back to the previous
// firmware instead of bricking the unit.
extern "C" bool verifyRollbackLater() { return true; }

// ---- dual-core ---------------------------------------------------------------
// connLoop() runs on its own task pinned to the OTHER core (see connStartNetTask)
// so its blocking HTTP/TLS never stalls the GUI + physical buttons on the Arduino
// loop core. The only shared state the GUI core touches is the request flags
// (already volatile) and the pending table; scanPending() is mutex-guarded since
// the GUI core reads the count via connPendingTotal() while the net task rewalks.
static volatile bool forcePollDue = false;        // connSetLiveState() wants an immediate poll
static volatile bool uiSdBusy    = false;          // UI core is recording/saving/playing -> pause net SD
// True while connLoop() is inside a block that touches the SD card (pending
// scans, upload slices + the writeSyncMarker/trim tail, BLE file ops). Raised
// BEFORE uiSdBusy is re-read, so the UI core gets a race-free handshake instead
// of check-then-act: it sets uiSdBusy, then waits for connNetSdIdle() - once
// observed idle, the net task cannot re-enter SD work until uiSdBusy drops.
static volatile bool netSdBusy   = false;
static SemaphoreHandle_t pendMux = nullptr;        // serializes scanPending() across cores
// The net task is NOT started at boot. During provisioning connLoop() runs on the
// main loop (core 1), exactly like the old single-core SATE_Up, so the heap has
// room for the register TLS handshake while BLE is connected. Once the device goes
// online we start the net task and hand connLoop() to core 0 for fast uploads.
static volatile bool g_wantNetTask = false;        // set on first WIFI_ONLINE
static volatile bool g_netStarted  = false;        // true once the net task exists

// Wi-Fi scan runs async so connLoop / BLE notifications never block on the
// radio (a synchronous scan stalls many seconds under BLE coexistence).
static bool     scanInProgress = false;
static bool     scanRetried    = false;
static uint32_t scanDeadline   = 0;
static const uint32_t WIFI_SCAN_ATTEMPT_MS = 11000; // per attempt; <=2 attempts

// Provisioning sub-state (runs while a BLE client is connected)
enum ProvState { PROV_IDLE, PROV_WIFI, PROV_REGISTER };
static ProvState provState = PROV_IDLE;
static uint32_t  provDeadline = 0;
static uint32_t  provRetryAt  = 0;     // re-issue WiFi.begin() once if stalled
static bool      provRetried  = false;
// Server-register retry: the register POST is a fresh TLS handshake while the BLE
// link is still open, so under coexistence it can fail to connect (the
// "Server registration failed" we saw - the POST never reaches the server). Retry
// it a few times across connLoop passes; a real 4xx (claim/account) fails fast.
static int       regAttempts = 0;
static uint32_t  regNextTry  = 0;
static char provSsid[33], provPass[65], provServer[96], provClaim[48];
// Change-Wi-Fi (NOT re-registration): connect to a new network and persist the
// creds against the SAME account/device key. Set when the app sends `change_wifi`
// or after a BOOT-hold; clears once the connect attempt finishes.
static bool      provWifiOnly  = false;
// True while a provisioned recorder is parked in BLE waiting for new Wi-Fi creds
// (BOOT-hold or remote `wifi_change`). Suppresses the auto Wi-Fi reconnect so the
// app has a window to push the new network. RAM-only: a power cycle clears it.
static bool      wifiChangeMode = false;
static uint32_t  wifiChangeStart = 0;   // when change-mode began (for auto-exit)
static const uint32_t WIFI_CHANGE_TIMEOUT_MS = 180000; // 3 min then auto-cancel

// Last STA disconnect reason + count, captured by the Wi-Fi event handler so
// provisioning can tell "wrong password" apart from "out of range" / coex flake.
static volatile int lastWifiReason  = 0;
static volatile int wifiDiscCount   = 0;

// ---- BLE objects ---------------------------------------------------------------

static NimBLEServer         *bleServer  = nullptr;
static NimBLECharacteristic *chInfo     = nullptr;
static NimBLECharacteristic *chControl  = nullptr;
static NimBLECharacteristic *chStatus   = nullptr;
static NimBLECharacteristic *chData     = nullptr;
static bool bleInited       = false;
static volatile bool bleClientConnected = false;

// Control-write reassembly (BLE task writes, connLoop consumes). Buffers live
// in PSRAM (allocated once in connInit): only ever touched from tasks, never
// DMA/ISR, and 12 KB of internal .bss here starved the TLS handshakes.
static const size_t  CTRL_BUF_MAX = 6144;
static uint8_t      *ctrlAsm = nullptr;
static size_t        ctrlAsmLen = 0;
static uint8_t      *opBuf = nullptr;
static volatile size_t opLen   = 0;   // >0 means an op is ready
static portMUX_TYPE  opMux = portMUX_INITIALIZER_UNLOCKED;

// Pending-session table built by list_sessions; "n" on the wire = index + 1.
struct PendingEntry {
  char     patientId[20];
  uint32_t num;
  uint32_t bytes;
};
static const int     PEND_MAX = 64;
static PendingEntry *pendTable = nullptr;   // PSRAM (connInit); task-only access
static int           pendCount = 0;

static uint8_t ioChunk[4096]; // connectivity's own SD/BLE work buffer

// Live status line for the on-device Connection screen.
static char statusText[72] = "Starting...";
static char ipText[20] = "";

// Live activity reported to the server in the heartbeat (idle/recording/uploading).
static char liveState[16] = "idle";

// Device telemetry for the admin dashboard, set by connSetTelemetry() from the
// UI task and sent as &bat=&recs= on every heartbeat. 255 = battery unknown.
static int      telBatteryPct = 255;
static uint32_t telRecordings = 0;
static int      telBatteryMv  = -1;   // raw cell mV for admin-side calibration (-1 = unknown)

// Why the last boot happened (esp_reset_reason(), captured once in connInit) -
// rides every heartbeat as &rst= so a field reboot on a PRODUCTION unit (no
// serial) is diagnosable from the dashboard: brownout = dying cell, panic =
// firmware bug, task-wdt = wedge, sw = OTA/remote reboot.
static int      bootResetReason = -1;

static void setStatus(const char *fmt, ...)
{
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(statusText, sizeof(statusText), fmt, ap);
  va_end(ap);
  Serial.printf("[CONN] %s\n", statusText);
  sateHookConnChanged();
}

// =============================================================================
// small helpers
// =============================================================================

static void onWifiStaDisconnected(WiFiEvent_t, WiFiEventInfo_t info)
{
  lastWifiReason = info.wifi_sta_disconnected.reason;
  wifiDiscCount  = wifiDiscCount + 1;
  Serial.printf("[CONN] WiFi STA disconnected, reason=%d (count=%d)\n",
                lastWifiReason, wifiDiscCount);
}

// True when the disconnect reason points at a bad passphrase rather than
// range/coexistence trouble.
static bool reasonLooksLikeBadPassword(int r)
{
  return r == WIFI_REASON_AUTH_FAIL ||
         r == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT ||
         r == WIFI_REASON_HANDSHAKE_TIMEOUT;
}

static void buildSerial()
{
  // eFuse factory MAC - valid even before the radio is up (WiFi.macAddress
  // returns zeros until STA start).
  uint64_t mac = ESP.getEfuseMac();
  snprintf(serialStr, sizeof(serialStr), "SATE-%02X%02X%02X",
           (uint8_t)(mac >> 24), (uint8_t)(mac >> 32), (uint8_t)(mac >> 40));
}

static void loadConfig()
{
  prefs.begin("sate", true);
  prefs.getString("ssid", cfgSsid, sizeof(cfgSsid));
  prefs.getString("pass", cfgPass, sizeof(cfgPass));
  prefs.getString("server", cfgServer, sizeof(cfgServer));
  prefs.getString("dev_id", cfgDeviceId, sizeof(cfgDeviceId));
  prefs.getString("dev_key", cfgDeviceKey, sizeof(cfgDeviceKey));
  prefs.end();
  provisioned = cfgSsid[0] != '\0' && cfgServer[0] != '\0' && cfgDeviceId[0] != '\0';
}

static void saveConfig()
{
  prefs.begin("sate", false);
  prefs.putString("ssid", cfgSsid);
  prefs.putString("pass", cfgPass);
  prefs.putString("server", cfgServer);
  prefs.putString("dev_id", cfgDeviceId);
  prefs.putString("dev_key", cfgDeviceKey);
  prefs.end();
  provisioned = true;
}

static void sessionPath(char *out, size_t n, const char *pid, uint32_t num, const char *ext)
{
  snprintf(out, n, "/sate/patients/%s/session_%04lu.%s", pid, (unsigned long)num, ext);
}

// Path of segment `part` for a session, e.g. session_0001.part02.wav.
static void sessionPartFile(char *out, size_t n, const char *pid, uint32_t num, int part)
{
  char ext[16];
  snprintf(ext, sizeof(ext), "part%02d.wav", part);
  sessionPath(out, n, pid, num, ext);
}

// Session numbers are allocated monotonically by the UI core and NEVER
// renumbered: a delete removes only that session's own files, so a patient dir
// holds an arbitrary subset of 1..SESSION_NUM_MAX (the allocator wraps there;
// holes are normal). Every session walk below must therefore skip holes instead
// of stopping at the first empty slot - and must not probe every number with
// SD_MMC.exists() either, so each dir is listed ONCE into this map.
static const uint32_t SESSION_NUM_MAX = 99;   // keep in sync with the .ino allocator

struct PatientDirScan {
  bool     audio[SESSION_NUM_MAX + 1];      // segments or a legacy merged .wav
  bool     mark[SESSION_NUM_MAX + 1];       // .synced marker present
  uint32_t wavBytes[SESSION_NUM_MAX + 1];   // legacy merged .wav file size
  uint32_t partBytes[SESSION_NUM_MAX + 1];  // raw sum of all segment file sizes
};

static void scanPatientDir(const char *pid, PatientDirScan *ps)
{
  memset(ps, 0, sizeof(*ps));
  char path[64];
  snprintf(path, sizeof(path), "/sate/patients/%s", pid);
  File d = SD_MMC.open(path);
  if (!d) return;
  File e;
  while ((e = d.openNextFile())) {
    const char *nm = e.name();               // basename or full path per core
    const char *base = strrchr(nm, '/');
    base = base ? base + 1 : nm;
    if (!strncmp(base, "session_", 8)) {
      uint32_t n = (uint32_t)strtoul(base + 8, nullptr, 10);
      const char *sfx = strchr(base + 8, '.');
      if (n >= 1 && n <= SESSION_NUM_MAX && sfx) {
        if (!strcmp(sfx, ".synced")) {
          ps->mark[n] = true;
        } else if (!strcmp(sfx, ".wav")) {
          ps->audio[n] = true;
          ps->wavBytes[n] = (uint32_t)e.size();
        } else if (!strncmp(sfx, ".part", 5)) {
          ps->audio[n] = true;
          ps->partBytes[n] += (uint32_t)e.size();
        }
      }
    }
    e.close();
  }
  d.close();
}

// True when the pending set may have changed (new recording, a sync, a roster
// change) and scanPending() must re-walk the SD card. While false, scanPending
// returns the cached count instead of walking every patient dir - that walk was
// running every 15 s heartbeat and was the periodic UI hitch.
static bool pendDirty = true;

// Sticky "the SD card is misbehaving" flag: set when the pending scan cannot
// open the patient root, or when a .synced marker cannot be written (read-only
// / failing card). Cleared as soon as the same operation succeeds again. The UI
// reads it via connSdFault() so a failed card renders as "SD card error", never
// as the reassuring "all synced" / pending==0.
static volatile bool sdFaultFlag = false;

// Scan all patient dirs for WAVs without a .synced marker. Cheap no-op when the
// cached count is still valid. scanPending() wraps this in pendMux so the GUI
// core and the net task never tear pendTable/pendCount when both walk at once.
static int scanPendingLocked()
{
  if (!pendDirty || !pendTable) return pendCount;
  File root = SD_MMC.open("/sate/patients");
  if (!root) {
    // Card unreadable: keep the PREVIOUS count/table and stay dirty so the next
    // call retries. Zeroing pendCount here made a pulled/failed card report
    // "all synced" while unsynced patient takes still sat on it.
    sdFaultFlag = true;
    return pendCount;
  }
  sdFaultFlag = false;
  pendCount = 0;
  File entry;
  while ((entry = root.openNextFile()) && pendCount < PEND_MAX) {
    if (!entry.isDirectory()) { entry.close(); continue; }
    const char *full = entry.name(); // basename or full path depending on core
    const char *pid = strrchr(full, '/');
    pid = pid ? pid + 1 : full;
    // Numbers are not contiguous (a delete leaves a hole), so list the dir once
    // and walk every possible slot: stopping at the first empty number used to
    // hide every later session - Home reported "all synced" while a real later
    // recording sat queued and never uploaded.
    static PatientDirScan ps;   // ~1 KB; serialized by pendMux (see scanPending)
    scanPatientDir(pid, &ps);
    for (uint32_t i = 1; i <= SESSION_NUM_MAX; i++) {
      if (ps.mark[i]) continue;                   // already on the server
      if (!ps.audio[i]) continue;                 // empty slot
      PendingEntry &pe = pendTable[pendCount++];
      snprintf(pe.patientId, sizeof(pe.patientId), "%s", pid);
      pe.num = i;
      pe.bytes = ps.wavBytes[i] ? ps.wavBytes[i] : ps.partBytes[i];
      if (pendCount >= PEND_MAX) break;
    }
    entry.close();
  }
  root.close();
  pendDirty = false; // cache is now valid until the pending set changes again
  return pendCount;
}

static int scanPending()
{
  if (!pendMux) return scanPendingLocked();   // pre-init (boot, single-threaded)
  xSemaphoreTake(pendMux, portMAX_DELAY);
  int r = scanPendingLocked();
  xSemaphoreGive(pendMux);
  return r;
}

// Returns true only when the marker is durably on the card. A read-only /
// failing card makes the open (or the write) fail; callers must NOT treat the
// session as synced then - the marker is what keeps the sweep from re-uploading
// it forever, and (with the verify gate) what licenses the audio trim.
static bool writeSyncMarker(const char *pid, uint32_t num)
{
  char mark[160];
  sessionPath(mark, sizeof(mark), pid, num, "synced");
  File f = SD_MMC.open(mark, FILE_WRITE);
  if (!f) {
    sdFaultFlag = true;
    Serial.printf("[CONN] writeSyncMarker: cannot create %s\n", mark);
    return false;
  }
  size_t put = f.print("synced");
  f.close();
  if (put != 6 || !SD_MMC.exists(mark)) {
    sdFaultFlag = true;
    Serial.printf("[CONN] writeSyncMarker: short write on %s\n", mark);
    return false;
  }
  sdFaultFlag = false;
  pendDirty = true; // a session just synced - pending count changed
  return true;
}

// --- Reclaim SD: keep only the newest N takes' AUDIO per patient -------------
// Once a take is .synced, its on-device audio is redundant, so a synced take
// beyond the newest N can have its audio freed to stop the SD filling. We keep
// the .synced marker as a TOMBSTONE: the slot keeps its number (so the
// allocator cannot reuse it), the pending scan still skips it, and it can be
// re-downloaded/played from the server. UNSYNCED takes are NEVER touched - the
// device is still their only copy. Full deletion stays user-only
// (deleteSessionFiles in the .ino, reached only from the Delete button).
//
// fw 1.5.13: a .synced marker alone no longer licenses the free. The marker can
// exist without the server durably holding the audio (the app sets mark_synced
// over BLE before its own upload finished; the 413 bug once left a marker with
// no storage object). Before audio is freed, GET /api/sessions/verify must
// answer stored:true for this exact session AND byte count - the server checks
// both the row and the real storage object. Any doubt (offline, non-2xx, parse
// failure, byte mismatch) keeps the audio; trim simply retries after the next
// upload. Deleting the only copy of a take is the one unrecoverable mistake
// this device can make, so the default on ANY uncertainty is "keep".
static const uint32_t KEEP_AUDIO_SESSIONS = 5;

static bool sessionHasAudioLocal(const char *pid, uint32_t n)
{
  char p[200];
  sessionPartFile(p, sizeof(p), pid, n, 0);          // new: 1-minute segments
  if (SD_MMC.exists(p)) return true;
  sessionPath(p, sizeof(p), pid, n, "wav");          // legacy: one merged file
  return SD_MMC.exists(p);
}

// Byte count of the ASSEMBLED WAV for a session, EXACTLY as the server stored it
// in sate_device_sessions.bytes: a legacy merged .wav is its own file size; a
// segmented take is one 44-byte WAV header (kept on part0 only) + all PCM. This
// mirrors beginUpload()'s upTotal and the `total` the final chunk declared, so a
// byte-for-byte match against the server row proves it is the SAME audio - not a
// same-numbered but different take (session numbers are reused after a delete).
static uint32_t sessionAssembledBytes(const char *pid, uint32_t n)
{
  char p[200];
  sessionPath(p, sizeof(p), pid, n, "wav");
  if (SD_MMC.exists(p)) {
    File f = SD_MMC.open(p, FILE_READ);
    uint32_t sz = f ? (uint32_t)f.size() : 0;
    if (f) f.close();
    return sz;
  }
  uint32_t total = 0;
  for (int k = 0;; k++) {
    sessionPartFile(p, sizeof(p), pid, n, k);
    if (!SD_MMC.exists(p)) break;
    File f = SD_MMC.open(p, FILE_READ);
    uint32_t sz = f ? (uint32_t)f.size() : 0;
    if (f) f.close();
    total += (k == 0) ? sz : ((sz > 44) ? sz - 44 : 0);   // part0 keeps its header
  }
  return total;
}

// Ask the server whether session `n` for `pid` is durably stored with EXACTLY
// `bytes`. Defined further down (needs httpJson); declared here for the trim.
// Returns true ONLY on a clean 2xx whose body says stored:true. Offline, any
// non-2xx, a parse failure, or stored:false all return false -> keep the audio.
static bool verifySessionStored(const char *pid, uint32_t n, uint32_t bytes);

// Free a session's AUDIO (every segment part + legacy wav + json) but KEEP its
// .synced marker so the slot stays numbered and the pending scan is unchanged.
static void freeSessionAudioKeepMarker(const char *pid, uint32_t n)
{
  char p[200];
  for (int k = 0; ; k++) {
    sessionPartFile(p, sizeof(p), pid, n, k);
    if (!SD_MMC.exists(p)) break;
    SD_MMC.remove(p);
  }
  sessionPath(p, sizeof(p), pid, n, "wav");  SD_MMC.remove(p);
  sessionPath(p, sizeof(p), pid, n, "json"); SD_MMC.remove(p);
  pendDirty = true;
}

// After a session in `pid` syncs, free the audio of any SYNCED session older than
// the newest KEEP_AUDIO_SESSIONS in that patient dir. Allocation is monotonic
// (a delete leaves its hole; a number is only reused once its old take is fully
// gone), so among occupied slots a HIGHER number is a newer take: keep the
// KEEP_AUDIO_SESSIONS highest occupied slots and consider the rest.
static void trimPatientSyncedAudio(const char *pid)
{
  PatientDirScan ps;
  scanPatientDir(pid, &ps);
  uint8_t  occ[SESSION_NUM_MAX];
  uint32_t cnt = 0;
  for (uint32_t i = 1; i <= SESSION_NUM_MAX; i++)
    if (ps.mark[i] || ps.audio[i]) occ[cnt++] = (uint8_t)i;  // tombstone = occupied
  if (cnt <= KEEP_AUDIO_SESSIONS) return;             // nothing beyond the newest N
  char mark[200];
  for (uint32_t j = 0; j < cnt - KEEP_AUDIO_SESSIONS; j++) {
    uint32_t n = occ[j];
    sessionPath(mark, sizeof(mark), pid, n, "synced");
    if (!SD_MMC.exists(mark)) continue;               // not synced -> only copy, keep
    if (!sessionHasAudioLocal(pid, n)) continue;      // already freed
    // The .synced marker is necessary but NOT sufficient to delete: it can be
    // set before the audio is durably on the server (BLE mark_synced, or the old
    // false-2xx). Confirm the server really holds THIS take, byte-for-byte,
    // before freeing the device's only copy. Any doubt -> keep it; the next
    // upload/trim cycle retries. Deleting an unconfirmed take is unrecoverable.
    uint32_t bytes = sessionAssembledBytes(pid, n);
    if (bytes == 0) continue;                         // nothing measurable -> keep
    if (!verifySessionStored(pid, n, bytes)) {
      Serial.printf("[CONN] keep %s session %lu — server did not confirm %lu bytes\n",
                    pid, (unsigned long)n, (unsigned long)bytes);
      continue;
    }
    freeSessionAudioKeepMarker(pid, n);
    Serial.printf("[CONN] freed synced audio %s session %lu (server-confirmed, keep newest %u)\n",
                  pid, (unsigned long)n, (unsigned)KEEP_AUDIO_SESSIONS);
  }
}

// Defined with the uploader further down; needed here to reset its memory.
static void upResumeClear();
static void strikeClearAll();

// Re-upload everything the card still holds: drop the .synced marker of every
// session that STILL HAS AUDIO, so the sweep picks it up again.
//
// Only sessions with audio. A session whose audio was reclaimed after upload is
// left alone: its .synced marker is a TOMBSTONE that keeps its number occupied,
// so the allocator cannot hand that number to a new take while the server still
// stores the old recording under it - and with no audio on the card there is
// nothing to resend anyway.
//
// Re-uploading a session the server already has is safe: /sessions/chunk answers
// the final slice from the existing row (after confirming its object is really
// there), so it costs bandwidth, not correctness.
static int resyncAll()
{
  int cleared = 0;
  File root = SD_MMC.open("/sate/patients");
  if (!root) return 0;
  File entry;
  while ((entry = root.openNextFile())) {
    if (!entry.isDirectory()) { entry.close(); continue; }
    const char *full = entry.name();
    const char *p = strrchr(full, '/');
    char pid[24];
    snprintf(pid, sizeof(pid), "%s", p ? p + 1 : full); // copy: name() dies with entry
    entry.close();

    // Holes are normal (deletes never renumber) - walk the whole number space
    // from one directory listing instead of stopping at the first empty slot.
    PatientDirScan ps;
    scanPatientDir(pid, &ps);
    char mark[160];
    for (uint32_t i = 1; i <= SESSION_NUM_MAX; i++) {
      if (ps.mark[i] && ps.audio[i]) {               // audio still here - resend it
        sessionPath(mark, sizeof(mark), pid, i, "synced");
        SD_MMC.remove(mark);
        cleared++;
      }
    }
  }
  root.close();
  pendDirty = true;
  upResumeClear();
  strikeClearAll();
  uploadSweepDue = true;
  Serial.printf("[CONN] resync_all: cleared %d marker(s)\n", cleared);
  return cleared;
}

// =============================================================================
// BLE
// =============================================================================

static void bleUpdateAdvertising();

class SrvCB : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *, NimBLEConnInfo &) override
  {
    bleClientConnected = true;
    setStatus("App connected (Bluetooth)");
  }
  void onDisconnect(NimBLEServer *, NimBLEConnInfo &, int) override
  {
    bleClientConnected = false;
    ctrlAsmLen = 0;
    if (provState != PROV_IDLE) esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
    provState = PROV_IDLE;
    // App left while we were waiting for new Wi-Fi creds (user backed out without
    // updating). Cancel change-mode so the device resumes normal operation and
    // the screen returns to the main page instead of sitting on "waiting".
    wifiChangeMode = false;
    NimBLEDevice::startAdvertising();
    setStatus(provisioned ? "Bluetooth on - waiting for app"
                          : "Ready for setup - open the SATE app");
  }
};

class CtrlCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &) override
  {
    NimBLEAttValue v = c->getValue();
    if (v.size() < 1 || !ctrlAsm || !opBuf) return;
    uint8_t flag = v.data()[0];
    size_t payload = v.size() - 1;
    if (ctrlAsmLen + payload <= CTRL_BUF_MAX) {
      memcpy(ctrlAsm + ctrlAsmLen, v.data() + 1, payload);
      ctrlAsmLen += payload;
    }
    if (flag == FRAME_FINAL) {
      portENTER_CRITICAL(&opMux);
      if (opLen == 0 && ctrlAsmLen < CTRL_BUF_MAX) {
        memcpy(opBuf, ctrlAsm, ctrlAsmLen);
        opBuf[ctrlAsmLen] = '\0';
        opLen = ctrlAsmLen;
      }
      portEXIT_CRITICAL(&opMux);
      ctrlAsmLen = 0;
    } else if (flag != FRAME_PARTIAL) {
      ctrlAsmLen = 0;
    }
  }
};

class InfoCB : public NimBLECharacteristicCallbacks {
  void onRead(NimBLECharacteristic *c, NimBLEConnInfo &) override
  {
    char json[160];
    snprintf(json, sizeof(json),
             "{\"model\":\"SATE Recorder\",\"fw\":\"%s\",\"serial\":\"%s\",\"provisioned\":%s}",
             fwVersion, serialStr, provisioned ? "true" : "false");
    c->setValue((uint8_t *)json, strlen(json));
  }
};

static SrvCB  srvCB;
static CtrlCB ctrlCB;
static InfoCB infoCB;

static void bleStart()
{
  if (bleInited) {
    bleUpdateAdvertising();
    NimBLEDevice::startAdvertising();
    return;
  }
  NimBLEDevice::init(serialStr);
  NimBLEDevice::setMTU(247);

  bleServer = NimBLEDevice::createServer();
  bleServer->setCallbacks(&srvCB);

  NimBLEService *svc = bleServer->createService(SATE_SERVICE);
  chInfo    = svc->createCharacteristic(CHAR_INFO, NIMBLE_PROPERTY::READ);
  chControl = svc->createCharacteristic(CHAR_CONTROL, NIMBLE_PROPERTY::WRITE);
  chStatus  = svc->createCharacteristic(CHAR_STATUS, NIMBLE_PROPERTY::NOTIFY);
  chData    = svc->createCharacteristic(CHAR_DATA, NIMBLE_PROPERTY::NOTIFY);
  chInfo->setCallbacks(&infoCB);
  chControl->setCallbacks(&ctrlCB);
  svc->start();

  bleUpdateAdvertising();
  NimBLEDevice::startAdvertising();
  bleInited = true;
  Serial.printf("[CONN] BLE advertising as %s\n", serialStr);
}

static void bleStop()
{
  if (!bleInited) return;
  NimBLEDevice::deinit(true);
  bleServer = nullptr;
  chInfo = chControl = chStatus = chData = nullptr;
  bleInited = false;
  bleClientConnected = false;
}

static void bleUpdateAdvertising()
{
  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  uint32_t pending = connPendingTotal();
  uint8_t flags = 0;
  if (!provisioned) flags |= ADV_FLAG_UNPROVISIONED;
  if (provisioned && pending > 0) flags |= ADV_FLAG_NEEDS_SYNC;

  // [company id 0xFFFF][magic][flags][pending][rsvd] — the app scans for the
  // magic byte at offsets 0 and 2, so the test company id is transparent.
  uint8_t md[6] = {0xFF, 0xFF, ADV_MAGIC, flags,
                   (uint8_t)(pending > 255 ? 255 : pending), 0x00};

  NimBLEAdvertisementData advData;
  advData.setFlags(0x06);
  advData.addServiceUUID(NimBLEUUID(SATE_SERVICE));
  advData.setManufacturerData(std::vector<uint8_t>(md, md + sizeof(md)));

  NimBLEAdvertisementData scanResp;
  scanResp.setName(serialStr);

  adv->setAdvertisementData(advData);
  adv->setScanResponseData(scanResp);
}

// Send one logical message as [flag][...] packets on a notify characteristic.
// Returns false if any packet could not be notified (client gone / TX queue
// stuck past the retry budget): the message is then INCOMPLETE on the wire and
// the caller must not act as if it was delivered - dropping a packet silently
// used to let a truncated session WAV look fully sent to the app.
static bool notifyFramed(NimBLECharacteristic *ch, const uint8_t *buf, size_t len)
{
  if (!ch || !bleClientConnected) return false;
  uint8_t pkt[1 + BLE_CHUNK];
  size_t off = 0;
  do {
    size_t take = len - off;
    if (take > BLE_CHUNK) take = BLE_CHUNK;
    pkt[0] = (off + take >= len) ? FRAME_FINAL : FRAME_PARTIAL;
    memcpy(pkt + 1, buf + off, take);
    ch->setValue(pkt, 1 + take);
    bool sent = false;
    for (int tries = 0; tries < 50 && !sent; tries++) {
      if (!bleClientConnected) return false;
      sent = ch->notify();
      if (!sent) delay(5);
    }
    if (!sent) return false;   // 250 ms of refusals: give up loudly, not silently
    off += take;
    delay(2); // pacing: keep the NimBLE TX queue happy
  } while (off < len);
  return true;
}

static void statusNotify(const char *json)
{
  notifyFramed(chStatus, (const uint8_t *)json, strlen(json));
}

static void statusOk(const char *op)
{
  char j[64];
  snprintf(j, sizeof(j), "{\"ev\":\"ok\",\"op\":\"%s\"}", op);
  statusNotify(j);
}

static void statusErr(const char *op, const char *msg)
{
  char j[160];
  snprintf(j, sizeof(j), "{\"ev\":\"err\",\"op\":\"%s\",\"msg\":\"%s\"}", op, msg);
  statusNotify(j);
}

// =============================================================================
// HTTP (device -> SATE server)
// =============================================================================

// One persistent client + HTTPClient reused across calls: with keep-alive the
// 3 s command poll skips the TCP handshake every time, so the loop task (which
// also drives LVGL) stalls for a request round-trip instead of a full connect.
// Short timeouts cap the worst-case UI freeze if the link drops mid-poll.
static WiFiClient s_httpClient;
static WiFiClientSecure s_httpsClient;   // for Supabase (HTTPS)
static HTTPClient s_http;

// Body sink for httpJson(): HTTPClient de-chunks straight into the caller's
// buffer, replacing the per-poll String allocation that churned/fragmented the
// internal heap (a poll runs every ~12 s, forever). Overflow past the buffer is
// swallowed (claimed as written) so keep-alive framing stays in sync.
class BufSink : public Stream {
public:
  char  *buf;
  size_t cap, len = 0;
  BufSink(char *b, size_t c) : buf(b), cap(c) {}
  size_t write(const uint8_t *d, size_t n) override {
    size_t room = (cap > len + 1) ? cap - 1 - len : 0;
    size_t take = (n < room) ? n : room;
    if (take) { memcpy(buf + len, d, take); len += take; }
    return n;                       // always "accepted" - excess is dropped
  }
  size_t write(uint8_t b) override { return write(&b, 1); }
  int    available() override { return 0; }
  int    read() override { return -1; }
  int    peek() override { return -1; }
  void   flush() override {}
};

static bool httpJson(const char *method, const char *path, const char *body,
                     char *resp, size_t respSize, int *codeOut)
{
  if (WiFi.status() != WL_CONNECTED) return false;
  // 96 (cfgServer) + up to 320 of path/query (heartbeat now carries rst/up/
  // heapmin telemetry) - the old 192 was one long device id from truncating.
  char url[448];
  snprintf(url, sizeof(url), "%s%s", cfgServer, path);

  s_http.setReuse(true);          // keep the socket open between calls
  s_http.setConnectTimeout(2000); // don't hang the UI waiting to connect
  s_http.setTimeout(2500);        // ...or waiting on a reply
  bool began;
  if (serverIsSupabase()) {
    // Set insecure once: re-calling it can churn the TLS client and defeat any
    // socket reuse the gateway does grant.
    static bool s_insecureSet = false;
    if (!s_insecureSet) { s_httpsClient.setInsecure(); s_insecureSet = true; }
    began = s_http.begin(s_httpsClient, url);
  } else {
    began = s_http.begin(s_httpClient, url);
  }
  if (!began) return false;
  s_http.addHeader("Content-Type", "application/json");
  if (cfgDeviceKey[0]) {
    char auth[80];
    snprintf(auth, sizeof(auth), "Bearer %s", cfgDeviceKey);
    s_http.addHeader("Authorization", auth);
  }
  if (serverIsSupabase()) s_http.addHeader("apikey", SUPABASE_ANON_KEY);
  int code = body ? s_http.sendRequest(method, (uint8_t *)body, strlen(body))
                  : s_http.sendRequest(method);
  if (codeOut) *codeOut = code;
  bool ok = code >= 200 && code < 300;
  if (ok && resp && respSize) {
    // Supabase/Cloudflare returns the body with Transfer-Encoding: chunked (no
    // Content-Length). writeToStream() de-chunks correctly (a raw stream read
    // would leave hex chunk-size markers in the buffer and break JSON parsing)
    // and lands straight in `resp` - no String heap churn per poll.
    BufSink sink(resp, respSize);
    s_http.writeToStream(&sink);
    resp[sink.len] = '\0';
  }
  s_http.end(); // with reuse(true) this returns the socket to the pool, not close
  return ok;
}

// See the forward declaration up by trimPatientSyncedAudio. The device_serial is
// intentionally omitted so the server defaults it to THIS device's serial - the
// same identity the take was uploaded under - avoiding a mismatch. patient_id +
// session_number + bytes together identify the exact take; the server answers
// stored:true only when the row AND its storage object are both present.
static bool verifySessionStored(const char *pid, uint32_t n, uint32_t bytes)
{
  if (WiFi.status() != WL_CONNECTED) return false;
  char path[224];
  snprintf(path, sizeof(path),
           "/api/sessions/verify?patient_id=%s&session_number=%lu&bytes=%lu",
           pid, (unsigned long)n, (unsigned long)bytes);
  char resp[128];
  int code = 0;
  if (!httpJson("GET", path, nullptr, resp, sizeof(resp), &code)) return false;
  JsonDocument doc(&s_jsonPsram);
  if (deserializeJson(doc, resp) != DeserializationError::Ok) return false; // parse fail -> keep
  return doc["stored"].as<bool>() == true;
}

// POST one ~1 MB slice of the WAV at byte `offset` to /api/sessions/chunk. The
// server appends in order (and is idempotent if a slice is re-sent), so a dropped
// connection only costs this slice - retried at the same offset.
//
// Returns the HTTP status, or 0 if the request never got a response. The CODE
// matters, not just success: a 409 means the server's temp blob disagrees with our
// resume offset, which is the one case where restarting the session from byte 0 is
// correct. Every other failure keeps the offset so we resume instead of restart.
static int sendSessionChunk(const char *host, int port, const char *metaQuery,
                            size_t serverOffset, size_t fileSeek, size_t len,
                            bool isFinal, size_t total, File &wf)
{
  if (WiFi.status() != WL_CONNECTED) return 0;

  // Reuse the SAME warm HTTPS client the command poll uses (keep-alive), instead
  // of opening a fresh TLS connection per chunk. A fresh handshake under WiFi+BLE
  // coexistence intermittently stalls for SECONDS even on fast Wi-Fi - that was the
  // "uploading takes minutes". The pooled socket skips the handshake, so a chunk
  // POST is as quick as a poll. The GUI runs on core 1, so no pumping is needed here.
  char url[768];   // must hold hostport + full upMetaQuery + offset/final/total
  bool tls = serverIsSupabase();
  bool defaultPort = (tls && port == 443) || (!tls && port == 80);
  char hostport[110];
  if (defaultPort) snprintf(hostport, sizeof(hostport), "%s", host);
  else             snprintf(hostport, sizeof(hostport), "%s:%d", host, port);
  // metaQuery is "<prefix>/api/sessions/chunk?...query..." (path + query, no host).
  // `total` lets the server verify the finished blob is exactly the session we
  // streamed. Without it a resume that mis-maps an offset could assemble a short
  // or padded WAV and still return 2xx.
  snprintf(url, sizeof(url), "%s://%s%s&offset=%u&final=%d&total=%u",
           tls ? "https" : "http", hostport, metaQuery,
           (unsigned)serverOffset, isFinal ? 1 : 0, (unsigned)total);

  if (!wf.seek(fileSeek)) return 0;

  s_http.setReuse(true);
  s_http.setConnectTimeout(6000);   // cap a flaky connect so a bad attempt fails fast
  // The final slice is not like the others: the server assembles the WHOLE session
  // on it (download every part, stitch, store, kick the AI pipeline). On a long
  // recording that is far more than the 12 s a normal slice needs, and timing out
  // here means retrying the whole assembly forever - the stall we are fixing. Give
  // the final request room; ordinary slices keep the tight timeout.
  s_http.setTimeout(isFinal ? 60000 : 12000);
  bool began = tls ? s_http.begin(s_httpsClient, url) : s_http.begin(s_httpClient, url);
  if (!began) return 0;
  s_http.addHeader("Content-Type", "audio/wav");
  if (cfgDeviceKey[0]) {
    char auth[80];
    snprintf(auth, sizeof(auth), "Bearer %s", cfgDeviceKey);
    s_http.addHeader("Authorization", auth);
  }
  if (tls) s_http.addHeader("apikey", SUPABASE_ANON_KEY);

  // Stream exactly `len` bytes from the seeked file as the POST body. File is a
  // Stream, so HTTPClient reads it directly - no big RAM buffer of our own.
  int code = s_http.sendRequest("POST", static_cast<Stream *>(&wf), len);
  s_http.end();   // reuse(true): returns the socket to the pool, not a hard close
  return code;
}

// Upload one pending session in ~1 MB resumable chunks. A big single POST means
// any wifi hiccup fails the whole multi-MB transfer; sending small slices (each
// retried at its own offset) makes a long recording's upload far more robust.
// Memory stays flat - slices stream straight from SD.
static const size_t UPLOAD_CHUNK_BYTES = 1024 * 1024;

// Cooperative upload: a session is a sequence of source files (its 1-minute
// segments, or one legacy merged .wav). Each pass sends ONE ~1 MB slice, then
// returns to loop() so the GUI + command polling keep running. Segments are
// streamed straight to the server (no on-device merge); the server appends them
// by offset and patches the WAV header on the final slice.
static bool     upActive = false;
static bool     upHasFile = false;
static File     upFile;            // current source file, open across passes
static int      upRetries = 0, upPort = 80;
static char     upHost[80], upMetaQuery[576], upPid[24];
static uint32_t upNum = 0, upStartMs = 0;
static bool     upLegacy = false;  // single .wav vs segment files
static int      upSrcIdx = 0, upLastSrc = 0;
static size_t   upSrcBase = 0, upSrcLen = 0, upSrcPos = 0;
static size_t   upServerOffset = 0, upTotal = 0;
static size_t   upOpenAtPos = 0;   // where to seek when the next source opens (resume)
// Set only when the server 2xx'd the final=1 slice - i.e. it assembled and STORED
// the session. The .synced marker is written off this and nothing else: it is the
// one fact that means "the server has this recording", and it must never be
// inferred from having walked to the end of the segment list.
static bool     upFinalAcked = false;

// ---- resume point ------------------------------------------------------------
// A stalled session used to restart from byte 0: beginUpload() reset
// upServerOffset, the server saw offset=0 and TRUNCATED its temp blob back to the
// first slice, so a multi-MB session could retry forever without ever advancing -
// the "uploading, no progress" backlog. Remember how far the server actually got
// and hand the same session back at that offset. Cleared once it lands, or when
// the server reports an offset gap (then we legitimately start over).
static char     upResumePid[24] = "";
static uint32_t upResumeNum = 0;
static size_t   upResumeOffset = 0;

static void upResumeSave(const char *pid, uint32_t num, size_t offset)
{
  snprintf(upResumePid, sizeof(upResumePid), "%s", pid);
  upResumeNum = num;
  upResumeOffset = offset;
}

static void upResumeClear()
{
  upResumePid[0] = '\0';
  upResumeNum = 0;
  upResumeOffset = 0;
}

static bool upResumeMatches(const char *pid, uint32_t num)
{
  return upResumeOffset > 0 && upResumeNum == num && !strcmp(upResumePid, pid);
}

// Clear the resume point only when it belongs to THIS session. The slot is
// global (one stalled session at a time), so an unconditional clear on another
// session's completion/failure wiped a large stalled take's progress and made
// the server truncate it back to byte 0 on the next attempt.
static void upResumeClearIf(const char *pid, uint32_t num)
{
  if (upResumeNum == num && !strcmp(upResumePid, pid)) upResumeClear();
}

// Tear down the in-flight upload without failing the session: close the source
// file, save the resume point (the sweep continues at the server's offset once
// conditions allow) and drop the UI overlay. Used whenever the uploader must
// stop for a reason that is not the session's fault - the UI took the SD bus,
// Wi-Fi dropped, or the mode left CONN_WIFI_ONLINE (wifi_change). MUST run on
// the task that owns upFile (the net task); the UI core only requests it via
// uiSdBusy / upDropReq.
static void uploadAbortInFlight()
{
  if (upHasFile) { upFile.close(); upHasFile = false; }
  if (!upActive) return;
  upActive = false;
  upResumeSave(upPid, upNum, upServerOffset);
  sateHookUploadEnd();
}

// ---- deferred abort of an in-flight upload ------------------------------------
// The UI deleted a session. If the uploader is mid-stream on that exact session
// it must abandon it - the deleted number can be reallocated to a future take,
// and a still-latched upload would then splice the NEW take's segments into the
// server blob of the OLD one. But upFile belongs to the net task (it may be
// blocked inside a chunk POST when the UI's bounded wait expires), so the UI
// only REQUESTS the drop; uploadStep() honours it at the top of its next pass,
// before touching any file.
static bool     upDropReq = false;
static char     upDropPid[24] = "";
static uint32_t upDropNum = 0;

// ---- per-session strikes -----------------------------------------------------
// The sweep used to always take pendTable[0]. One session that could not upload
// (missing/zero-length source, or a server that keeps failing it) blocked every
// other pending session forever - 8 recordings queued, none moving. Each session
// now carries its own strike count; at UPLOAD_MAX_STRIKES it is PARKED and the
// sweep moves on to the next one. Parking is temporary: a parked session is tried
// again after UPLOAD_PARK_RETRY_MS, and go-online / sync_now clears all parks, so
// a transient failure still drains - it just stops holding the queue hostage.
struct UploadStrike {
  char     pid[20];
  uint32_t num;
  int      strikes;
  uint32_t retryAt;
};
static const int     UP_STRIKE_MAX = 32;
static UploadStrike *upStrikes = nullptr;   // PSRAM (connInit); net-task only
static int           upStrikeCount = 0;
static const int      UPLOAD_MAX_STRIKES   = 3;
static const uint32_t UPLOAD_PARK_RETRY_MS = 300000; // 5 min

static UploadStrike *strikeFind(const char *pid, uint32_t num)
{
  for (int i = 0; i < upStrikeCount; i++)
    if (upStrikes[i].num == num && !strcmp(upStrikes[i].pid, pid)) return &upStrikes[i];
  return nullptr;
}

// Count one failure against a session. Returns true once it is parked.
static bool strikeAdd(const char *pid, uint32_t num)
{
  if (!upStrikes) return false;
  UploadStrike *s = strikeFind(pid, num);
  if (!s) {
    if (upStrikeCount >= UP_STRIKE_MAX) {
      // Table full: drop the oldest entry rather than stop tracking new failures.
      memmove(&upStrikes[0], &upStrikes[1], sizeof(upStrikes[0]) * (upStrikeCount - 1));
      upStrikeCount--;
    }
    s = &upStrikes[upStrikeCount++];
    snprintf(s->pid, sizeof(s->pid), "%s", pid);
    s->num = num;
    s->strikes = 0;
  }
  s->strikes++;
  s->retryAt = millis() + UPLOAD_PARK_RETRY_MS;
  return s->strikes >= UPLOAD_MAX_STRIKES;
}

static void strikeClear(const char *pid, uint32_t num)
{
  for (int i = 0; i < upStrikeCount; i++) {
    if (upStrikes[i].num == num && !strcmp(upStrikes[i].pid, pid)) {
      memmove(&upStrikes[i], &upStrikes[i + 1], sizeof(upStrikes[0]) * (upStrikeCount - i - 1));
      upStrikeCount--;
      return;
    }
  }
}

// Wipe every park. Called when the situation genuinely changed (just came online,
// user pressed sync) so a backlog parked by an old outage retries immediately.
static void strikeClearAll() { upStrikeCount = 0; }

// Park a session IMMEDIATELY (skip the 3-strike ramp). Used when retrying right
// away cannot help - e.g. the card refused the .synced marker write, so every
// retry would re-upload the whole session and fail the marker again.
static void strikePark(const char *pid, uint32_t num)
{
  strikeAdd(pid, num);                    // ensures the entry exists
  UploadStrike *s = strikeFind(pid, num);
  if (s) {
    s->strikes = UPLOAD_MAX_STRIKES;
    s->retryAt = millis() + UPLOAD_PARK_RETRY_MS;
  }
}

// A session is skippable only while parked AND inside its retry cooldown.
static bool strikeParked(const char *pid, uint32_t num, uint32_t now)
{
  UploadStrike *s = strikeFind(pid, num);
  if (!s || s->strikes < UPLOAD_MAX_STRIKES) return false;
  if ((int32_t)(now - s->retryAt) >= 0) {   // cooldown elapsed - give it another go
    s->strikes = 0;
    return false;
  }
  return true;
}

static bool beginUpload(const PendingEntry &pe)
{
  if (WiFi.status() != WL_CONNECTED) return false;

  uint32_t sessionNumber = pe.num, sampleRate = 16000;
  long     peakAbs = -1;     // capture's peak |sample|; -1 = older JSON, omit
  char flagsCsv[300] = "";   // "12000,45000,..." flag offsets (ms) for the query
  char jsonPath[160];
  sessionPath(jsonPath, sizeof(jsonPath), pe.patientId, pe.num, "json");
  File jf = SD_MMC.open(jsonPath, FILE_READ);
  if (jf) {
    JsonDocument meta(&s_jsonPsram);
    if (deserializeJson(meta, jf) == DeserializationError::Ok) {
      // pe.num IS the session's identity: writeSyncMarker/verifySessionStored
      // key off the local slot, so the upload must too. Never prefer the JSON's
      // session_number - a card renumbered by an older firmware can hold a
      // stale value there, and uploading under it desyncs marker/verify/server.
      sampleRate    = meta["sample_rate"] | 16000;
      peakAbs       = meta["peak_abs"] | -1L;   // dead-mic telltale for the server
      // FLAG-button marks, forwarded so the web report can show them. Capped to
      // what fits the query buffer; extras are dropped rather than overflow.
      JsonArrayConst fa = meta["flags_ms"].as<JsonArrayConst>();
      size_t fl = 0;
      for (JsonVariantConst v : fa) {
        char one[12];
        int n = snprintf(one, sizeof(one), fl ? ",%lu" : "%lu",
                         (unsigned long)(v.as<uint32_t>()));
        if (fl + n >= sizeof(flagsCsv)) break;
        memcpy(flagsCsv + fl, one, n);
        fl += n;
        flagsCsv[fl] = '\0';
      }
    }
    jf.close();
  }

  // Figure out the source list: a legacy merged .wav, or N segment files.
  char wavPath[160], pp[200];
  sessionPath(wavPath, sizeof(wavPath), pe.patientId, pe.num, "wav");
  upTotal = 0;
  if (SD_MMC.exists(wavPath)) {
    upLegacy = true;
    upLastSrc = 0;
    File f = SD_MMC.open(wavPath, FILE_READ);
    if (!f) return false;
    upTotal = f.size();
    f.close();
  } else {
    upLegacy = false;
    int cnt = 0;
    int lastData = -1;   // last segment that actually carries audio
    for (int k = 0;; k++) {
      sessionPartFile(pp, sizeof(pp), pe.patientId, pe.num, k);
      if (!SD_MMC.exists(pp)) break;
      File f = SD_MMC.open(pp, FILE_READ);
      size_t sz = f ? f.size() : 0;
      if (f) f.close();
      size_t logical = (k == 0) ? sz : ((sz > 44) ? sz - 44 : 0); // part0 keeps header
      upTotal += logical;
      if (logical > 0) lastData = k;
      cnt++;
    }
    // upLastSrc MUST be the last segment with data, not simply the last file on
    // disk. Stopping a take exactly on a minute boundary leaves a trailing 44-byte
    // header-only segment; when that was upLastSrc, its slice had len==0, so the
    // final=1 request was never sent - yet uploadStep still reached the "done"
    // branch and wrote the .synced marker. The session was marked synced while the
    // server had only unassembled parts and no session row at all.
    if (cnt == 0 || lastData < 0) return false;
    upLastSrc = lastData;
  }
  if (upTotal == 0) return false;

  // host:port from cfgServer (e.g. "http://192.168.0.138:4000")
  const char *h = strstr(cfgServer, "://");
  h = h ? h + 3 : cfgServer;
  size_t i = 0;
  while (h[i] && h[i] != ':' && h[i] != '/' && i < sizeof(upHost) - 1) { upHost[i] = h[i]; i++; }
  upHost[i] = '\0';
  upPort = (h[i] == ':') ? atoi(h + i + 1)
                         : (strncmp(cfgServer, "https", 5) == 0 ? 443 : 80);

  // Path prefix from cfgServer after the host:port. The raw upload socket talks
  // to the host directly, so it must carry the full path - e.g. Supabase needs
  // "/functions/v1/device-api/api/sessions/chunk", while the mock-server has no
  // prefix and uses "/api/sessions/chunk".
  char prefix[80] = "";
  const char *slash = strchr(h + i, '/');
  if (slash) {
    snprintf(prefix, sizeof(prefix), "%s", slash);
    size_t pl = strlen(prefix);
    while (pl > 0 && prefix[pl - 1] == '/') prefix[--pl] = '\0'; // trim trailing /
  }

  // peak_abs rides along when the JSON carries it (fw with dead-mic detection):
  // a near-zero peak on a full-length take lets the dashboard flag a faulty mic
  // before the on-device audio is trimmed. Unknown params are ignored server-side.
  char peakParam[24] = "";
  if (peakAbs >= 0)
    snprintf(peakParam, sizeof(peakParam), "&peak=%ld", peakAbs);
  snprintf(upMetaQuery, sizeof(upMetaQuery),
           "%s/api/sessions/chunk?device_serial=%s&patient_id=%s"
           "&session_number=%lu&sample_rate=%lu%s%s%s",
           prefix, serialStr, pe.patientId,
           (unsigned long)sessionNumber, (unsigned long)sampleRate, peakParam,
           flagsCsv[0] ? "&flags=" : "", flagsCsv);
  snprintf(upPid, sizeof(upPid), "%s", pe.patientId);
  upNum = pe.num;
  upSrcIdx = 0;
  upHasFile = false;
  upServerOffset = 0;
  upOpenAtPos = 0;
  upRetries = 0;
  upFinalAcked = false;

  // Resume: the server already holds upResumeOffset bytes of THIS session, so map
  // that logical offset back onto (segment index, position inside it) and carry on
  // from there. Legacy single-wav sessions map 1:1; segment sessions must account
  // for the 44-byte header that every part>0 contributes to the file but NOT to the
  // logical stream. Anything inconsistent (offset past the end) falls back to 0.
  if (upResumeMatches(pe.patientId, pe.num) && upResumeOffset < upTotal) {
    size_t want = upResumeOffset, seen = 0;
    int k = 0;
    bool mapped = false;
    for (;; k++) {
      size_t logical;
      if (upLegacy) {
        logical = upTotal;
      } else {
        sessionPartFile(pp, sizeof(pp), pe.patientId, pe.num, k);
        if (!SD_MMC.exists(pp)) break;
        File f = SD_MMC.open(pp, FILE_READ);
        size_t sz = f ? f.size() : 0;
        if (f) f.close();
        logical = (k == 0) ? sz : ((sz > 44) ? sz - 44 : 0);
      }
      if (want < seen + logical) {          // the offset lands inside this source
        upSrcIdx    = k;
        upOpenAtPos = want - seen;
        upServerOffset = upResumeOffset;
        mapped = true;
        break;
      }
      seen += logical;
      if (upLegacy) break;
    }
    if (mapped) {
      Serial.printf("[CONN] resume %s session %lu at %u/%u\n", pe.patientId,
                    (unsigned long)pe.num, (unsigned)upServerOffset, (unsigned)upTotal);
    } else {
      upSrcIdx = 0;
      upOpenAtPos = 0;
      upServerOffset = 0;
    }
  }

  upActive = true;
  upStartMs = millis();
  setStatus("Uploading session to SATE...");
  sateHookUploadBegin();
  return true;
}

static void uploadStep()
{
  if (!upActive) return;

  // A delete on the UI core targeted the session we are streaming: its files
  // are gone (or going), so abandon the transfer before touching any of them.
  if (upDropReq) {
    upDropReq = false;
    if (upNum == upDropNum && !strcmp(upPid, upDropPid)) {
      if (upHasFile) { upFile.close(); upHasFile = false; }
      upActive = false;
      upFinalAcked = false;
      // Also drop a resume point for the deleted session: the uiSdBusy abort
      // path can have saved one AFTER connNotifySessionDeleted() cleared it,
      // and a stale offset must never be applied to a take that reuses the
      // number - starting that upload from 0 makes the server truncate its
      // stale temp blob instead of splicing onto it.
      if (upResumeNum == upDropNum && !strcmp(upResumePid, upDropPid))
        upResumeClear();
      sateHookUploadEnd();
      setStatus("Online (Wi-Fi) - %s", ipText);
      Serial.printf("[CONN] upload dropped - %s session %lu was deleted\n",
                    upPid, (unsigned long)upNum);
      return;
    }
  }

  // Open the current source segment if needed.
  if (!upHasFile) {
    char path[200];
    if (upLegacy) sessionPath(path, sizeof(path), upPid, upNum, "wav");
    else          sessionPartFile(path, sizeof(path), upPid, upNum, upSrcIdx);
    upFile = SD_MMC.open(path, FILE_READ);
    if (!upFile) {
      // Source vanished mid-session. Strike it so the sweep moves on to the other
      // pending sessions instead of retrying this one forever.
      upActive = false;
      strikeAdd(upPid, upNum);
      upResumeClearIf(upPid, upNum);
      sateHookUploadEnd();
      setStatus("Online (Wi-Fi) - %s", ipText);
      Serial.printf("[CONN] upload: cannot open %s\n", path);
      return;
    }
    size_t fsz = upFile.size();
    upSrcBase = (upLegacy || upSrcIdx == 0) ? 0 : 44; // part>0: skip its WAV header
    upSrcLen  = (fsz > upSrcBase) ? fsz - upSrcBase : 0;
    upSrcPos  = upOpenAtPos;     // 0 normally; >0 when resuming into this segment
    if (upSrcPos > upSrcLen) upSrcPos = upSrcLen;
    upOpenAtPos = 0;
    upHasFile = true;
  }

  size_t len = upSrcLen - upSrcPos;
  if (len > UPLOAD_CHUNK_BYTES) len = UPLOAD_CHUNK_BYTES;
  bool lastOfSrc = (upSrcPos + len >= upSrcLen);
  bool isFinal   = (upSrcIdx == upLastSrc && lastOfSrc);
  size_t fileSeek = upSrcBase + upSrcPos;

  if (len > 0) {
    int code = sendSessionChunk(upHost, upPort, upMetaQuery, upServerOffset,
                                fileSeek, len, isFinal, upTotal, upFile);
    bool ok = code >= 200 && code < 300;
    if (!ok) {
      // 409 = the server's temp blob doesn't line up with our offset (e.g. it was
      // truncated by an older firmware's restart). That is the ONLY case where
      // starting over is right; drop the resume point so the next pass sends from 0.
      if (code == 409) {
        if (upHasFile) { upFile.close(); upHasFile = false; }
        upActive = false;
        upResumeClearIf(upPid, upNum);
        // Strike it too: a restart-from-0 should succeed, so a session that keeps
        // 409ing is broken and must not spin here while others wait.
        strikeAdd(upPid, upNum);
        sateHookUploadEnd();
        setStatus("Online (Wi-Fi) - %s", ipText);
        Serial.printf("[CONN] upload %s session %lu: offset gap at %u, restarting\n",
                      upPid, (unsigned long)upNum, (unsigned)upServerOffset);
        return;
      }
      if (++upRetries >= 4) {
        if (upHasFile) { upFile.close(); upHasFile = false; }
        upActive = false;
        // Keep the resume point: the next attempt continues from here instead of
        // re-sending the whole session (which also made the server truncate).
        upResumeSave(upPid, upNum, upServerOffset);
        bool parked = strikeAdd(upPid, upNum);
        sateHookUploadEnd();
        // Status used to stay "Uploading session to SATE..." forever after a stall,
        // so the screen claimed progress that wasn't happening.
        setStatus("Online (Wi-Fi) - %s", ipText);
        Serial.printf("[CONN] upload stalled at %u/%u (http %d)%s\n",
                      (unsigned)upServerOffset, (unsigned)upTotal, code,
                      parked ? ", parked - other sessions first" : ", will retry");
      }
      return;
    }
    if (isFinal) upFinalAcked = true;   // server assembled + stored the session
  }

  // Slice sent (or empty source) - advance.
  upServerOffset += len;
  upSrcPos += len;
  upRetries = 0;
  if (upTotal) sateHookUploadProgress((int)((uint64_t)upServerOffset * 100 / upTotal));

  if (lastOfSrc) {
    upFile.close();
    upHasFile = false;
    if (upSrcIdx >= upLastSrc) {
      if (!upFinalAcked) {
        // Walked off the end without the server ever acking final=1. Do NOT mark
        // this synced - the server has no session row for it. Retry it later.
        upActive = false;
        upResumeSave(upPid, upNum, upServerOffset);
        strikeAdd(upPid, upNum);
        sateHookUploadEnd();
        setStatus("Online (Wi-Fi) - %s", ipText);
        Serial.printf("[CONN] %s session %lu ended without a final ack - not synced\n",
                      upPid, (unsigned long)upNum);
        return;
      }
      if (!writeSyncMarker(upPid, upNum)) {
        // The server HAS the audio but the card refused the marker (read-only /
        // dying card). Without a marker the sweep would re-upload this session
        // forever and starve everything queued behind it: park it hard so the
        // rest of the backlog drains, do NOT strikeClear, and do NOT trim -
        // connSdFault() now reports the card so the UI shows "SD card error".
        // A later successful marker write (or resync) clears the fault.
        upActive = false;
        strikePark(upPid, upNum);
        sateHookUploadEnd();
        setStatus("SD card not writable - check the card");
        Serial.printf("[CONN] %s session %lu uploaded but the sync marker FAILED - parked (SD not writable)\n",
                      upPid, (unsigned long)upNum);
        return;
      }
      // Reclaim SD: this take is now durably on the server, so free the audio of
      // SYNCED takes older than the newest KEEP_AUDIO_SESSIONS (the marker stays as
      // a tombstone; unsynced takes are never touched). The just-synced take is the
      // newest, so it is always kept. Full deletion remains user-only.
      //
      // upActive MUST stay true across writeSyncMarker + trimPatientSyncedAudio -
      // both mutate this patient's dir on the card, and the UI's delete guard waits
      // on connNetSdIdle() (netSdBusy || upActive). If we cleared it before the
      // trim (as this used to), a delete tapped during trim's verify network call
      // could race trim's own walk of this patient dir. Keep the flag up until the
      // whole SD-reclaim tail is done.
      trimPatientSyncedAudio(upPid);
      strikeClear(upPid, upNum);
      upResumeClearIf(upPid, upNum);
      upActive = false;
      sateHookUploadEnd();
      Serial.printf("[CONN] uploaded %s session %lu (%u bytes) in %lu ms\n",
                    upPid, (unsigned long)upNum, (unsigned)upServerOffset,
                    (unsigned long)(millis() - upStartMs));
      setStatus("Online (Wi-Fi) - %s", ipText);
    } else {
      upSrcIdx++; // next segment opens on the next pass
    }
  }
}

static void fetchPatients()
{
  // PSRAM + static pointer: off the shared loop-task stack (connLoop is
  // single-threaded) AND off the internal heap the TLS handshake needs.
  static char *resp = (char *)psAlloc(2048);
  const size_t RESP_MAX = 2048;
  if (!resp) return;
  if (!httpJson("GET", "/api/patients", nullptr, resp, RESP_MAX, nullptr)) return;
  File f = SD_MMC.open("/sate/patients.json", FILE_WRITE);
  if (f) {
    f.print(resp);
    f.close();
    pendDirty = true; // roster changed - new patient dirs may hold sessions
    sateHookPatientsUpdated();
  }
}

// =============================================================================
// mode transitions
// =============================================================================

static void enterBleMode()
{
  mode = CONN_BLE_ADV;
  ipText[0] = '\0';
  nextWifiRetry = millis() + WIFI_RETRY_PERIOD_MS;
  nextAdvRefresh = millis() + ADV_REFRESH_PERIOD_MS;
  bleStart();
  setStatus(provisioned ? "Bluetooth on - waiting for app"
                        : "Ready for setup - open the SATE app");
}

// Force the radio to full transmit power. The ESP32-S3 can come up at a reduced
// default, which hurts association at range / under BLE coexistence ("out of
// range" even with the right password). Safe to call on every STA bring-up.
static void wifiMaxTxPower()
{
  WiFi.setTxPower(WIFI_POWER_19_5dBm);            // Arduino wrapper (max enum)
  esp_wifi_set_max_tx_power(80);                  // 80 = 20 dBm (0.25 dBm units)
}

static void enterWifiTrying()
{
  mode = CONN_WIFI_TRYING;
  WiFi.mode(WIFI_STA);
  wifiMaxTxPower();
  WiFi.begin(cfgSsid, cfgPass);
  wifiDeadline = millis() + WIFI_BOOT_TIMEOUT_MS;
  setStatus("Connecting to Wi-Fi \"%s\"...", cfgSsid);
}

static void enterWifiOnline()
{
  mode = CONN_WIFI_ONLINE;
  wifiChangeMode = false;  // back online: any pending Change-Wi-Fi window is over
  WiFi.setSleep(false);    // keep the radio fully awake online too - steadier polls
                           // + uploads (USB-powered, so power cost is irrelevant)
  bleStop(); // Wi-Fi mode does not advertise; frees NimBLE RAM
  g_wantNetTask = true;    // online now -> loop() will spin up the core-0 net task
  nextHeartbeat = 0;       // scan pending immediately
  nextCmdPoll = 0;         // and poll commands immediately
  uploadSweepDue = true;   // push pending sessions right away
  strikeClearAll();        // fresh link: retry anything parked by the last outage
  patientsFetchDue = true; // pull the latest patient list
  snprintf(ipText, sizeof(ipText), "%s", WiFi.localIP().toString().c_str());
  setStatus("Online (Wi-Fi) - %s", ipText);
}

// =============================================================================
// BLE op handling (runs in connLoop)
// =============================================================================

// 44-byte canonical WAV header for the assembled stream (16 kHz mono S16LE -
// the only format the capture writes). Matches the .ino's writeWavHeader().
static void buildWavHeader(uint8_t *h, uint32_t pcmBytes)
{
  const uint32_t sampleRate = 16000, byteRate = 32000, fmtSize = 16;
  const uint16_t audioFormat = 1, channels = 1, blockAlign = 2, bits = 16;
  uint32_t riffSize = 36 + pcmBytes;
  memcpy(h + 0,  "RIFF", 4); memcpy(h + 4,  &riffSize, 4);
  memcpy(h + 8,  "WAVE", 4); memcpy(h + 12, "fmt ", 4);
  memcpy(h + 16, &fmtSize, 4);    memcpy(h + 20, &audioFormat, 2);
  memcpy(h + 22, &channels, 2);   memcpy(h + 24, &sampleRate, 4);
  memcpy(h + 28, &byteRate, 4);   memcpy(h + 32, &blockAlign, 2);
  memcpy(h + 34, &bits, 2);       memcpy(h + 36, "data", 4);
  memcpy(h + 40, &pcmBytes, 4);
}

static void sendSessionOverBle(int tableIdx)
{
  const PendingEntry &pe = pendTable[tableIdx];
  char wavPath[160], jsonPath[160], pp[200];
  sessionPath(wavPath, sizeof(wavPath), pe.patientId, pe.num, "wav");
  sessionPath(jsonPath, sizeof(jsonPath), pe.patientId, pe.num, "json");

  // This firmware stores a take as 1-minute part files and NEVER merges them,
  // so the bridge must assemble the WAV the way the uploader does: one header
  // for the whole take, then every part's PCM. Opening only the merged
  // session_NNNN.wav (a legacy-firmware artifact) made every BLE session pull
  // fail "session not found" - the offline backup path was dead.
  // Legacy merged .wav wins when present - same precedence as beginUpload()
  // and sessionAssembledBytes(), so `total` and the stream always agree.
  bool segmented = false;
  uint32_t total = 0;
  if (SD_MMC.exists(wavPath)) {
    File wf = SD_MMC.open(wavPath, FILE_READ);
    if (wf) { total = (uint32_t)wf.size(); wf.close(); }
  } else {
    sessionPartFile(pp, sizeof(pp), pe.patientId, pe.num, 0);
    segmented = SD_MMC.exists(pp);
    if (segmented) total = sessionAssembledBytes(pe.patientId, pe.num);
  }
  if (total == 0) {
    statusErr("send_session", "session not found");
    return;
  }

  // meta = raw contents of the metadata json (or a minimal fallback).
  // Static PSRAM pointers: connLoop is single-threaded, so this keeps ~2.2 KB
  // off both the loop-task stack and the internal heap/.bss.
  const size_t META_MAX = 1024, HEAD_MAX = 1200;
  static char *meta = (char *)psAlloc(META_MAX);
  static char *head = (char *)psAlloc(HEAD_MAX);
  if (!meta || !head) { statusErr("send_session", "no memory"); return; }
  meta[0] = '{'; meta[1] = '}'; meta[2] = '\0';
  File jf = SD_MMC.open(jsonPath, FILE_READ);
  if (jf) {
    size_t m = jf.read((uint8_t *)meta, META_MAX - 1);
    meta[m] = '\0';
    jf.close();
  }

  setStatus("Sending session to app (Bluetooth)...");
  int n = tableIdx + 1;
  snprintf(head, HEAD_MAX, "{\"ev\":\"file\",\"n\":%d,\"bytes\":%lu,\"meta\":%s}",
           n, (unsigned long)total, meta);
  statusNotify(head);

  // Stream the WAV: each 4 KB block is one framed message on CHAR_DATA; the
  // app concatenates the blocks and rebuilds the file. `sent` counts every
  // byte actually notified so a dropped packet / lost link can never end in a
  // file_done claim over a truncated WAV.
  uint32_t sent = 0;
  bool txOk = true;
  if (segmented) {
    // One assembled header (sized for ALL the PCM), then each part's PCM with
    // its own per-part header skipped - byte count matches
    // sessionAssembledBytes(): part0 contributes header+PCM, later parts PCM.
    uint8_t hdr[44];
    buildWavHeader(hdr, total > 44 ? total - 44 : 0);
    txOk = notifyFramed(chData, hdr, sizeof(hdr));
    if (txOk) sent += sizeof(hdr);
    for (int k = 0; txOk && bleClientConnected; k++) {
      sessionPartFile(pp, sizeof(pp), pe.patientId, pe.num, k);
      if (!SD_MMC.exists(pp)) break;
      File f = SD_MMC.open(pp, FILE_READ);
      if (!f) { txOk = false; break; }
      if (f.size() > 44) {
        f.seek(44);
        while (f.available() && bleClientConnected) {
          size_t got = f.read(ioChunk, sizeof(ioChunk));
          if (!got) break;
          if (!notifyFramed(chData, ioChunk, got)) { txOk = false; break; }
          sent += got;
        }
      }
      f.close();
    }
  } else {
    File wf = SD_MMC.open(wavPath, FILE_READ);
    if (!wf) {
      statusErr("send_session", "session not found");
      return;
    }
    while (wf.available() && bleClientConnected) {
      size_t got = wf.read(ioChunk, sizeof(ioChunk));
      if (!got) break;
      if (!notifyFramed(chData, ioChunk, got)) { txOk = false; break; }
      sent += got;
    }
    wf.close();
  }

  // file_done is a completion CLAIM: only make it when every advertised byte
  // was notified, so the app never files a partial transfer as the take.
  if (txOk && bleClientConnected && sent == total) {
    char done[48];
    snprintf(done, sizeof(done), "{\"ev\":\"file_done\",\"n\":%d}", n);
    statusNotify(done);
  } else {
    Serial.printf("[CONN] send_session aborted at %lu/%lu bytes\n",
                  (unsigned long)sent, (unsigned long)total);
    statusErr("send_session", "transfer interrupted");
  }
  setStatus("App connected (Bluetooth)");
}

static void handleProvisionTick()
{
  if (provState == PROV_WIFI) {
    wl_status_t st = WiFi.status();
    if (st == WL_CONNECTED) {
      char j[96];
      snprintf(j, sizeof(j), "{\"ev\":\"state\",\"state\":\"wifi_ok\",\"ip\":\"%s\"}",
               WiFi.localIP().toString().c_str());
      statusNotify(j);
      snprintf(ipText, sizeof(ipText), "%s", WiFi.localIP().toString().c_str());
      if (provWifiOnly) {
        // Change-Wi-Fi: the device is ALREADY claimed. Persist the new creds
        // against the existing account/key and go straight online - no register.
        snprintf(cfgSsid, sizeof(cfgSsid), "%s", provSsid);
        snprintf(cfgPass, sizeof(cfgPass), "%s", provPass);
        saveConfig();
        statusNotify("{\"ev\":\"state\",\"state\":\"wifi_saved\"}");
        setStatus("Wi-Fi updated - %s", ipText);
        esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
        provWifiOnly   = false;
        wifiChangeMode = false;
        provState      = PROV_IDLE;
        return;
      }
      statusNotify("{\"ev\":\"state\",\"state\":\"registering\"}");
      setStatus("Wi-Fi connected - registering with SATE...");
      regAttempts = 0;
      regNextTry  = 0;
      provState = PROV_REGISTER;
      return;
    }
    // Fast fail when the SSID simply is not on air - no point waiting 28 s.
    if (st == WL_NO_SSID_AVAIL) {
      statusNotify("{\"ev\":\"state\",\"state\":\"error\",\"msg\":\"Network not found - check the Wi-Fi name\"}");
      WiFi.disconnect(true);
      esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
      setStatus("Network not found");
      provWifiOnly = false;
      provState = PROV_IDLE;
      return;
    }
    // 3+ auth/handshake failures = the passphrase is wrong; no point burning
    // the rest of the 28 s window (a single one can be a coexistence flake).
    if (wifiDiscCount >= 3 && reasonLooksLikeBadPassword(lastWifiReason)) {
      char j[160];
      snprintf(j, sizeof(j),
               "{\"ev\":\"state\",\"state\":\"error\",\"msg\":\"Wrong Wi-Fi password (reason %d)\"}",
               lastWifiReason);
      statusNotify(j);
      WiFi.disconnect(true);
      esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
      setStatus("Wrong Wi-Fi password");
      provWifiOnly = false;
      provState = PROV_IDLE;
      return;
    }
    // Re-issue begin() periodically: under BLE coexistence the first (or second)
    // association attempt is often swallowed even with a correct password, so keep
    // retrying across the whole window instead of giving up after one re-begin.
    if (timeAfter(millis(), provRetryAt)) {
      provRetryAt = millis() + WIFI_PROV_RETRY_MS;
      Serial.println("[CONN] Wi-Fi stalled - retrying begin()");
      WiFi.setSleep(false);          // no modem sleep: don't miss beacons mid-handshake
      WiFi.disconnect(false);
      WiFi.begin(provSsid, provPass);
    }
    if (timeAfter(millis(), provDeadline)) {
      char j[176];
      const char *hint = lastWifiReason == 0
          ? "no response from router - is it 2.4 GHz?"
          : (reasonLooksLikeBadPassword(lastWifiReason) ? "wrong password"
                                                        : "weak signal or out of range");
      snprintf(j, sizeof(j),
               "{\"ev\":\"state\",\"state\":\"error\",\"msg\":\"Wi-Fi failed - %s (reason %d)\"}",
               hint, lastWifiReason);
      statusNotify(j);
      WiFi.disconnect(true);
      esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
      setStatus("Wi-Fi failed - check password");
      provWifiOnly = false;
      provState = PROV_IDLE;
    }
    return;
  }

  if (provState == PROV_REGISTER) {
    // Provisioning runs on the MAIN loop (the net task isn't started until the device
    // goes online - see connStartNetTask / loop()), so the heap here matches the old
    // single-core SATE_Up: plenty of contiguous RAM for the TLS handshake while BLE
    // stays connected. No BLE teardown needed - the app gets "registered" over its
    // live link. A couple of retries cover a transient coexistence hiccup.
    if (!timeAfter(millis(), regNextTry)) return;   // brief backoff between attempts

    char body[256];
    snprintf(body, sizeof(body), "{\"serial\":\"%s\",\"claim_token\":\"%s\",\"fw\":\"%s\"}",
             serialStr, provClaim, fwVersion);
    // register before we have a device key; server allows this route unauthenticated
    char url[192];
    snprintf(url, sizeof(url), "%s/api/devices/register", provServer);
    WiFiClient plain;
    WiFiClientSecure tls;
    bool useTls = strstr(provServer, "supabase.co") != nullptr;
    if (useTls) {
      tls.setInsecure();
      tls.setHandshakeTimeout(5);   // fail a stalled handshake fast so we retry sooner
    }
    WiFiClient &client = useTls ? static_cast<WiFiClient &>(tls) : plain;
    HTTPClient http;
    http.setConnectTimeout(6000);
    http.setTimeout(8000);
    int  code = 0;
    bool ok = false;
    if (http.begin(client, url)) {
      http.addHeader("Content-Type", "application/json");
      if (useTls) http.addHeader("apikey", SUPABASE_ANON_KEY);
      code = http.POST((uint8_t *)body, strlen(body));
      Serial.printf("[CONN] register attempt %d code=%d freeHeap=%u maxAlloc=%u\n",
                    regAttempts + 1, code, (unsigned)ESP.getFreeHeap(),
                    (unsigned)ESP.getMaxAllocHeap());
      if (code >= 200 && code < 300) {
        JsonDocument doc;
        if (deserializeJson(doc, http.getString()) == DeserializationError::Ok) {
          // A parseable 2xx is NOT success on its own: an error envelope or a
          // gateway-rewritten body can parse fine and carry no credentials.
          // Persisting an empty id/key would report "registered" while every
          // later call hits /api/devices//... unauthenticated, and the next
          // boot would silently drop back to setup with the day's takes unsynced.
          const char *did  = doc["device_id"]  | "";
          const char *dkey = doc["device_key"] | "";
          if (did[0] && dkey[0]) {
            snprintf(cfgSsid, sizeof(cfgSsid), "%s", provSsid);
            snprintf(cfgPass, sizeof(cfgPass), "%s", provPass);
            snprintf(cfgServer, sizeof(cfgServer), "%s", provServer);
            snprintf(cfgDeviceId, sizeof(cfgDeviceId), "%s", did);
            snprintf(cfgDeviceKey, sizeof(cfgDeviceKey), "%s", dkey);
            saveConfig();
            ok = true;
          } else {
            Serial.printf("[CONN] register 2xx but no device_id/key in body - treating as failure\n");
          }
        }
      }
      http.end();
    }

    if (ok) {
      char j[128];
      snprintf(j, sizeof(j), "{\"ev\":\"state\",\"state\":\"registered\",\"device_id\":\"%s\"}",
               cfgDeviceId);
      statusNotify(j);
      setStatus("Setup complete! Claimed to your account");
      esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
      provState = PROV_IDLE;   // stay in BLE until the app disconnects, then go online
      return;
    }

    // 4xx = bad claim token / account: retrying won't help, fail fast.
    if (code >= 400 && code < 500) {
      statusNotify("{\"ev\":\"state\",\"state\":\"error\","
                   "\"msg\":\"Setup link expired - sign out and back in, then retry\"}");
      setStatus("Registration rejected");
      esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
      provState = PROV_IDLE;
      return;
    }
    if (++regAttempts >= 5) {
      statusNotify("{\"ev\":\"state\",\"state\":\"error\","
                   "\"msg\":\"Couldn't reach SATE to finish setup - check Wi-Fi and try again\"}");
      setStatus("Server registration failed (code %d)", code);
      esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
      provState = PROV_IDLE;
      return;
    }
    regNextTry = millis() + 600;    // back off briefly, then retry (stay in REGISTER)
  }
}

static void handleBleOp(const char *json)
{
  JsonDocument doc(&s_jsonPsram);
  if (deserializeJson(doc, json) != DeserializationError::Ok) return;
  const char *op = doc["op"] | "";

  if (!strcmp(op, "scan_wifi")) {
    // Kick off a NON-blocking scan; connLoop() collects the result. A
    // synchronous WiFi.scanNetworks() can stall for many seconds while a BLE
    // connection is live, which blocks notifications and trips the app's
    // 20 s timeout.
    setStatus("Scanning Wi-Fi networks...");
    WiFi.mode(WIFI_STA);          // ensure the STA radio is up before scanning
    WiFi.scanDelete();            // clear any stale result
    // Under the default BALANCE coexistence a scan that runs while a BLE link is
    // live gets almost no radio airtime and reliably returns 0 APs. Give Wi-Fi
    // priority for the scan window; the result notification is sent AFTER the
    // scan finishes (see connLoop collector), by which point coex is restored to
    // BALANCE, so the live BLE link is never starved while it matters.
    esp_coex_preference_set(ESP_COEX_PREFER_WIFI);
    // Two things make a scan return 0 APs while a BLE link is live:
    //  1) modem power-save (the default) parks the Wi-Fi radio between beacons,
    //     so under coex the scan never gets an RX window -> disable sleep.
    //  2) an ACTIVE scan needs contended TX airtime to send probe requests; the
    //     BLE link starves those, so probes go nowhere. A PASSIVE scan only has
    //     to *hear* a beacon (APs send one ~every 100 ms), which survives coex.
    // ~300 ms/channel dwell catches a couple of beacons per channel even when
    // the radio is shared. 13 channels x ~300 ms ~= 4 s, well under the deadline.
    WiFi.setSleep(false);
    WiFi.scanNetworks(true /*async*/, false /*show_hidden*/, true /*passive*/, 300);
    scanInProgress = true;
    scanRetried = false;
    scanDeadline = millis() + WIFI_SCAN_ATTEMPT_MS;

  } else if (!strcmp(op, "provision")) {
    snprintf(provSsid, sizeof(provSsid), "%s", (const char *)(doc["ssid"] | ""));
    snprintf(provPass, sizeof(provPass), "%s", (const char *)(doc["pass"] | ""));
    snprintf(provServer, sizeof(provServer), "%s", (const char *)(doc["server"] | ""));
    snprintf(provClaim, sizeof(provClaim), "%s", (const char *)(doc["claim_token"] | ""));
    statusNotify("{\"ev\":\"state\",\"state\":\"connecting\"}");
    setStatus("Connecting to Wi-Fi \"%s\"...", provSsid);

    // A leftover async scan holds the radio and makes WiFi.begin() flaky under
    // BLE coexistence. WiFi.scanDelete() only frees a FINISHED result - it does
    // not abort a scan still in flight - so stop the scan at the IDF level.
    if (scanInProgress || WiFi.scanComplete() == WIFI_SCAN_RUNNING) {
      esp_wifi_scan_stop();
      WiFi.scanDelete();
      scanInProgress = false;
    }

    lastWifiReason = 0;
    wifiDiscCount  = 0;
    // The app keeps the BLE link open during provisioning to watch progress, so
    // BLE and Wi-Fi share the one 2.4 GHz radio. Under the default BALANCE coex
    // a correct password can still fail the 4-way handshake (reported as
    // AUTH_FAIL / HANDSHAKE_TIMEOUT - looks just like a wrong password). Give
    // Wi-Fi priority of the radio for the connect window; restored on exit.
    esp_coex_preference_set(ESP_COEX_PREFER_WIFI);
    WiFi.persistent(false);          // creds are saved by us in NVS, not the core
    WiFi.setAutoReconnect(true);
    WiFi.mode(WIFI_STA);
    wifiMaxTxPower();                 // full TX power - helps association under BLE coex
    WiFi.setSleep(false);            // no modem sleep during the BLE-open connect:
                                     // stops beacon misses that fail a valid join
    WiFi.disconnect(false);          // clear any half-open association
    WiFi.begin(provSsid, provPass);
    provDeadline = millis() + WIFI_PROV_TIMEOUT_MS;
    provRetryAt  = millis() + WIFI_PROV_RETRY_MS;
    provRetried  = false;
    provWifiOnly = false;          // full provision: WiFi connect THEN register
    provState = PROV_WIFI;

  } else if (!strcmp(op, "change_wifi")) {
    // Move the recorder to a new Wi-Fi network WITHOUT re-registering: it keeps
    // its account, server, and device key. The SLP uses this instead of a
    // factory reset when the clinic Wi-Fi changes. Only valid once claimed.
    if (!provisioned) { statusErr("change_wifi", "device not set up yet"); return; }
    snprintf(provSsid, sizeof(provSsid), "%s", (const char *)(doc["ssid"] | ""));
    snprintf(provPass, sizeof(provPass), "%s", (const char *)(doc["pass"] | ""));
    statusNotify("{\"ev\":\"state\",\"state\":\"connecting\"}");
    setStatus("Connecting to Wi-Fi \"%s\"...", provSsid);

    if (scanInProgress || WiFi.scanComplete() == WIFI_SCAN_RUNNING) {
      esp_wifi_scan_stop();
      WiFi.scanDelete();
      scanInProgress = false;
    }
    lastWifiReason = 0;
    wifiDiscCount  = 0;
    esp_coex_preference_set(ESP_COEX_PREFER_WIFI);
    WiFi.persistent(false);
    WiFi.setAutoReconnect(true);
    WiFi.mode(WIFI_STA);
    wifiMaxTxPower();                 // full TX power - helps association under BLE coex
    WiFi.setSleep(false);            // no modem sleep during the BLE-open connect
    WiFi.disconnect(false);
    WiFi.begin(provSsid, provPass);
    provDeadline = millis() + WIFI_PROV_TIMEOUT_MS;
    provRetryAt  = millis() + WIFI_PROV_RETRY_MS;
    provRetried  = false;
    provWifiOnly = true;           // connect THEN persist creds, skip register
    provState = PROV_WIFI;

  } else if (!strcmp(op, "cancel_wifi")) {
    // App backed out of Change-Wi-Fi without updating. Leave change-mode right
    // away (don't wait for the timeout) so the recorder resumes normal Wi-Fi and
    // its screen returns to the main page.
    wifiChangeMode = false;
    if (provWifiOnly) { provWifiOnly = false; provState = PROV_IDLE; }
    statusOk("cancel_wifi");

  } else if (!strcmp(op, "list_sessions")) {
    scanPending();
    char out[2048];
    size_t o = snprintf(out, sizeof(out), "{\"ev\":\"sessions\",\"items\":[");
    for (int i = 0; i < pendCount; i++) {
      o += snprintf(out + o, sizeof(out) - o, "%s{\"n\":%d,\"patient_id\":\"%s\",\"bytes\":%lu}",
                    i ? "," : "", i + 1, pendTable[i].patientId,
                    (unsigned long)pendTable[i].bytes);
      if (o > sizeof(out) - 96) break;
    }
    o += snprintf(out + o, sizeof(out) - o, "]}");
    statusNotify(out);

  } else if (!strcmp(op, "send_session")) {
    int n = doc["n"] | 0;
    if (n >= 1 && n <= pendCount) sendSessionOverBle(n - 1);
    else statusErr("send_session", "unknown session");

  } else if (!strcmp(op, "mark_synced")) {
    // Resolve the session by IDENTITY (patient_id + session number), never by a
    // bare table position: the app may send an index from a list that a
    // device-side delete has since invalidated, and a marker written on the
    // wrong slot silently drops a real recording from the pending set forever.
    // Newer apps can pass patient_id/session explicitly; the legacy `n` is
    // still accepted but is re-validated against the card before marking.
    const char *xpid = doc["patient_id"] | "";
    uint32_t    xnum = doc["session"] | 0;
    int n = doc["n"] | 0;
    if (!(xpid[0] && xnum) && n >= 1 && n <= pendCount) {
      xpid = pendTable[n - 1].patientId;
      xnum = pendTable[n - 1].num;
    }
    if (!(xpid[0] && xnum)) {
      statusErr("mark_synced", "unknown session");
    } else if (!sessionHasAudioLocal(xpid, xnum)) {
      // Stale entry: the session was deleted (or already trimmed) after the app
      // listed it. Marking now would tombstone an empty/reused slot.
      statusErr("mark_synced", "session gone");
    } else if (writeSyncMarker(xpid, xnum)) {
      statusOk("mark_synced");
      sateHookConnChanged();
    } else {
      statusErr("mark_synced", "SD write failed");
    }

  } else if (!strcmp(op, "set_patients")) {
    JsonArray arr = doc["patients"].as<JsonArray>();
    if (!arr.isNull()) {
      File f = SD_MMC.open("/sate/patients.json", FILE_WRITE);
      if (f) {
        serializeJson(arr, f);
        f.close();
        statusOk("set_patients");
        sateHookPatientsUpdated();
      } else {
        statusErr("set_patients", "SD write failed");
      }
    } else {
      statusErr("set_patients", "bad payload");
    }

  } else if (!strcmp(op, "reboot")) {
    statusOk("reboot");
    rebootRequested = true;
    rebootAtMs = millis() + 800; // give the ack time to reach the app
  } else if (!strcmp(op, "factory_reset")) {
    // Unlinked from the account over BLE (e.g. an off-Wi-Fi recorder the server
    // can't reach). Wipe Wi-Fi + account and reboot to first-time setup, same as
    // the server-driven `unclaimed` path. Deferred so the ack reaches the app.
    statusOk("factory_reset");
    factoryResetRequested = true;
    factoryResetAtMs = millis() + 800;
  }
}

// =============================================================================
// Wi-Fi online servicing
// =============================================================================

static void runRemoteCommand(const char *op)
{
  Serial.printf("[CONN] remote command: %s\n", op);
  if (!strcmp(op, "sync_now")) {
    uploadSweepDue = true;
    strikeClearAll();   // an explicit sync means "try everything again, now"
  } else if (!strcmp(op, "resync_all")) {
    // Full re-backup: re-send every session whose audio is still on the card,
    // including ones already marked synced. Recovers sessions the server
    // acknowledged but never actually stored.
    resyncAll();
  } else if (!strcmp(op, "reload_patients")) {
    fetchPatients();
  } else if (!strcmp(op, "record")) {
    sateHookRecord();        // loop() runs the capture when the UI is idle
  } else if (!strcmp(op, "stop")) {
    sateHookStop();          // end an in-progress take (there was no remote Stop before)
  } else if (!strcmp(op, "wifi_change")) {
    // The app asked an ONLINE recorder to enter Change-Wi-Fi mode: drop to BLE
    // and advertise so the phone can push new creds. The account is untouched.
    connEnterWifiChange();
  } else if (!strcmp(op, "reboot")) {
    rebootRequested = true;
    rebootAtMs = millis() + 300;
  }
}

// Pull a firmware .bin from `url` and flash it into the spare OTA app slot,
// Fire one heartbeat now to push the current state/fw/ota phase to the server
// (own buffers, so it is safe to call mid-poll). Body ignored.
static void pushHeartbeatState()
{
  char path[320];
  static char tmp[256];
  snprintf(path, sizeof(path), "/api/devices/%s/commands?pending=%d&state=%s&fw=%s&ota=%s&bat=%d&recs=%lu&mv=%d&rst=%d&up=%lu&heapmin=%u",
           cfgDeviceId, pendCount, liveState, fwVersion, otaPhase,
           telBatteryPct, (unsigned long)telRecordings, telBatteryMv,
           bootResetReason, (unsigned long)(millis() / 1000),
           (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
  httpJson("GET", path, nullptr, tmp, sizeof(tmp), nullptr);
}

// Adapts the global updater to a Stream so HTTPClient::writeToStream() can
// de-chunk a no-Content-Length firmware download straight into flash (the raw
// socket carries the chunk framing, which must never reach the OTA slot).
class UpdateSink : public Stream {
public:
  size_t write(const uint8_t *buf, size_t size) override {
    return Update.write(const_cast<uint8_t *>(buf), size);
  }
  size_t write(uint8_t b) override { return Update.write(&b, 1); }
  int    available() override { return 0; }
  int    read() override { return -1; }
  int    peek() override { return -1; }
  void   flush() override {}
};

// then reboot into it. Blocking; runs on the connLoop task during a command
// poll. The old slot is kept and the new image boots PENDING_VERIFY: it is
// committed only after it proves healthy (see verifyRollbackLater above), so a
// bad OR wedged image rolls back on the next power cycle.
// `version` is informational: if it equals the running build we skip the flash.
static void runOtaUpdate(const char *url, const char *version)
{
  if (!url || !url[0])                  { statusErr("ota", "no url");  Serial.println("[OTA] no url"); return; }
  if (WiFi.status() != WL_CONNECTED)    { statusErr("ota", "offline"); Serial.println("[OTA] offline"); return; }
  if (version && version[0] && !strcmp(version, fwVersion)) {
    Serial.printf("[OTA] already on %s, skip\n", version);
    statusOk("ota");
    return;
  }
  if (sateHookTakeActive()) {
    // A take is armed/running on the UI core. Flashing stalls both cores'
    // cache and the success path reboots - either cuts a live patient
    // recording. Defer: latch the payload and re-run from connLoop() the
    // moment the take ends. Nothing is lost server-side even though the
    // command was already dequeued.
    snprintf(otaPendUrl, sizeof(otaPendUrl), "%s", url);
    snprintf(otaPendVer, sizeof(otaPendVer), "%s", version ? version : "");
    otaDeferred = true;
    Serial.println("[OTA] deferred - take in progress");
    snprintf(otaPhase, sizeof(otaPhase), "deferred-rec");
    pushHeartbeatState();
    return;
  }
  Serial.printf("[OTA] start ver=%s url=%s\n", version ? version : "?", url);
  // Report progress/failure reasons via ota phase so the dashboard/DB shows them
  // even when no serial is attached. "dl" = entered, downloading.
  snprintf(otaPhase, sizeof(otaPhase), "dl");
  pushHeartbeatState();

  // err-get-1 root cause: the warm poller keeps s_httpsClient's mbedTLS arena
  // (~40 KB of internal RAM) resident between polls, and the OTA handshake
  // below needs a SECOND contiguous ~40 KB a busy heap doesn't have. Close the
  // pooled socket and free the poller's TLS context first - the next poll
  // (after the OTA reboot, or after a failed attempt) simply re-handshakes.
  s_http.end();
  s_httpsClient.stop();

  // Dedicated clients for the OTA download. The poller keeps s_httpsClient in a
  // keep-alive session to the functions host; reusing it for the storage host
  // breaks the download, so OTA gets its own clients (stopped fresh each time).
  static WiFiClientSecure otaTls;
  static WiFiClient       otaTcp;
  bool https = (strncmp(url, "https:", 6) == 0);
  HTTPClient http;
  http.setConnectTimeout(8000);
  http.setTimeout(20000);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS); // signed URLs redirect
  http.setReuse(false);
  bool began;
  if (https) {
    otaTls.stop();
    otaTls.setInsecure();               // trust on first use, no CA bundle on-device
    otaTls.setHandshakeTimeout(20);     // seconds; Cloudflare TLS can be slow
    began = http.begin(otaTls, url);
  } else {
    otaTcp.stop();
    began = http.begin(otaTcp, url);
  }
  if (!began) {
    statusErr("ota", "begin failed"); Serial.println("[OTA] begin failed");
    snprintf(otaPhase, sizeof(otaPhase), "err-begin"); pushHeartbeatState();
    return;
  }

  // Public Supabase Storage objects need no auth; these headers also let a
  // private bucket served behind RLS work without changing the call site.
  if (strstr(url, "supabase.co")) {
    char bearer[256];
    snprintf(bearer, sizeof(bearer), "Bearer %s", SUPABASE_ANON_KEY);
    http.addHeader("apikey", SUPABASE_ANON_KEY);
    http.addHeader("Authorization", bearer);
  }

  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    statusErr("ota", "http error");
    Serial.printf("[OTA] GET -> %d\n", code);
    http.end();   // free otaTls's arena BEFORE the heartbeat re-handshakes
    snprintf(otaPhase, sizeof(otaPhase), "err-get%d", code); pushHeartbeatState();
    return;
  }

  int len = http.getSize();
  // Accept unknown length (chunked) by flashing until the stream ends.
  size_t beginSize = (len > 0) ? (size_t)len : UPDATE_SIZE_UNKNOWN;
  if (!Update.begin(beginSize)) {
    statusErr("ota", "no space");
    Update.printError(Serial);
    snprintf(otaPhase, sizeof(otaPhase), "err-space"); pushHeartbeatState();
    http.end();
    return;
  }

  Serial.printf("[OTA] flashing %d bytes...\n", len);
  // Committed to flashing now: tell the dashboard before we block on writeStream.
  snprintf(otaPhase, sizeof(otaPhase), "updating");
  pushHeartbeatState();

  size_t written;
  if (len > 0) {
    WiFiClient *stream = http.getStreamPtr();
    written = Update.writeStream(*stream);
  } else {
    // No Content-Length (Supabase/Cloudflare serve chunked): writeStream()
    // would loop on the FULL partition size, stall ~30 s, then abort - OTA
    // could never succeed - and the raw socket still carries the chunk
    // framing. Let HTTPClient de-chunk the body straight into the updater;
    // it returns when the server finishes the stream.
    UpdateSink sink;
    int wrote = http.writeToStream(&sink);
    written = (wrote > 0) ? (size_t)wrote : 0;
  }
  http.end();

  // With a known length, the write must match it; with unknown length, require
  // some bytes and a clean updater. A mismatch is usually a dropped TLS stream.
  bool shortWrite = (len > 0) ? (written != (size_t)len)
                              : (written == 0 || Update.hasError());
  if (shortWrite) {
    statusErr("ota", "short write");
    Serial.printf("[OTA] wrote %u/%d\n", (unsigned)written, len);
    Update.abort();
    snprintf(otaPhase, sizeof(otaPhase), "err-write"); pushHeartbeatState();
    return;
  }
  if (!Update.end(true)) {              // finalize + set the new slot as boot
    statusErr("ota", "finalize failed");
    Update.printError(Serial);
    snprintf(otaPhase, sizeof(otaPhase), "err-final"); pushHeartbeatState();
    return;
  }

  Serial.println("[OTA] success, rebooting into new image");
  statusOk("ota");
  rebootRequested = true;
  rebootHoldForTake = true;             // a take that began mid-download must
                                        // finish before the reboot cuts it
  rebootAtMs = millis() + 600;          // let the ack flush, then boot new image
}

// Fast path: report pending(cached)+state and run any queued commands. No SD
// access, so it is cheap enough to run every few seconds for snappy control.
static void pollCommands()
{
  // PSRAM resp: off the loop-task stack (single-threaded connLoop) and off the
  // internal heap.
  char path[320];
  const size_t RESP_MAX = 1024;
  static char *resp = (char *)psAlloc(RESP_MAX);
  if (!resp) return;
  // Report fw + ota phase every heartbeat so the dashboard learns the running
  // version (and shows update progress) without a separate endpoint. bat/recs
  // are device telemetry for the admin dashboard (battery %, lifetime count);
  // mv is the raw cell mV for admin-side battery calibration.
  snprintf(path, sizeof(path), "/api/devices/%s/commands?pending=%d&state=%s&fw=%s&ota=%s&bat=%d&recs=%lu&mv=%d&rst=%d&up=%lu&heapmin=%u",
           cfgDeviceId, pendCount, liveState, fwVersion, otaPhase,
           telBatteryPct, (unsigned long)telRecordings, telBatteryMv,
           bootResetReason, (unsigned long)(millis() / 1000),
           (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
  if (!httpJson("GET", path, nullptr, resp, RESP_MAX, nullptr)) return;
  JsonDocument doc(&s_jsonPsram);
  if (deserializeJson(doc, resp) != DeserializationError::Ok) return;
  // The ONLY path back to first-time setup: the SLP removed this recorder from
  // their account on the server, so the device row is gone and the heartbeat
  // comes back { unclaimed: true }. Holding BOOT no longer wipes the account -
  // it just changes Wi-Fi - so this server signal is what unprovisions a unit.
  if (doc["unclaimed"] | false) {
    Serial.println("[CONN] server reports device removed from account - resetting to setup");
    connFactoryReset();   // wipes Wi-Fi + account, reboots unprovisioned
    return;
  }
  // The app can attach the patient the SLP typed for the next remote recording;
  // stage it before running commands so a queued "record" tags the session to
  // them.
  JsonObject ap = doc["active_patient"].as<JsonObject>();
  if (!ap.isNull()) {
    sateHookSetActivePatient(ap["patient_id"] | "", ap["name"] | "",
                             ap["age"] | "", ap["session_type"] | "",
                             ap["clinician"] | "");
  }
  // OTA payload (url + target version) rides alongside the command list, since
  // WiFi commands are plain strings. An "ota" command consumes it.
  JsonObjectConst ota = doc["ota"].as<JsonObjectConst>();
  // [fw 1.5.19] A record command may carry an exact duration. The device stops
  // the take ITSELF at N seconds of PCM (byte-exact cap on the capture loop) —
  // callers no longer race a "stop" through the poll channel (+3-12 s of slop).
  uint32_t recSecs = doc["record_seconds"] | 0;
  for (JsonVariant v : doc["commands"].as<JsonArray>()) {
    const char *op = v.as<const char *>();
    if (op && !strcmp(op, "ota")) {
      if (!ota.isNull()) runOtaUpdate(ota["url"] | "", ota["version"] | "");
      else               statusErr("ota", "no payload");
    } else if (op && !strcmp(op, "record") && recSecs > 0) {
      Serial.printf("[CONN] remote command: record (%lus exact)\n", (unsigned long)recSecs);
      sateHookRecordTimed(recSecs);
    } else {
      runRemoteCommand(op);
    }
  }
}

// =============================================================================
// public API
// =============================================================================

void connInit(const char *fw)
{
  snprintf(fwVersion, sizeof(fwVersion), "%s", fw);
  bootResetReason = (int)esp_reset_reason();
  // Big task-only buffers live in PSRAM (see psAlloc): these four plus the
  // lazily-allocated ones at their use sites free ~26 KB of internal DRAM for
  // the TLS handshakes. None are DMA- or ISR-touched.
  if (!ctrlAsm)   ctrlAsm   = (uint8_t *)psAlloc(CTRL_BUF_MAX);
  if (!opBuf)     opBuf     = (uint8_t *)psAlloc(CTRL_BUF_MAX);
  if (!pendTable) pendTable = (PendingEntry *)psAlloc(sizeof(PendingEntry) * PEND_MAX);
  if (!upStrikes) upStrikes = (UploadStrike *)psAlloc(sizeof(UploadStrike) * UP_STRIKE_MAX);
  if (!pendMux) pendMux = xSemaphoreCreateMutex();
  WiFi.onEvent(onWifiStaDisconnected, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.mode(WIFI_STA); // also powers up the radio so the MAC is readable
  buildSerial();
  loadConfig();
  Serial.printf("[CONN] serial=%s provisioned=%d\n", serialStr, provisioned);

  if (provisioned) enterWifiTrying();
  else enterBleMode();
}

void connLoop()
{
  uint32_t now = millis();

  // Commit a freshly-flashed OTA image only after it has PROVEN itself: this
  // point means setup() completed, loop() runs and connLoop() is being
  // serviced - none of the "bootable but wedged" failure modes. Until it
  // fires, a power cycle rolls back to the previous firmware (the bootloader
  // marks a PENDING_VERIFY slot aborted). See verifyRollbackLater() above.
  static bool otaHealthChecked = false;
  if (!otaHealthChecked && (int32_t)(now - 30000) >= 0) {
    otaHealthChecked = true;
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t st;
    if (running && esp_ota_get_state_partition(running, &st) == ESP_OK &&
        st == ESP_OTA_IMG_PENDING_VERIFY) {
      esp_ota_mark_app_valid_cancel_rollback();
      Serial.println("[OTA] new image confirmed healthy - rollback cancelled");
    }
  }

  if (rebootRequested && timeAfter(now, rebootAtMs)) {
    if (rebootHoldForTake && sateHookTakeActive()) {
      // The reboot came from an OTA flash and a take started mid-download:
      // never cut a live capture. Checked every pass - fires once it ends.
      // (A remote `reboot` command doesn't set the hold: it stays available
      // as the recovery path for a wedged take.)
    } else {
      Serial.println("[CONN] rebooting");
      delay(100);
      ESP.restart();
    }
  }

  // An OTA deferred mid-take runs the moment the take is over (still online).
  if (otaDeferred && !sateHookTakeActive() && mode == CONN_WIFI_ONLINE) {
    otaDeferred = false;
    runOtaUpdate(otaPendUrl, otaPendVer);
  }

  if (factoryResetRequested && timeAfter(now, factoryResetAtMs)) {
    connFactoryReset();   // wipes Wi-Fi + account, reboots to first-time setup
  }

  // BLE op ready?
  if (opLen > 0 && opBuf) {
    // PSRAM: task-only scratch; 6 KB of internal .bss was TLS-handshake headroom.
    static char *job = (char *)psAlloc(CTRL_BUF_MAX);
    if (!job) { opLen = 0; return; }
    portENTER_CRITICAL(&opMux);
    size_t len = opLen;
    memcpy(job, opBuf, len);
    job[len] = '\0';
    opLen = 0;
    portEXIT_CRITICAL(&opMux);
    netSdBusy = true;    // BLE ops read/write the card (list/send/mark/set)
    handleBleOp(job);
    netSdBusy = false;
  }

  // Async Wi-Fi scan result collection (started by the scan_wifi op).
  if (scanInProgress) {
    int found = WiFi.scanComplete();
    bool deadlineHit = timeAfter(now, scanDeadline);
    if (found == WIFI_SCAN_RUNNING && !deadlineHit) {
      // still scanning; check again next pass
    } else if (found < 1 && !scanRetried) {
      // Empty (0), failed (-2), or stalled to the deadline once: the radio
      // likely lost the coexistence coin-toss with the live BLE link. Restart a
      // clean scan once before reporting "no networks" - far more reliable.
      scanRetried = true;
      Serial.printf("[CONN] Wi-Fi scan returned %d - retrying once\n", found);
      esp_wifi_scan_stop();
      WiFi.scanDelete();
      WiFi.scanNetworks(true /*async*/, false /*show_hidden*/, true /*passive*/, 300);
      scanDeadline = now + WIFI_SCAN_ATTEMPT_MS;
    } else {
      // scan finished (or both attempts exhausted) - hand the radio back to
      // balanced coexistence before we notify over the BLE link.
      esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
      Serial.printf("[CONN] Wi-Fi scan complete: %d AP(s)\n", found);
      if (found < 0) found = 0; // failed or timed out -> empty list
      char out[1024];
      size_t o = snprintf(out, sizeof(out), "{\"ev\":\"scan\",\"networks\":[");
      int emitted = 0;
      for (int i = 0; i < found && emitted < 12; i++) {
        String ssid = WiFi.SSID(i);
        if (ssid.length() == 0) continue;
        o += snprintf(out + o, sizeof(out) - o, "%s{\"ssid\":\"%s\",\"rssi\":%d,\"sec\":\"%s\"}",
                      emitted ? "," : "", ssid.c_str(), WiFi.RSSI(i),
                      WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "open" : "wpa");
        emitted++;
        if (o > sizeof(out) - 96) break;
      }
      o += snprintf(out + o, sizeof(out) - o, "]}");
      WiFi.scanDelete();
      scanInProgress = false;
      statusNotify(out);
      setStatus("App connected (Bluetooth)");
    }
  }

  if (provState != PROV_IDLE) {
    handleProvisionTick();
    return;
  }

  switch (mode) {
    case CONN_WIFI_TRYING:
      if (WiFi.status() == WL_CONNECTED) {
        // if the companion app is mid-session over BLE, let it finish first;
        // the CONN_BLE branch switches to Wi-Fi after it disconnects
        if (bleClientConnected) mode = CONN_BLE_CONNECTED;
        else enterWifiOnline();
      } else if (timeAfter(now, wifiDeadline)) {
        Serial.println("[CONN] Wi-Fi unavailable -> BLE mode");
        WiFi.disconnect(true);
        enterBleMode();
      }
      break;

    case CONN_WIFI_ONLINE:
      if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[CONN] Wi-Fi lost -> BLE mode");
        // Never leave the uploader latched across the mode change: a stuck
        // upActive/upFile froze the full-screen upload overlay for the whole
        // outage and made every later delete wait out its full guard.
        uploadAbortInFlight();
        enterBleMode();
        break;
      }
      if (forcePollDue) {        // connSetLiveState() asked to push state now
        forcePollDue = false;
        pollCommands();
      }
      if (timeAfter(now, nextCmdPoll)) {
        nextCmdPoll = now + CMD_POLL_PERIOD_MS;
        pollCommands();          // picks up app commands within ~12 s (runs on the
                                 // net task now, so it no longer freezes the GUI)
      }
      // While the UI core is doing its own SD work (recording, saving, playback),
      // hold off ALL SD access here. The SD bus + FATFS volume lock are shared, so
      // overlapping the net task's walks/uploads with a take made begin/stop/record
      // drag. HTTP polling above has no SD, so it keeps running - only SD work waits
      // (a few hundred ms, until the take ends), then uploads resume. This restores
      // the old "record, THEN sync" timing without losing dual-core responsiveness.
      // Raise netSdBusy BEFORE re-reading uiSdBusy so the UI core's handshake
      // (set uiSdBusy -> wait for connNetSdIdle()) has no check-then-act hole:
      // if the UI observes netSdBusy false after setting its flag, this task is
      // guaranteed to see uiSdBusy on its next arrival here and stay out.
      netSdBusy = true;
      if (!uiSdBusy) {
        if (timeAfter(now, nextHeartbeat)) {
          nextHeartbeat = now + HEARTBEAT_PERIOD_MS;
          scanPending();           // slow: refresh the cached pending count
          // Never sit idle with work pending. The sweep is otherwise only armed by
          // go-online / sync_now / a new recording, so if it ever stopped early
          // (e.g. one beginUpload failed) the backlog stalled until the next take -
          // exactly the "stuck at uploading" we saw. Re-arm it here so anything
          // pending drains on its own, at the heartbeat cadence.
          if (pendCount > 0 && !upActive) uploadSweepDue = true;
        }
        if (patientsFetchDue) {
          patientsFetchDue = false;
          fetchPatients();
        }
        if (upActive) {
          // Send ONE slice this pass, then return - command poll keeps running, so a
          // big upload doesn't make the device feel laggy.
          uploadStep();
        } else if (uploadSweepDue) {
          scanPending();
          // Take the first pending session that isn't parked. This used to be a
          // hard pendTable[0]: one unsendable session sat at the head and the whole
          // backlog behind it never moved. A failed beginUpload() now strikes that
          // session and the sweep tries the NEXT one on the following pass, so the
          // queue always drains around a bad entry instead of stopping dead.
          bool started = false;
          for (int i = 0; i < pendCount; i++) {
            if (strikeParked(pendTable[i].patientId, pendTable[i].num, now)) continue;
            if (beginUpload(pendTable[i])) { started = true; break; }
            strikeAdd(pendTable[i].patientId, pendTable[i].num);
            Serial.printf("[CONN] cannot begin %s session %lu, skipping\n",
                          pendTable[i].patientId, (unsigned long)pendTable[i].num);
          }
          // Nothing startable right now (all sent, all parked, or all unopenable).
          // The heartbeat re-arms the sweep, and parks expire, so this retries later.
          if (!started) uploadSweepDue = false;
        }
      }
      else if (upActive) {
        // UI core just took the SD bus (record / save / playback / delete).
        // Abort any in-flight upload HERE, on the net task, so the source file
        // handle is closed before the UI touches session files. Otherwise FATFS
        // returns FR_LOCKED on the open file and the "Saving..." screen hangs.
        // Not a failure - the resume point is kept, so the sweep re-begins this
        // session at the server's offset once the UI releases the bus.
        uploadAbortInFlight();
      }
      netSdBusy = false;
      break;

    case CONN_BLE_ADV:
    case CONN_BLE_CONNECTED:
      // The mode can leave CONN_WIFI_ONLINE without net-task teardown (e.g.
      // connEnterWifiChange() runs on the UI core). A latched upload would
      // freeze the overlay and stall every later delete - tear it down here,
      // on the task that owns upFile.
      if (upActive || upHasFile) uploadAbortInFlight();
      mode = bleClientConnected ? CONN_BLE_CONNECTED : CONN_BLE_ADV;
      if (!bleClientConnected) {
        // Change-Wi-Fi was entered (BOOT-hold / wifi_change) but no app ever
        // finished it - auto-cancel after the timeout so the recorder doesn't sit
        // in pairing mode forever; it then resumes normal Wi-Fi + the screen
        // returns to the main page.
        if (wifiChangeMode && now - wifiChangeStart > WIFI_CHANGE_TIMEOUT_MS) {
          Serial.println("[CONN] Change-Wi-Fi timed out - resuming normal Wi-Fi");
          wifiChangeMode = false;
          setStatus("Wi-Fi change cancelled");
        }
        // after a successful provisioning the app disconnects; go online.
        // While waiting for new creds (Change-Wi-Fi) we must NOT pop back online
        // on a stray auto-reconnect to the old network - stay on BLE.
        if (!wifiChangeMode && provisioned && WiFi.status() == WL_CONNECTED) {
          enterWifiOnline();
          break;
        }
        // In Change-Wi-Fi mode we deliberately stay on BLE (no auto-reconnect to
        // the OLD network) so the app has a window to push the new credentials.
        if (!wifiChangeMode && provisioned && timeAfter(now, nextWifiRetry)) {
          nextWifiRetry = now + WIFI_RETRY_PERIOD_MS;
          enterWifiTrying(); // BLE keeps advertising during the attempt
          break;
        }
        if (timeAfter(now, nextAdvRefresh)) {
          nextAdvRefresh = now + ADV_REFRESH_PERIOD_MS;
          netSdBusy = true;
          scanPending();
          netSdBusy = false;
          bleUpdateAdvertising();
        }
      }
      break;

    default:
      break;
  }
}

ConnMode connGetMode() { return mode; }
const char *connSerial() { return serialStr; }

// Full Wi-Fi STA MAC ("AA:BB:CC:DD:EE:FF") - the address the router sees, for
// MAC-allowlist Wi-Fi. Valid once the radio is up (connInit starts STA mode).
const char *connMac()
{
  static char macStr[18] = "--:--:--:--:--:--";
  String m = WiFi.macAddress();
  if (m.length() == 17) snprintf(macStr, sizeof(macStr), "%s", m.c_str());
  return macStr;
}
bool connProvisioned() { return provisioned; }

uint32_t connPendingTotal()
{
  // Return the CACHED count - no SD walk. This is polled by the GUI core every
  // ~250 ms; walking the card here (on core 1) fought the net task's upload reads
  // (core 0) and slowed sync. The net task refreshes pendCount on its heartbeat,
  // each upload sweep, and after every synced session, so the cache stays current.
  return (pendCount < 0) ? 0 : (uint32_t)pendCount;
}

// Byte-level progress of the session currently uploading. Returns true while a
// session is in flight and fills *sent/*total with its byte counts, so the UI
// can animate smoothly even for a single small session (the pending count is
// only session-granular: 0/1 until the whole session lands).
bool connUploadProgress(uint32_t *sent, uint32_t *total)
{
  if (!upActive || upTotal == 0) return false;
  if (sent)  *sent  = (uint32_t)upServerOffset;
  if (total) *total = (uint32_t)upTotal;
  return true;
}

// Which patient/session is uploading right now, so the Sessions list can mark
// the exact row live. Returns false when nothing is in flight.
bool connUploadingSession(char *pidOut, size_t pidLen, uint32_t *numOut)
{
  if (!upActive) return false;
  if (pidOut && pidLen) snprintf(pidOut, pidLen, "%s", upPid);
  if (numOut) *numOut = upNum;
  return true;
}

// Percent (0-100) of the session in flight, or -1 if no upload is active.
int connUploadPercent()
{
  if (!upActive || upTotal == 0) return -1;
  return (int)((uint64_t)upServerOffset * 100 / upTotal);
}

const char *connStatusText() { return statusText; }
const char *connIp() { return ipText; }
bool connSetupActive() { return bleClientConnected || provState != PROV_IDLE; }

void connEnterWifiChange()
{
  // Non-destructive: keep the account/server/device key, just re-open BLE so the
  // companion app can push a new Wi-Fi network. Replaces the old BOOT-hold wipe.
  if (!provisioned) return;        // nothing claimed yet -> normal setup applies
  wifiChangeMode = true;
  wifiChangeStart = millis();
  WiFi.disconnect(false);          // leave the old network; we want BLE adv now
  if (mode != CONN_BLE_ADV && mode != CONN_BLE_CONNECTED) enterBleMode();
  else { bleUpdateAdvertising(); NimBLEDevice::startAdvertising(); }
  setStatus("Change Wi-Fi: open the SATE app nearby");
}

bool connWifiChangeMode() { return wifiChangeMode; }

void connFactoryReset()
{
  Serial.println("[CONN] FACTORY RESET - clearing config, rebooting");
  prefs.begin("sate", false);
  prefs.clear();              // drop ssid/pass/server/dev_id/dev_key
  prefs.end();
  delay(150);
  ESP.restart();              // comes back unprovisioned -> setup screen
}

void connSetLiveState(const char *s)
{
  snprintf(liveState, sizeof(liveState), "%s", s ? s : "idle");
  // Ask the net task to push it on its next pass (immediately). We must NOT call
  // pollCommands() here: this runs on the GUI core, and the poller (s_http) is
  // owned by the net task - calling it here would block the GUI and race the
  // shared HTTP client. The flag is consumed in connLoop() within a few ms.
  if (mode == CONN_WIFI_ONLINE) forcePollDue = true;
}

void connSetTelemetry(int batteryPct, uint32_t totalRecordings, int batteryMv)
{
  telBatteryPct = batteryPct;
  telRecordings = totalRecordings;
  telBatteryMv  = batteryMv;
}

void connSetUiSdBusy(bool busy)
{
  uiSdBusy = busy;
}

// Positive acknowledgement that the net task is OUT of its SD work: not inside
// an SD block (netSdBusy) and with no upload latched (upActive covers the whole
// tail through writeSyncMarker + trim). The UI core must set uiSdBusy FIRST and
// then poll this until true before deleting/re-mounting - a bare
// connUploadProgress() check was check-then-act and raced the sweep.
bool connNetSdIdle()
{
  return !netSdBusy && !upActive;
}

// Sticky SD trouble seen by the net task (pending scan could not read the card,
// or a .synced marker could not be written). Self-clears when the same op
// succeeds again. The UI renders this as "SD card error" instead of the
// misleading "all synced" / stale pending count.
bool connSdFault()
{
  return sdFaultFlag;
}

// A session was deleted on-device. Deletes NEVER renumber: every other session
// keeps its number, so only the uploader's memory of THIS (patient, number)
// must go - the number can be handed to a future take once its files are gone,
// and a stale resume offset, strike, or still-latched in-flight upload would
// then poison that new take (wrong-offset resume, or two takes spliced into one
// server WAV). Safe to call from the UI core: callers hold the SD bus
// (connSetUiSdBusy(true)), which keeps the net task out of the upload/sweep
// block, and the in-flight upload itself is only FLAGGED here - the net task
// closes upFile on its own next uploadStep() pass (see upDropReq).
void connNotifySessionDeleted(const char *patientId, uint32_t num)
{
  pendDirty = true;
  if (upResumeNum == num && !strcmp(upResumePid, patientId)) upResumeClear();
  strikeClear(patientId, num);
  if (upActive && upNum == num && !strcmp(upPid, patientId)) {
    snprintf(upDropPid, sizeof(upDropPid), "%s", patientId);
    upDropNum = num;
    upDropReq = true;
  }
}

void connNotifyNewSession()
{
  pendDirty = true; // a new recording was just saved
  if (mode == CONN_WIFI_ONLINE) uploadSweepDue = true;
  else if (bleInited && !bleClientConnected) {
    scanPending();
    bleUpdateAdvertising();
  }
}

// All connectivity work (HTTP/TLS poll, heartbeat, uploads, BLE provisioning)
// runs here, pinned to the core the Arduino loop does NOT use. A blocking poll or
// TLS handshake then stalls only this task - the GUI + physical buttons on the
// loop core stay responsive. The ESP32-S3's two cores make this a clean split:
// Wi-Fi/BT stacks already live on core 0, so we pin the net task there and leave
// core 1 entirely to the UI. connInit() must have run first.
static void netTaskFn(void *)
{
  for (;;) {
    connLoop();
    vTaskDelay(pdMS_TO_TICKS(5));   // yield so core 0's idle/Wi-Fi tasks run
  }
}

static TaskHandle_t s_netTaskHandle = nullptr;

void connStartNetTask()
{
  if (g_netStarted) return;            // once only
  g_netStarted = true;
  // 16 KB stack: a Supabase TLS handshake (mbedTLS) is stack-heavy; the big I/O
  // buffers are static, so this headroom is for the handshake + JSON parse.
  // Core 0 (PRO_CPU) alongside the Wi-Fi/BT stacks; the Arduino loop is on core 1.
  xTaskCreatePinnedToCore(netTaskFn, "sateNet", 16384, nullptr, 1, &s_netTaskHandle, 0);
}

// Never-used bytes at the bottom of the net task's stack (ESP-IDF stacks are
// byte-granular). 0 = task not started. For the serial DIAG dump.
uint32_t connNetStackHighWater()
{
  return s_netTaskHandle ? (uint32_t)uxTaskGetStackHighWaterMark(s_netTaskHandle) : 0;
}

// True once the net task owns connLoop(); until then the main loop drives it.
bool connNetTaskStarted() { return g_netStarted; }
// True when the device just went online and the net task should be started.
bool connNetTaskWanted()  { return g_wantNetTask; }
