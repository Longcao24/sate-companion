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

static const uint32_t WIFI_BOOT_TIMEOUT_MS  = 18000;
static const uint32_t WIFI_PROV_TIMEOUT_MS  = 28000;
static const uint32_t WIFI_PROV_RETRY_MS    = 11000;   // re-begin once if stalled
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
static char provSsid[33], provPass[65], provServer[96], provClaim[48];

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

// Control-write reassembly (BLE task writes, connLoop consumes)
static uint8_t       ctrlAsm[6144];
static size_t        ctrlAsmLen = 0;
static uint8_t       opBuf[6144];
static volatile size_t opLen   = 0;   // >0 means an op is ready
static portMUX_TYPE  opMux = portMUX_INITIALIZER_UNLOCKED;

// Pending-session table built by list_sessions; "n" on the wire = index + 1.
struct PendingEntry {
  char     patientId[20];
  uint32_t num;
  uint32_t bytes;
};
static PendingEntry pendTable[64];
static int          pendCount = 0;

static uint8_t ioChunk[4096]; // connectivity's own SD/BLE work buffer

// Live status line for the on-device Connection screen.
static char statusText[72] = "Starting...";
static char ipText[20] = "";

// Live activity reported to the server in the heartbeat (idle/recording/uploading).
static char liveState[16] = "idle";

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

// True when the pending set may have changed (new recording, a sync, a roster
// change) and scanPending() must re-walk the SD card. While false, scanPending
// returns the cached count instead of walking every patient dir - that walk was
// running every 15 s heartbeat and was the periodic UI hitch.
static bool pendDirty = true;

// Scan all patient dirs for WAVs without a .synced marker. Cheap no-op when the
// cached count is still valid.
static int scanPending()
{
  if (!pendDirty) return pendCount;
  pendCount = 0;
  File root = SD_MMC.open("/sate/patients");
  if (!root) return 0;
  File entry;
  while ((entry = root.openNextFile()) && pendCount < (int)(sizeof(pendTable) / sizeof(pendTable[0]))) {
    if (!entry.isDirectory()) { entry.close(); continue; }
    const char *full = entry.name(); // basename or full path depending on core
    const char *pid = strrchr(full, '/');
    pid = pid ? pid + 1 : full;
    char wav[160], part0[200], mark[160], pp[200];
    for (uint32_t i = 1; i <= 9999; i++) {
      // A session exists if it has segment files (new), a merged .wav (legacy),
      // OR a .synced marker (its audio was purged after upload but the slot is
      // still taken). We must check the marker BEFORE deciding we've hit the end
      // - otherwise a synced+purged session looks like "no session here" and we
      // stop early, missing every later session. That bug made Home report
      // "all synced" while a real later recording sat queued and never uploaded.
      sessionPath(wav, sizeof(wav), pid, i, "wav");
      sessionPartFile(part0, sizeof(part0), pid, i, 0);
      sessionPath(mark, sizeof(mark), pid, i, "synced");
      bool hasWav   = SD_MMC.exists(wav);
      bool hasParts = SD_MMC.exists(part0);
      bool hasMark  = SD_MMC.exists(mark);
      if (!hasWav && !hasParts && !hasMark) break; // nothing in slot i = end
      if (hasMark) continue;                       // already on the server

      uint32_t bytes = 0;
      if (hasWav) {
        File f = SD_MMC.open(wav, FILE_READ);
        if (f) { bytes = (uint32_t)f.size(); f.close(); }
      } else {
        for (int k = 0;; k++) {
          sessionPartFile(pp, sizeof(pp), pid, i, k);
          if (!SD_MMC.exists(pp)) break;
          File f = SD_MMC.open(pp, FILE_READ);
          if (f) { bytes += (uint32_t)f.size(); f.close(); }
        }
      }
      PendingEntry &pe = pendTable[pendCount++];
      snprintf(pe.patientId, sizeof(pe.patientId), "%s", pid);
      pe.num = i;
      pe.bytes = bytes;
      if (pendCount >= (int)(sizeof(pendTable) / sizeof(pendTable[0]))) break;
    }
    entry.close();
  }
  root.close();
  pendDirty = false; // cache is now valid until the pending set changes again
  return pendCount;
}

static void writeSyncMarker(const char *pid, uint32_t num)
{
  char mark[160];
  sessionPath(mark, sizeof(mark), pid, num, "synced");
  File f = SD_MMC.open(mark, FILE_WRITE);
  if (f) {
    f.print("synced");
    f.close();
  }
  pendDirty = true; // a session just synced - pending count changed
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
    NimBLEDevice::startAdvertising();
    setStatus(provisioned ? "Bluetooth on - waiting for app"
                          : "Ready for setup - open the SATE app");
  }
};

class CtrlCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &) override
  {
    NimBLEAttValue v = c->getValue();
    if (v.size() < 1) return;
    uint8_t flag = v.data()[0];
    size_t payload = v.size() - 1;
    if (ctrlAsmLen + payload <= sizeof(ctrlAsm)) {
      memcpy(ctrlAsm + ctrlAsmLen, v.data() + 1, payload);
      ctrlAsmLen += payload;
    }
    if (flag == FRAME_FINAL) {
      portENTER_CRITICAL(&opMux);
      if (opLen == 0 && ctrlAsmLen < sizeof(opBuf)) {
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
static void notifyFramed(NimBLECharacteristic *ch, const uint8_t *buf, size_t len)
{
  if (!ch || !bleClientConnected) return;
  uint8_t pkt[1 + BLE_CHUNK];
  size_t off = 0;
  do {
    size_t take = len - off;
    if (take > BLE_CHUNK) take = BLE_CHUNK;
    pkt[0] = (off + take >= len) ? FRAME_FINAL : FRAME_PARTIAL;
    memcpy(pkt + 1, buf + off, take);
    ch->setValue(pkt, 1 + take);
    for (int tries = 0; tries < 50 && !ch->notify(); tries++) delay(5);
    off += take;
    delay(2); // pacing: keep the NimBLE TX queue happy
  } while (off < len);
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

static bool httpJson(const char *method, const char *path, const char *body,
                     char *resp, size_t respSize, int *codeOut)
{
  if (WiFi.status() != WL_CONNECTED) return false;
  char url[192];
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
    // Content-Length). getString() de-chunks correctly; a raw stream read would
    // leave hex chunk-size markers in the buffer and break JSON parsing.
    String s = s_http.getString();
    size_t n = s.length();
    if (n > respSize - 1) n = respSize - 1;
    memcpy(resp, s.c_str(), n);
    resp[n] = '\0';
  }
  s_http.end(); // with reuse(true) this returns the socket to the pool, not close
  return ok;
}

// POST one ~1 MB slice of the WAV at byte `offset` to /api/sessions/chunk. The
// GUI is serviced between writes so the screen stays smooth; returns true on a
// 2xx. The server appends in order (and is idempotent if a slice is re-sent), so
// a dropped connection only costs this slice - retried at the same offset.
static bool sendSessionChunk(const char *host, int port, const char *metaQuery,
                             size_t serverOffset, size_t fileSeek, size_t len,
                             bool isFinal, File &wf)
{
  // WiFiClientSecure IS-A WiFiClient, so one reference drives both: TLS to
  // Supabase (port 443), plain HTTP to a local/self-hosted server.
  WiFiClient plain;
  WiFiClientSecure tls;
  if (serverIsSupabase()) tls.setInsecure();
  WiFiClient &client = serverIsSupabase() ? static_cast<WiFiClient &>(tls) : plain;
  client.setTimeout(15000);
  if (!client.connect(host, port)) return false;

  client.printf("POST %s&offset=%u&final=%d HTTP/1.1\r\n",
                metaQuery, (unsigned)serverOffset, isFinal ? 1 : 0);
  client.printf("Host: %s:%d\r\n", host, port);
  if (cfgDeviceKey[0]) client.printf("Authorization: Bearer %s\r\n", cfgDeviceKey);
  if (serverIsSupabase()) client.printf("apikey: %s\r\n", SUPABASE_ANON_KEY);
  client.print("Content-Type: audio/wav\r\n");
  client.printf("Content-Length: %u\r\n", (unsigned)len);
  client.print("Connection: close\r\n\r\n");

  if (!wf.seek(fileSeek)) { client.stop(); return false; }

  static uint8_t upBuf[4096];
  size_t   sent = 0;
  uint32_t lastPump = millis();
  bool     ok = true;
  while (sent < len) {
    size_t want = len - sent;
    if (want > sizeof(upBuf)) want = sizeof(upBuf);
    size_t got = wf.read(upBuf, want);
    if (got == 0) { ok = false; break; }
    size_t w = 0;
    uint32_t t0 = millis();
    while (w < got) {
      int n = client.write(upBuf + w, got - w);
      if (n > 0) { w += n; t0 = millis(); }
      else if (!client.connected() || millis() - t0 > 8000) { ok = false; break; }
      else { sateHookGuiPump(); delay(1); }
    }
    if (!ok) break;
    sent += got;
    if (millis() - lastPump >= 30) { lastPump = millis(); sateHookGuiPump(); }
  }

  int code = 0;
  if (ok) {
    char line[80];
    size_t li = 0;
    uint32_t t0 = millis();
    while (millis() - t0 < 8000) {
      int c = client.read();
      if (c < 0) {
        if (!client.connected() && !client.available()) break;
        sateHookGuiPump();
        delay(1);
        continue;
      }
      if (c == '\n') break;
      if (c != '\r' && li < sizeof(line) - 1) line[li++] = (char)c;
    }
    line[li] = '\0';
    sscanf(line, "HTTP/1.%*d %d", &code);
  }
  client.stop();
  return code >= 200 && code < 300;
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
static char     upHost[80], upMetaQuery[224], upPid[24];
static uint32_t upNum = 0, upStartMs = 0;
static bool     upLegacy = false;  // single .wav vs segment files
static int      upSrcIdx = 0, upLastSrc = 0;
static size_t   upSrcBase = 0, upSrcLen = 0, upSrcPos = 0;
static size_t   upServerOffset = 0, upTotal = 0;

static bool beginUpload(const PendingEntry &pe)
{
  if (WiFi.status() != WL_CONNECTED) return false;

  uint32_t sessionNumber = pe.num, sampleRate = 16000;
  char jsonPath[160];
  sessionPath(jsonPath, sizeof(jsonPath), pe.patientId, pe.num, "json");
  File jf = SD_MMC.open(jsonPath, FILE_READ);
  if (jf) {
    JsonDocument meta;
    if (deserializeJson(meta, jf) == DeserializationError::Ok) {
      sessionNumber = meta["session_number"] | pe.num;
      sampleRate    = meta["sample_rate"] | 16000;
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
    for (int k = 0;; k++) {
      sessionPartFile(pp, sizeof(pp), pe.patientId, pe.num, k);
      if (!SD_MMC.exists(pp)) break;
      File f = SD_MMC.open(pp, FILE_READ);
      size_t sz = f ? f.size() : 0;
      if (f) f.close();
      upTotal += (k == 0) ? sz : ((sz > 44) ? sz - 44 : 0); // part0 keeps header
      cnt++;
    }
    if (cnt == 0) return false;
    upLastSrc = cnt - 1;
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

  snprintf(upMetaQuery, sizeof(upMetaQuery),
           "%s/api/sessions/chunk?device_serial=%s&patient_id=%s"
           "&session_number=%lu&sample_rate=%lu",
           prefix, serialStr, pe.patientId,
           (unsigned long)sessionNumber, (unsigned long)sampleRate);
  snprintf(upPid, sizeof(upPid), "%s", pe.patientId);
  upNum = pe.num;
  upSrcIdx = 0;
  upHasFile = false;
  upServerOffset = 0;
  upRetries = 0;
  upActive = true;
  upStartMs = millis();
  setStatus("Uploading session to SATE...");
  sateHookUploadBegin();
  return true;
}

static void uploadStep()
{
  if (!upActive) return;

  // Open the current source segment if needed.
  if (!upHasFile) {
    char path[200];
    if (upLegacy) sessionPath(path, sizeof(path), upPid, upNum, "wav");
    else          sessionPartFile(path, sizeof(path), upPid, upNum, upSrcIdx);
    upFile = SD_MMC.open(path, FILE_READ);
    if (!upFile) {
      upActive = false;
      sateHookUploadEnd();
      Serial.printf("[CONN] upload: cannot open %s\n", path);
      return;
    }
    size_t fsz = upFile.size();
    upSrcBase = (upLegacy || upSrcIdx == 0) ? 0 : 44; // part>0: skip its WAV header
    upSrcLen  = (fsz > upSrcBase) ? fsz - upSrcBase : 0;
    upSrcPos  = 0;
    upHasFile = true;
  }

  size_t len = upSrcLen - upSrcPos;
  if (len > UPLOAD_CHUNK_BYTES) len = UPLOAD_CHUNK_BYTES;
  bool lastOfSrc = (upSrcPos + len >= upSrcLen);
  bool isFinal   = (upSrcIdx == upLastSrc && lastOfSrc);
  size_t fileSeek = upSrcBase + upSrcPos;

  if (len > 0 &&
      !sendSessionChunk(upHost, upPort, upMetaQuery, upServerOffset, fileSeek, len, isFinal, upFile)) {
    if (++upRetries >= 8) {
      if (upHasFile) { upFile.close(); upHasFile = false; }
      upActive = false; // sweep retries the whole session later (from offset 0)
      sateHookUploadEnd();
      Serial.printf("[CONN] upload stalled at %u/%u, will retry\n",
                    (unsigned)upServerOffset, (unsigned)upTotal);
    }
    return;
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
      upActive = false;
      writeSyncMarker(upPid, upNum);
      // Free the local audio now that it's on the server - the .synced marker
      // keeps the session counted so the SD card doesn't fill with synced audio.
      char ap[200];
      if (upLegacy) { sessionPath(ap, sizeof(ap), upPid, upNum, "wav"); SD_MMC.remove(ap); }
      else {
        for (int k = 0;; k++) {
          sessionPartFile(ap, sizeof(ap), upPid, upNum, k);
          if (!SD_MMC.exists(ap)) break;
          SD_MMC.remove(ap);
        }
      }
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
  // static: keeps 2 KB off the shared loop-task stack (connLoop is single-threaded).
  static char resp[2048];
  if (!httpJson("GET", "/api/patients", nullptr, resp, sizeof(resp), nullptr)) return;
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

static void enterWifiTrying()
{
  mode = CONN_WIFI_TRYING;
  WiFi.mode(WIFI_STA);
  WiFi.begin(cfgSsid, cfgPass);
  wifiDeadline = millis() + WIFI_BOOT_TIMEOUT_MS;
  setStatus("Connecting to Wi-Fi \"%s\"...", cfgSsid);
}

static void enterWifiOnline()
{
  mode = CONN_WIFI_ONLINE;
  bleStop(); // Wi-Fi mode does not advertise; frees NimBLE RAM
  nextHeartbeat = 0;       // scan pending immediately
  nextCmdPoll = 0;         // and poll commands immediately
  uploadSweepDue = true;   // push pending sessions right away
  patientsFetchDue = true; // pull the latest patient list
  snprintf(ipText, sizeof(ipText), "%s", WiFi.localIP().toString().c_str());
  setStatus("Online (Wi-Fi) - %s", ipText);
}

// =============================================================================
// BLE op handling (runs in connLoop)
// =============================================================================

static void sendSessionOverBle(int tableIdx)
{
  const PendingEntry &pe = pendTable[tableIdx];
  char wavPath[160], jsonPath[160];
  sessionPath(wavPath, sizeof(wavPath), pe.patientId, pe.num, "wav");
  sessionPath(jsonPath, sizeof(jsonPath), pe.patientId, pe.num, "json");

  File wf = SD_MMC.open(wavPath, FILE_READ);
  if (!wf) {
    statusErr("send_session", "session not found");
    return;
  }
  size_t total = wf.size();

  // meta = raw contents of the metadata json (or a minimal fallback)
  char meta[1024] = "{}";
  File jf = SD_MMC.open(jsonPath, FILE_READ);
  if (jf) {
    size_t m = jf.read((uint8_t *)meta, sizeof(meta) - 1);
    meta[m] = '\0';
    jf.close();
  }

  setStatus("Sending session to app (Bluetooth)...");
  char head[1200];
  int n = tableIdx + 1;
  snprintf(head, sizeof(head), "{\"ev\":\"file\",\"n\":%d,\"bytes\":%lu,\"meta\":%s}",
           n, (unsigned long)total, meta);
  statusNotify(head);

  // Stream the WAV: each 4 KB block is one framed message on CHAR_DATA;
  // the app concatenates the blocks and rebuilds the file.
  while (wf.available() && bleClientConnected) {
    size_t got = wf.read(ioChunk, sizeof(ioChunk));
    if (!got) break;
    notifyFramed(chData, ioChunk, got);
  }
  wf.close();

  char done[48];
  snprintf(done, sizeof(done), "{\"ev\":\"file_done\",\"n\":%d}", n);
  statusNotify(done);
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
      statusNotify("{\"ev\":\"state\",\"state\":\"registering\"}");
      snprintf(ipText, sizeof(ipText), "%s", WiFi.localIP().toString().c_str());
      setStatus("Wi-Fi connected - registering with SATE...");
      provState = PROV_REGISTER;
      return;
    }
    // Fast fail when the SSID simply is not on air - no point waiting 28 s.
    if (st == WL_NO_SSID_AVAIL) {
      statusNotify("{\"ev\":\"state\",\"state\":\"error\",\"msg\":\"Network not found - check the Wi-Fi name\"}");
      WiFi.disconnect(true);
      esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
      setStatus("Network not found");
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
      provState = PROV_IDLE;
      return;
    }
    // One re-issue of begin() in case the first was swallowed by BLE coexistence.
    if (!provRetried && millis() > provRetryAt) {
      provRetried = true;
      Serial.println("[CONN] Wi-Fi stalled - retrying begin()");
      WiFi.disconnect(false);
      WiFi.begin(provSsid, provPass);
    }
    if (millis() > provDeadline) {
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
      provState = PROV_IDLE;
    }
    return;
  }

  if (provState == PROV_REGISTER) {
    char body[256], resp[256];
    snprintf(body, sizeof(body), "{\"serial\":\"%s\",\"claim_token\":\"%s\",\"fw\":\"%s\"}",
             serialStr, provClaim, fwVersion);
    // register before we have a device key; server allows this route unauthenticated
    char url[192];
    snprintf(url, sizeof(url), "%s/api/devices/register", provServer);
    WiFiClient plain;
    WiFiClientSecure tls;
    bool useTls = strstr(provServer, "supabase.co") != nullptr;
    if (useTls) tls.setInsecure();
    WiFiClient &client = useTls ? static_cast<WiFiClient &>(tls) : plain;
    HTTPClient http;
    http.setTimeout(8000);
    bool ok = false;
    if (http.begin(client, url)) {
      http.addHeader("Content-Type", "application/json");
      if (useTls) http.addHeader("apikey", SUPABASE_ANON_KEY);
      int code = http.POST((uint8_t *)body, strlen(body));
      Serial.printf("[CONN] register code=%d freeHeap=%u maxAlloc=%u\n",
                    code, (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMaxAllocHeap());
      if (code >= 200 && code < 300) {
        JsonDocument doc;
        if (deserializeJson(doc, http.getString()) == DeserializationError::Ok) {
          snprintf(cfgSsid, sizeof(cfgSsid), "%s", provSsid);
          snprintf(cfgPass, sizeof(cfgPass), "%s", provPass);
          snprintf(cfgServer, sizeof(cfgServer), "%s", provServer);
          snprintf(cfgDeviceId, sizeof(cfgDeviceId), "%s", (const char *)(doc["device_id"] | ""));
          snprintf(cfgDeviceKey, sizeof(cfgDeviceKey), "%s", (const char *)(doc["device_key"] | ""));
          saveConfig();
          ok = true;
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
      // stay in BLE until the app disconnects; then Wi-Fi mode takes over
    } else {
      statusNotify("{\"ev\":\"state\",\"state\":\"error\",\"msg\":\"Server registration failed\"}");
      setStatus("Server registration failed");
    }
    // Connect + register done; hand the radio back to balanced coexistence.
    esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
    provState = PROV_IDLE;
  }
}

static void handleBleOp(const char *json)
{
  JsonDocument doc;
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
    WiFi.disconnect(false);          // clear any half-open association
    WiFi.begin(provSsid, provPass);
    provDeadline = millis() + WIFI_PROV_TIMEOUT_MS;
    provRetryAt  = millis() + WIFI_PROV_RETRY_MS;
    provRetried  = false;
    provState = PROV_WIFI;

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
    int n = doc["n"] | 0;
    if (n >= 1 && n <= pendCount) {
      writeSyncMarker(pendTable[n - 1].patientId, pendTable[n - 1].num);
      statusOk("mark_synced");
      sateHookConnChanged();
    } else {
      statusErr("mark_synced", "unknown session");
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
  } else if (!strcmp(op, "reload_patients")) {
    fetchPatients();
  } else if (!strcmp(op, "record")) {
    sateHookRecord();        // loop() runs the capture when the UI is idle
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
  char path[200];
  static char tmp[256];
  snprintf(path, sizeof(path), "/api/devices/%s/commands?pending=%d&state=%s&fw=%s&ota=%s",
           cfgDeviceId, pendCount, liveState, fwVersion, otaPhase);
  httpJson("GET", path, nullptr, tmp, sizeof(tmp), nullptr);
}

// then reboot into it. Blocking; runs on the connLoop task during a command
// poll. ESP32 keeps the old slot, so a bad image that fails to boot rolls back.
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
  Serial.printf("[OTA] start ver=%s url=%s\n", version ? version : "?", url);
  // Report progress/failure reasons via ota phase so the dashboard/DB shows them
  // even when no serial is attached. "dl" = entered, downloading.
  snprintf(otaPhase, sizeof(otaPhase), "dl");
  pushHeartbeatState();

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
    snprintf(otaPhase, sizeof(otaPhase), "err-get%d", code); pushHeartbeatState();
    http.end();
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

  WiFiClient *stream = http.getStreamPtr();
  size_t written = Update.writeStream(*stream);
  http.end();

  // With a known length, the write must match it; with unknown length, just
  // require some bytes. A mismatch is usually a dropped TLS stream.
  bool shortWrite = (len > 0) ? (written != (size_t)len) : (written == 0);
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
  rebootAtMs = millis() + 600;          // let the ack flush, then boot new image
}

// Fast path: report pending(cached)+state and run any queued commands. No SD
// access, so it is cheap enough to run every few seconds for snappy control.
static void pollCommands()
{
  // static resp: keeps 1 KB off the loop-task stack (single-threaded connLoop).
  char path[200];
  static char resp[1024];
  // Report fw + ota phase every heartbeat so the dashboard learns the running
  // version (and shows update progress) without a separate endpoint.
  snprintf(path, sizeof(path), "/api/devices/%s/commands?pending=%d&state=%s&fw=%s&ota=%s",
           cfgDeviceId, pendCount, liveState, fwVersion, otaPhase);
  if (!httpJson("GET", path, nullptr, resp, sizeof(resp), nullptr)) return;
  JsonDocument doc;
  if (deserializeJson(doc, resp) != DeserializationError::Ok) return;
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
  for (JsonVariant v : doc["commands"].as<JsonArray>()) {
    const char *op = v.as<const char *>();
    if (op && !strcmp(op, "ota")) {
      if (!ota.isNull()) runOtaUpdate(ota["url"] | "", ota["version"] | "");
      else               statusErr("ota", "no payload");
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

  if (rebootRequested && now > rebootAtMs) {
    Serial.println("[CONN] rebooting");
    delay(100);
    ESP.restart();
  }

  // BLE op ready?
  if (opLen > 0) {
    static char job[6144];
    portENTER_CRITICAL(&opMux);
    size_t len = opLen;
    memcpy(job, opBuf, len);
    job[len] = '\0';
    opLen = 0;
    portEXIT_CRITICAL(&opMux);
    handleBleOp(job);
  }

  // Async Wi-Fi scan result collection (started by the scan_wifi op).
  if (scanInProgress) {
    int found = WiFi.scanComplete();
    bool deadlineHit = now >= scanDeadline;
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
      } else if (now > wifiDeadline) {
        Serial.println("[CONN] Wi-Fi unavailable -> BLE mode");
        WiFi.disconnect(true);
        enterBleMode();
      }
      break;

    case CONN_WIFI_ONLINE:
      if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[CONN] Wi-Fi lost -> BLE mode");
        enterBleMode();
        break;
      }
      if (now > nextCmdPoll) {
        nextCmdPoll = now + CMD_POLL_PERIOD_MS;
        sateHookGuiPump();       // paint a fresh frame before the blocking poll
        pollCommands();          // picks up app commands within ~12 s
        sateHookGuiPump();       // repaint immediately so touch feels responsive
      }
      if (now > nextHeartbeat) {
        nextHeartbeat = now + HEARTBEAT_PERIOD_MS;
        scanPending();           // slow: refresh the cached pending count
      }
      if (patientsFetchDue) {
        patientsFetchDue = false;
        fetchPatients();
      }
      if (upActive) {
        // Send ONE slice this pass, then return to loop() - GUI + command poll
        // keep running, so a big upload doesn't make the device feel laggy.
        uploadStep();
      } else if (uploadSweepDue) {
        scanPending();
        if (pendCount > 0) {
          if (!beginUpload(pendTable[0])) uploadSweepDue = false; // can't open; stop
        } else {
          uploadSweepDue = false; // nothing left to send
        }
      }
      break;

    case CONN_BLE_ADV:
    case CONN_BLE_CONNECTED:
      mode = bleClientConnected ? CONN_BLE_CONNECTED : CONN_BLE_ADV;
      if (!bleClientConnected) {
        // after a successful provisioning the app disconnects; go online
        if (provisioned && WiFi.status() == WL_CONNECTED) {
          enterWifiOnline();
          break;
        }
        if (provisioned && now > nextWifiRetry) {
          nextWifiRetry = now + WIFI_RETRY_PERIOD_MS;
          enterWifiTrying(); // BLE keeps advertising during the attempt
          break;
        }
        if (now > nextAdvRefresh) {
          nextAdvRefresh = now + ADV_REFRESH_PERIOD_MS;
          scanPending();
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
  return (uint32_t)scanPending();
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
  // Push it right away when online so the app sees the change instantly.
  // (pollCommands() no-ops if Wi-Fi is down.)
  if (mode == CONN_WIFI_ONLINE) pollCommands();
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
