// SATE Recorder connectivity implementation. See connectivity.h.
//
// Threading model: NimBLE callbacks only copy bytes into buffers and set
// flags; ALL real work (JSON ops, SD access, Wi-Fi, HTTP, notifications)
// runs from connLoop(), which the sketch calls from loop(). This mirrors
// the touch-callback rule used by the UI.

#include "connectivity.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
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
static const uint32_t HEARTBEAT_PERIOD_MS   = 15000;
static const uint32_t ADV_REFRESH_PERIOD_MS = 30000;

// ---- state -------------------------------------------------------------------

static ConnMode   mode = CONN_OFF;
static char       fwVersion[40]  = "0.5.0";
static char       serialStr[16]  = "SATE-000000";
static bool       provisioned    = false;
static char       cfgSsid[33]    = "";
static char       cfgPass[65]    = "";
static char       cfgServer[96]  = "";
static char       cfgDeviceId[48] = "";
static char       cfgDeviceKey[64] = "";

static Preferences prefs;

static uint32_t wifiDeadline   = 0;
static uint32_t nextWifiRetry  = 0;
static uint32_t nextHeartbeat  = 0;
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

// Scan all patient dirs for WAVs without a .synced marker.
static int scanPending()
{
  pendCount = 0;
  File root = SD_MMC.open("/sate/patients");
  if (!root) return 0;
  File entry;
  while ((entry = root.openNextFile()) && pendCount < (int)(sizeof(pendTable) / sizeof(pendTable[0]))) {
    if (!entry.isDirectory()) { entry.close(); continue; }
    const char *full = entry.name(); // basename or full path depending on core
    const char *pid = strrchr(full, '/');
    pid = pid ? pid + 1 : full;
    char wav[160], mark[160];
    for (uint32_t i = 1; i <= 9999; i++) {
      sessionPath(wav, sizeof(wav), pid, i, "wav");
      if (!SD_MMC.exists(wav)) break;
      sessionPath(mark, sizeof(mark), pid, i, "synced");
      if (SD_MMC.exists(mark)) continue;
      File f = SD_MMC.open(wav, FILE_READ);
      uint32_t bytes = f ? (uint32_t)f.size() : 0;
      if (f) f.close();
      PendingEntry &pe = pendTable[pendCount++];
      snprintf(pe.patientId, sizeof(pe.patientId), "%s", pid);
      pe.num = i;
      pe.bytes = bytes;
      if (pendCount >= (int)(sizeof(pendTable) / sizeof(pendTable[0]))) break;
    }
    entry.close();
  }
  root.close();
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
}

// ---- base64 -----------------------------------------------------------------

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static size_t b64Encode(const uint8_t *in, size_t len, char *out)
{
  size_t o = 0;
  for (size_t i = 0; i < len; i += 3) {
    uint32_t v = in[i] << 16;
    if (i + 1 < len) v |= in[i + 1] << 8;
    if (i + 2 < len) v |= in[i + 2];
    out[o++] = B64[(v >> 18) & 63];
    out[o++] = B64[(v >> 12) & 63];
    out[o++] = (i + 1 < len) ? B64[(v >> 6) & 63] : '=';
    out[o++] = (i + 2 < len) ? B64[v & 63] : '=';
  }
  out[o] = '\0';
  return o;
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

static bool httpJson(const char *method, const char *path, const char *body,
                     char *resp, size_t respSize, int *codeOut)
{
  if (WiFi.status() != WL_CONNECTED) return false;
  char url[192];
  snprintf(url, sizeof(url), "%s%s", cfgServer, path);

  WiFiClient client;
  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(client, url)) return false;
  http.addHeader("Content-Type", "application/json");
  if (cfgDeviceKey[0]) {
    char auth[80];
    snprintf(auth, sizeof(auth), "Bearer %s", cfgDeviceKey);
    http.addHeader("Authorization", auth);
  }
  int code = body ? http.sendRequest(method, (uint8_t *)body, strlen(body))
                  : http.sendRequest(method);
  if (codeOut) *codeOut = code;
  bool ok = code >= 200 && code < 300;
  if (ok && resp && respSize) {
    String s = http.getString();
    snprintf(resp, respSize, "%s", s.c_str());
  }
  http.end();
  return ok;
}

// Upload one pending session. WAV + base64 buffers live in PSRAM.
static bool uploadSession(const PendingEntry &pe)
{
  char wavPath[160], jsonPath[160];
  sessionPath(wavPath, sizeof(wavPath), pe.patientId, pe.num, "wav");
  sessionPath(jsonPath, sizeof(jsonPath), pe.patientId, pe.num, "json");

  File wf = SD_MMC.open(wavPath, FILE_READ);
  if (!wf) return false;
  size_t wavLen = wf.size();

  uint8_t *wav = (uint8_t *)heap_caps_malloc(wavLen, MALLOC_CAP_SPIRAM);
  size_t b64Cap = ((wavLen + 2) / 3) * 4 + 8;
  char *body = (char *)heap_caps_malloc(b64Cap + 512, MALLOC_CAP_SPIRAM);
  if (!wav || !body) {
    if (wav) free(wav);
    if (body) free(body);
    wf.close();
    Serial.println("[CONN] upload: PSRAM alloc failed");
    return false;
  }
  size_t got = wf.read(wav, wavLen);
  wf.close();
  if (got != wavLen) { free(wav); free(body); return false; }

  // session_number / sample_rate from the metadata JSON (defaults if absent)
  uint32_t sessionNumber = pe.num, sampleRate = 16000;
  File jf = SD_MMC.open(jsonPath, FILE_READ);
  if (jf) {
    JsonDocument meta;
    if (deserializeJson(meta, jf) == DeserializationError::Ok) {
      sessionNumber = meta["session_number"] | pe.num;
      sampleRate    = meta["sample_rate"] | 16000;
    }
    jf.close();
  }

  int n = snprintf(body, 512,
                   "{\"device_serial\":\"%s\",\"patient_id\":\"%s\","
                   "\"session_number\":%lu,\"sample_rate\":%lu,\"wav_base64\":\"",
                   serialStr, pe.patientId,
                   (unsigned long)sessionNumber, (unsigned long)sampleRate);
  size_t o = (size_t)n;
  o += b64Encode(wav, wavLen, body + o);
  body[o++] = '"';
  body[o++] = '}';
  body[o] = '\0';
  free(wav);

  int code = 0;
  bool ok = httpJson("POST", "/api/sessions", body, nullptr, 0, &code);
  free(body);

  if (ok) {
    writeSyncMarker(pe.patientId, pe.num);
    Serial.printf("[CONN] uploaded %s session %lu\n", pe.patientId, (unsigned long)pe.num);
  } else {
    Serial.printf("[CONN] upload failed (HTTP %d)\n", code);
  }
  return ok;
}

static void fetchPatients()
{
  char resp[2048];
  if (!httpJson("GET", "/api/patients", nullptr, resp, sizeof(resp), nullptr)) return;
  File f = SD_MMC.open("/sate/patients.json", FILE_WRITE);
  if (f) {
    f.print(resp);
    f.close();
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
  nextHeartbeat = 0;       // heartbeat immediately
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
    WiFiClient client;
    HTTPClient http;
    http.setTimeout(8000);
    bool ok = false;
    if (http.begin(client, url)) {
      http.addHeader("Content-Type", "application/json");
      int code = http.POST((uint8_t *)body, strlen(body));
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

  } else if (!strcmp(op, "identify")) {
    statusOk("identify");
    sateHookIdentify();

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
  } else if (!strcmp(op, "identify")) {
    sateHookIdentify();
  } else if (!strcmp(op, "reboot")) {
    rebootRequested = true;
    rebootAtMs = millis() + 300;
  }
}

static void heartbeat()
{
  scanPending();
  char path[128], resp[1024];
  snprintf(path, sizeof(path), "/api/devices/%s/commands?pending=%d", cfgDeviceId, pendCount);
  if (!httpJson("GET", path, nullptr, resp, sizeof(resp), nullptr)) return;
  JsonDocument doc;
  if (deserializeJson(doc, resp) != DeserializationError::Ok) return;
  for (JsonVariant v : doc["commands"].as<JsonArray>()) {
    runRemoteCommand(v.as<const char *>());
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
      if (now > nextHeartbeat) {
        nextHeartbeat = now + HEARTBEAT_PERIOD_MS;
        heartbeat();
      }
      if (patientsFetchDue) {
        patientsFetchDue = false;
        fetchPatients();
      }
      if (uploadSweepDue) {
        // one session per loop pass keeps the UI responsive between files
        scanPending();
        if (pendCount > 0) {
          setStatus("Uploading session to SATE...");
          uploadSession(pendTable[0]);
          setStatus("Online (Wi-Fi) - %s", ipText);
        } else {
          uploadSweepDue = false;
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
bool connProvisioned() { return provisioned; }

uint32_t connPendingTotal()
{
  return (uint32_t)scanPending();
}

const char *connStatusText() { return statusText; }
const char *connIp() { return ipText; }
bool connSetupActive() { return bleClientConnected || provState != PROV_IDLE; }

void connNotifyNewSession()
{
  if (mode == CONN_WIFI_ONLINE) uploadSweepDue = true;
  else if (bleInited && !bleClientConnected) {
    scanPending();
    bleUpdateAdvertising();
  }
}
