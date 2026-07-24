/*
 * SATE Clinical Recorder (v0.5.0 - Wi-Fi + BLE companion connectivity)
 * Target: Freenove ESP32-S3 Display 2.8" FNK0104AB 240x320 ILI9341
 *
 * Product concept:
 *   A handheld recorder a Speech-Language Pathologist carries into a session.
 *   The SLP picks the assigned patient, records the speech sample, reviews
 *   sessions on-device, then taps "Sync to SATE". The device simulates the
 *   upload to SATE Cloud and the AI analysis (transcription metrics:
 *   mispronunciation, filler words, grammar, speech rate WPM) and shows a
 *   SATE-style results card. Everything is OFFLINE - the sync and analysis
 *   are simulated for demo purposes only.
 *
 * Screens:
 *   Boot      - logo pop-in, tagline, spinner, live init checklist
 *               (Display & touch -> SD card -> Audio codec -> SATE services)
 *   Home      - patient card, status, [Record] [Next] / [Sessions] [Sync]
 *   Recording - full-screen countdown ring (streamed to SD)
 *   Sessions  - list of recorded sessions for the patient, tap to play back
 *   Sync      - pending-session count, [Transfer to SATE] simulated upload
 *   Results   - SATE analysis card (demo metrics), [Done]
 *
 * Memory / stability design (unchanged from v0.2.x):
 *   - Recording streamed mic -> static 4 KB chunk -> SD (no big mallocs)
 *   - Playback streamed SD -> same 4 KB chunk -> I2S
 *   - No Arduino String in hot paths (fixed char buffers)
 *   - [MEM] heap telemetry on serial
 *   - LVGL double-buffered DMA draw buffers (display.cpp)
 *   - Session numbering scans SD; reboots never overwrite files
 *
 * Connectivity (v0.5.0, see connectivity.h):
 *   - Wi-Fi mode: auto-uploads sessions to the SATE server, polls remote
 *     commands (sync_now / reload_patients / record / reboot)
 *   - BLE mode: when Wi-Fi is unavailable, advertises to the companion app
 *     for provisioning, bridge sync, and nearby control
 *   - Patient list is loaded from /sate/patients.json when the server (or
 *     the app over BLE) pushes one; built-in demo patients otherwise.
 *
 * No BOOT button required.
 */

#define FNK0104AB_2P8_240x320_ILI9341

#include <Arduino.h>
#include <FS.h>
#include <SD_MMC.h>
#include <Wire.h>
#include <Preferences.h>
#include "esp_heap_caps.h"
#include "esp_random.h"
#include "esp_sleep.h"        // low-battery deep-sleep guard (fw 1.5.3)
#include "esp_system.h"       // esp_reset_reason(): self-explaining reboots
#include "esp_ota_ops.h"      // running-slot label in the boot banner / DIAG
#if __has_include("esp_core_dump.h")
#include "esp_core_dump.h"    // crash summary (task + PC) after a panic reboot
#define SATE_HAS_COREDUMP 1
#endif
#include "driver/rtc_io.h"    // RTC pull-up so the wake button doesn't float

#include <ArduinoJson.h>

#include "display.h"
#include "sate_logo_white.h"
#include "ESP_I2S.h"
#include "es8311.h"
#include "connectivity.h"

// -----------------------------------------------------------------------------
// Freenove FNK0104AB pins
// -----------------------------------------------------------------------------

#define SD_MMC_CMD 40
#define SD_MMC_CLK 38
#define SD_MMC_D0  39
#define SD_MMC_D1  41
#define SD_MMC_D2  48
#define SD_MMC_D3  47

#define I2S_MCK   4
#define I2S_BCK   5
#define I2S_DINT  6
#define I2S_DOUT  8
#define I2S_WS    7

#define AP_ENABLE 1
#define I2C_SCL   15
#define I2C_SDA   16
#define I2C_SPEED 400000
#define BOOT_BTN_PIN 0          // on-board BOOT button (GPIO0), active LOW
#define BAT_ADC_PIN  9          // battery sense (GPIO9, ADC1) behind on-board 0.5 divider
                                // FNK0104AB 2.8" ESP32-S3 board (per Freenove ch.5)

// Two external push buttons for the demo (active LOW, INPUT_PULLUP, wired to GND).
// Free pins on the FNK0104AB: GPIO2/14 don't collide with SD (38-41,47,48),
// audio (4-8), I2C (15,16), TFT (10-13,45,46), touch (17,18), AP_ENABLE (1),
// BAT (9) or BOOT (0). GPIO2 is NOT an S3 strapping pin (those are 0/3/45/46),
// so it's the cleanest free choice for RECORD.
//   RECORD: short press toggles record/stop; off Home it returns to Home.
//   FLAG:   while recording, marks an important moment at the current timestamp.
#define REC_BTN_PIN  2          // external RECORD button (GPIO2: free, not a strap pin)
#define FLAG_BTN_PIN 14         // external FLAG button

// Debounced edge-detector state for an external button. Declared up here (above
// the first function) so the Arduino auto-generated prototype for btnPressed()
// can see the type.
struct Btn { uint8_t pin; bool pressed; uint32_t tEdge; };

static const int      SERIAL_BAUD       = 115200;
static const int      RECORD_SECONDS    = 30;
static const int      REMOTE_RECORD_SECONDS = 8; // app/server-triggered captures
// Recording runs until the SLP taps Stop. Both the capture loop and the upload
// now feed the watchdog + service the GUI as they go, so length no longer
// reboots or freezes the board; this is just a generous safety ceiling (30 min)
// so a forgotten session can't fill the SD card.
static const int      RECORD_MAX_SECONDS = 3700; // ~62 min safety ceiling
static const uint32_t AUDIO_SAMPLE_RATE = 16000;
static const int      AUDIO_BIT_DEPTH   = 16;
static const int      AUDIO_CHANNELS    = 1;
static const char    *FIRMWARE_VERSION  = "1.5.30";   // offline crash-resume starts the net task before blocking, so a take resumed with Wi-Fi down stays stoppable (heartbeat/BLE/OTA-confirm)

// The loop task runs LVGL + connectivity (NimBLE deinit, HTTPClient, JSON) in
// one stack. The default 8 KB overflows on the Wi-Fi-online path (HTTP fetch of
// the patient roster + parse), crashing with a corrupted backtrace right after
// "Connecting to Wi-Fi". Give it room.
SET_LOOP_TASK_STACK_SIZE(16 * 1024);

static const uint32_t PCM_BYTES_PER_SEC = AUDIO_SAMPLE_RATE * (AUDIO_BIT_DEPTH / 8) * AUDIO_CHANNELS;
static const uint32_t PCM_TOTAL_BYTES   = PCM_BYTES_PER_SEC * RECORD_SECONDS;
static const uint32_t PCM_MAX_BYTES     = PCM_BYTES_PER_SEC * RECORD_MAX_SECONDS;

// A recording is written as a chain of 1-minute segment files
// (session_NNNN.part00.wav, .part01.wav, ...) and merged into the final
// session_NNNN.wav when it ends. Each finished minute is safely on the SD card,
// so a crash/power-loss mid-session only loses the current minute - the rest is
// recovered + merged on the next boot.
static const int      SEGMENT_SECONDS   = 60;
static const uint32_t PCM_SEGMENT_BYTES = PCM_BYTES_PER_SEC * SEGMENT_SECONDS;

// The ONLY audio working memory: one static 4 KB chunk, reused everywhere.
static const size_t AUDIO_CHUNK_BYTES = 4096;
static uint8_t audioChunk[AUDIO_CHUNK_BYTES];

// -----------------------------------------------------------------------------
// Theme (white clinical, matches sate website palette)
// -----------------------------------------------------------------------------

#define COL_BG          0xFFFFFF
#define COL_TEXT_DARK   0x111827
#define COL_TEXT_MUTED  0x6B7280
#define COL_PRIMARY     0x0284C7
#define COL_PRIMARY_DK  0x075985
#define COL_PRIMARY_BG  0xE0F2FE
#define COL_CARD_BG     0xF8FAFC
#define COL_CARD_BORDER 0xE2E8F0
#define COL_OK          0x059669
#define COL_OK_BG       0xD1FAE5
#define COL_REC         0xDC2626
#define COL_REC_BG      0xFEE2E2
#define COL_WARN        0xB45309
#define COL_WARN_BG     0xFEF3C7
#define COL_TRACK       0xE5E7EB

// -----------------------------------------------------------------------------
// Assigned patients. No firmware defaults - the roster is empty until the SATE
// server (over Wi-Fi) or the companion app (over BLE set_patients) writes
// /sate/patients.json. Only the patients currently under test are kept; the
// cap is deliberately small to keep RAM use low.
// -----------------------------------------------------------------------------

struct SatePatient {
  char patientId[20];
  char displayName[48];
  char age[16];
  char sessionType[36];
  char clinician[36];
};

static const int  MAX_PATIENTS = 6;
static SatePatient g_patients[MAX_PATIENTS];   // zero-initialised: empty roster
static int g_patientCount = 0;
static int currentPatientIndex = 0;
// True while the only roster entry is the synthetic "Standalone" patient seeded
// by ensureStandalonePatient(). Cleared as soon as a real patient is pushed.
static bool g_standalonePatient = false;

// -----------------------------------------------------------------------------
// Real sync summary (filled after sessions are uploaded to the SATE server).
// -----------------------------------------------------------------------------

struct SyncSummary {
  char     patientName[48];
  int      uploaded;       // sessions sent this run
  uint32_t totalSec;       // combined audio duration uploaded
};

static SyncSummary lastSync = {"", 0, 0};

// -----------------------------------------------------------------------------
// App state
// -----------------------------------------------------------------------------

enum DeviceState {
  BOOTING,
  ONBOARDING,    // gate: shown until the device is set up (claimed + has patients)
  HOME,
  RECORDING,
  SAVING_TO_SD,
  PLAYING,
  SESSIONS,
  SYNC,
  SYNCING,
  RESULTS,
  CONNECTION,
  ERROR_STATE
};

static DeviceState currentState = BOOTING;

// Touch callbacks only set a pending action; loop() dispatches it.
enum PendingAction {
  ACT_NONE = 0,
  ACT_RECORD,
  ACT_NEXT_PATIENT,
  ACT_OPEN_SESSIONS,
  ACT_OPEN_SYNC,
  ACT_BACK_HOME,
  ACT_RUN_SYNC,
  ACT_PLAY_SESSION,   // pendingArg = session number
  ACT_DELETE_SESSION, // pendingArg = session number
  ACT_RESULTS_DONE,
  ACT_OPEN_CONN       // tap the header connectivity icon
};

static volatile PendingAction pendingAction = ACT_NONE;
static volatile int           pendingArg    = 0;

// Connectivity hook flags: set from connLoop() handlers, consumed by loop().
static volatile bool connPatientsReq = false;
static volatile bool connStateReq    = false;
static volatile bool connRecordReq   = false;
static volatile bool connStopReq     = false;  // app/server asked to STOP an in-progress take
static volatile bool recTakeArmed    = false;  // a take is starting or running: a remote stop applies to it
static bool     g_resumePending = false;       // an interrupted take is waiting to be resumed from loop()
static uint32_t g_bootMs        = 0;           // millis() at the end of setup()

// Patient the SLP typed in the app for the next remote recording, delivered in
// the /commands poll. Staged here and applied by loop() (UI task) so we never
// touch g_patients from the connLoop task.
static volatile bool connActivePatientReq = false;
static SatePatient   g_activePatientReq;

// Upload-progress overlay state, set by the net task (core 0) and rendered by
// loop() (core 1). The upload hooks must not call LVGL directly anymore - they'd
// be touching the GUI from the wrong core. loop() shows/updates/hides the overlay
// from these flags.
static volatile bool connUploadUiActive = false;   // true while an upload is in flight
static volatile int  connUploadUiPct    = 0;        // 0-100


// -----------------------------------------------------------------------------
// Forward declarations (explicit) — do NOT remove.
// arduino-cli's auto prototype-generator strips the return type from static
// function prototypes on some toolchains (see GitHub issue #2), which breaks the
// build with dozens of -fpermissive errors. Declaring every top-level function
// here suppresses that generation and makes the build toolchain-independent.
// -----------------------------------------------------------------------------
static void finalizeSavedSession(const char *wavPath, const char *jsonPath, uint32_t sessionNum, uint32_t pcmBytes);
static void applyActivePatient();
static void ensureStandalonePatient();
static void selectPatientIndex(int idx);
static void uiResetPointers();
static void logHeap(const char *tag);
static void runGui();
static void pumpGuiMs(unsigned long durationMs);
static void backlightSet(uint8_t duty);
static void backlightInit();
static void wakeScreen();
static void serviceScreenDim();
static void setScreenWhite();
static void setStatePill(const char *text, uint32_t bg, uint32_t fg);
static inline void setFont(lv_obj_t *o, const lv_font_t *f);
static void styleButton(lv_obj_t *btn, uint32_t bgColor, uint32_t textColor);
static void stylePanel(lv_obj_t *panel);
static void actionEvent(lv_event_t *e);
static void recordStopEvent(lv_event_t *e);
static bool btnPressed(Btn &b);
static void loadTotalRecordings();
static void bumpTotalRecordings();
static void recCrashMark(const char *patientId, uint32_t sessionNum, uint32_t pcmCap);
static void recCrashClear();
static bool recCrashMarkPresent();
static void updateConnBadge();
static void hideProgressOverlay();
static void showSavingOverlay();
static void hideSavingOverlay();
static void updateProgress(uint16_t permille, const char *bigText);
void sateHookUploadBegin();
void sateHookUploadProgress(int pct);
void sateHookUploadEnd();
static void renderUploadOverlay();
static void bootScreenCreate();
static void bootStepBegin(int i);
static void bootStepDone(int i, bool ok);
static void bootScreenFail(const char *msg);
static void bootScreenFinish();
static bool ensureDir(const char *path);
static bool initSdCard();
static void loadPatientsFromSd();
static void patientDirPath(char *out, size_t outSize);
static void sessionWavPath(char *out, size_t outSize, const char *dir, uint32_t n);
static void sessionJsonPath(char *out, size_t outSize, const char *dir, uint32_t n);
static void sessionSyncMarkPath(char *out, size_t outSize, const char *dir, uint32_t n);
static void sessionPartPath(char *out, size_t outSize, const char *finalWav, int part);
// Session numbers live in 1..SESSION_NUM_MAX. They are allocated monotonically
// and NEVER renumbered: a delete removes only that session's own files, so a
// patient dir holds an arbitrary subset of numbers (holes are normal).
static const uint32_t SESSION_NUM_MAX = 99;
static bool sessionExists(const char *dir, uint32_t n);
static void deleteSessionFiles(const char *dir, uint32_t n);
static void scanSessionNumbers(const char *dir, bool *present, bool *audio = nullptr);
static bool sessionHasAudio(const char *dir, uint32_t n);
static void clearSessionTombstone(const char *dir, uint32_t n);
static uint32_t findNextSessionIndex(const char *dir);
static void sdRefreshUsage(bool force);
static void sdInvalidateUsageCache();
static uint8_t sdUsedPercent();
static uint64_t sdFreeBytes();
static bool sdProbe();
static bool sdRemount();
static int readBatteryMv();
static uint8_t batteryPercent();
static const char *batterySymbol(uint8_t pct);
static bool isUsbCharging();
static void enterBatterySleep(bool quiet = false);
static void serviceBatteryGuard();
static void batteryBootGuard();
static bool isSessionSynced(const char *dir, uint32_t n);
static uint32_t countUnsynced(const char *dir);
static void markSessionSynced(const char *dir, uint32_t n);
static void jsonEscapeToBuf(const char *value, char *out, size_t outSize);
static void writeWavHeader(File &file, uint32_t pcmBytes);
static void patchWavHeader(File &file, uint32_t pcmBytes);
static uint32_t mergeSessionParts(const char *finalWav, bool pumpUi);
static void recoverOrphanSegments();
static bool initAudio();
static bool playWavStreamFromSd(const char *path, const char *caption);
static bool playSessionAudio(const char *dir, uint32_t n, const char *caption);
static void refreshHomeUpload();
static void refreshSessionsUpload();
static void onboardStepRow(lv_obj_t *parent, int idx, const char *text, int state);
static void showOnboardingScreen();
static void showHomeScreen();
static void showSessionsScreen();
static void showConnectionScreen();
static void showSyncScreen();
static void runSync();
static void showResultsScreen();
static int prepareResumeSegments(const char *wavPath, uint32_t *outBytes);
static void maybeResumeRecording();
static void playSessionFromList(int sessionNum);
static void serviceFactoryResetButton();
void setup();
void loop();
void sateHookPatientsUpdated();
void sateHookConnChanged();
void sateHookRecord();
void sateHookStop();
bool sateHookTakeActive();
void sateHookGuiPump();
static bool deviceReady();
static void isrRecBtn();
static void isrFlagBtn();

void sateHookPatientsUpdated() { connPatientsReq = true; }
void sateHookConnChanged()     { connStateReq = true; }
// A remote "record" that arrives while a take is ALREADY armed/running is
// DROPPED, never latched: the operator was acting on stale state (a
// button-started take used to report state=idle), and a latched request fired
// an unwanted, unattended second take the instant the first one ended -
// running to the ~62-minute ceiling with nobody at the device.
void sateHookRecord()
{
  if (recTakeArmed) {
    Serial.println("[REC] remote record dropped - a take is already in progress");
    return;
  }
  connRecordReq = true;
}
// [fw 1.5.19] Timed remote take: capture exactly `seconds` of PCM and stop by
// itself (byte-exact cap on the capture loop). Racing a remote "stop" through
// the poll channel added 3-12 s of slop on every timed test.
static volatile uint32_t connRecordSecs = 0;
void sateHookRecordTimed(uint32_t seconds)
{
  if (recTakeArmed) {
    Serial.println("[REC] remote timed record dropped - a take is already in progress");
    return;
  }
  connRecordSecs = seconds;
  connRecordReq = true;
}
// Only latch a stop while a take is armed, so a stop that arrives with nothing to
// stop cannot sit around and kill the NEXT take. Armed covers the whole start
// sequence (mark, status screen, GUI pump), not just the capture loop — a stop that
// lands in that window used to be dropped, which left a resumed take running for
// minutes with no way to end it.
void sateHookStop()
{
  if (recTakeArmed) { connStopReq = true; return; }
  // Not armed yet: a "stop" batched into the same poll response as a "record"
  // (SLP tapped Record then Stop inside one ~12 s poll window) arrives before
  // loop() has even started the take. Cancel the still-queued request instead
  // of discarding the stop — the recTakeArmed gate alone ate it, leaving an
  // unattended take running to the 62-minute ceiling.
  if (connRecordReq) { connRecordReq = false; connRecordSecs = 0; }
}
// The net task asks this before anything that would flash + reboot the unit
// (OTA): a take armed/running on the UI core must never be cut mid-capture.
bool sateHookTakeActive()      { return recTakeArmed; }
// sateHookGuiPump() is defined after the Display object below (it needs it).

void sateHookSetActivePatient(const char *id, const char *name, const char *age,
                              const char *sessionType, const char *clinician)
{
  if (!id || !id[0]) return;
  SatePatient &p = g_activePatientReq;
  snprintf(p.patientId,   sizeof(p.patientId),   "%s", id);
  snprintf(p.displayName, sizeof(p.displayName), "%s", (name && name[0]) ? name : id);
  snprintf(p.age,         sizeof(p.age),         "%s", (age && age[0]) ? age : "-");
  snprintf(p.sessionType, sizeof(p.sessionType), "%s", (sessionType && sessionType[0]) ? sessionType : "-");
  snprintf(p.clinician,   sizeof(p.clinician),   "%s", (clinician && clinician[0]) ? clinician : "-");
  connActivePatientReq = true;
}

// Make the app-typed patient the current one: refresh in place if already on
// the roster, otherwise append (or, if the small roster is full, replace the
// current slot). Runs only from loop() (UI task).
static void applyActivePatient()
{
  // An explicit assignment selects that patient. Standalone STAYS in the roster
  // so the user can go back to recording standalone reports without waiting for
  // the server to push anything.
  g_standalonePatient = false;
  for (int i = 0; i < g_patientCount; i++) {
    if (!strcmp(g_patients[i].patientId, g_activePatientReq.patientId)) {
      g_patients[i] = g_activePatientReq;
      selectPatientIndex(i);
      return;
    }
  }
  int idx = (g_patientCount < MAX_PATIENTS) ? g_patientCount++ : currentPatientIndex;
  g_patients[idx] = g_activePatientReq;
  selectPatientIndex(idx);
}

// Seed a single synthetic "Standalone" patient when the roster is empty so a
// freshly provisioned device is usable right away - no waiting for the server
// (or app) to assign a patient. Sessions upload with patient_id "Standalone";
// any real patient pushed later replaces this (see applyActivePatient /
// loadPatientsFromSd). Idempotent.
// Index of the standalone bucket in g_patients, or -1.
// The ONE place the active selection changes. Retention keys the live dir off
// this, and publishing it from anywhere else raced the selection: at boot
// ensureStandalonePatient() ran before loadPatientsFromSd() had chosen, so the
// live dir was still the previous patient and the sweep reclaimed the ACTIVE
// dir with keep=0.
static void selectPatientIndex(int idx)
{
  if (idx < 0 || idx >= g_patientCount) return;
  currentPatientIndex = idx;
  connSetActivePatientDir(g_patients[idx].patientId);
}

static int standaloneIndex()
{
  for (int i = 0; i < g_patientCount; i++)
    if (!strcmp(g_patients[i].patientId, "Standalone")) return i;
  return -1;
}

static void ensureStandalonePatient()
{
  if (standaloneIndex() >= 0) return;          // already in the roster
  int idx;
  if (g_patientCount >= MAX_PATIENTS) {
    // Roster is full of real patients (an account with >= MAX_PATIENTS is a
    // normal clinic). Standalone must STILL exist: returning here left
    // standaloneIndex() == -1, the selection fell back to slot 0, and every
    // standalone report was silently filed under a real patient's chart — while
    // Home showed no patient at all. The roster is only a cache of the server
    // list, so repurpose the last non-selected slot for the Standalone bucket;
    // the evicted patient can still be assigned from the app (which replaces a
    // slot itself) or returns on the next roster fetch's reserved-slot parse.
    idx = g_patientCount - 1;
    if (idx == currentPatientIndex && idx > 0) idx--;  // never evict the selection
  } else {
    idx = g_patientCount++;
  }
  SatePatient &p = g_patients[idx];
  snprintf(p.patientId,   sizeof(p.patientId),   "%s", "Standalone");
  snprintf(p.displayName, sizeof(p.displayName), "%s", "Standalone");
  snprintf(p.age,         sizeof(p.age),         "%s", "-");
  snprintf(p.sessionType, sizeof(p.sessionType), "%s", "Standalone");
  snprintf(p.clinician,   sizeof(p.clinician),   "%s", "-");
  // Standalone is the DEFAULT target: the recorder records standalone audio
  // reports unless someone explicitly assigns a patient. Only take the selection
  // if nothing is selected yet - never steal it from an explicit assignment.
  if (g_patientCount == 1) selectPatientIndex(idx);
  g_standalonePatient = (currentPatientIndex == idx);
}

// The recorder is usable once it has been claimed to a SATE account. Patient
// assignment is optional: without a roster the device records standalone (see
// ensureStandalonePatient). Until claimed the user sees the onboarding screen.
static bool deviceReady() { return connProvisioned(); }

Display  screen;
I2SClass es8311_i2s;

// Widget pointers for the CURRENT screen only. Every screen builder calls
// uiResetPointers() + lv_obj_clean(), so these never dangle.
static lv_obj_t *statePill       = nullptr;
static lv_obj_t *statePillText   = nullptr;
static lv_obj_t *patientCard     = nullptr;
static lv_obj_t *patientName     = nullptr;
static lv_obj_t *patientIdChip   = nullptr;
static lv_obj_t *patientRows     = nullptr;
static lv_obj_t *statusLabel     = nullptr;
static lv_obj_t *hintLabel       = nullptr;
static lv_obj_t *progressOverlay = nullptr;
static lv_obj_t *progressArc     = nullptr;
static lv_obj_t *progressBig     = nullptr;
static lv_obj_t *progressSmall   = nullptr;
static lv_obj_t *progressFlag    = nullptr; // "Flags: N" badge while recording
static lv_obj_t *syncBar         = nullptr;
static lv_obj_t *syncBarText     = nullptr;
static lv_obj_t *connIcon        = nullptr;
static lv_obj_t *resetBanner     = nullptr; // hold-BOOT-to-reset overlay

// Home upload status (always visible, refreshed live without rebuilding Home).
static lv_obj_t *homeUpBar       = nullptr;
static lv_obj_t *homeUpText      = nullptr;
static lv_obj_t *homeUpDot       = nullptr;
static lv_obj_t *homeBatText     = nullptr; // live battery % chip on Home

// Sessions list: per-row status badges, refreshed live for the uploading row.
// List scrolls, so track plenty of rows (one badge ptr + num each).
static const int  SESS_ROW_MAX   = 64;
static lv_obj_t  *sessRowBadge[SESS_ROW_MAX] = {nullptr};
static uint32_t   sessRowNum[SESS_ROW_MAX]   = {0};
static int        sessRowCount   = 0;
static char       sessRowPid[24] = "";

static void uiResetPointers()
{
  statePill = statePillText = nullptr;
  patientCard = patientName = patientIdChip = patientRows = nullptr;
  statusLabel = hintLabel = nullptr;
  progressOverlay = progressArc = progressBig = progressSmall = nullptr;
  syncBar = syncBarText = nullptr;
  connIcon = nullptr;
  resetBanner = nullptr; // screen rebuild deletes it; drop the dangling ptr
  homeUpBar = homeUpText = homeUpDot = nullptr;
  homeBatText = nullptr;
  for (int i = 0; i < SESS_ROW_MAX; i++) sessRowBadge[i] = nullptr;
  sessRowCount = 0;
}

// -----------------------------------------------------------------------------
// Memory telemetry
// -----------------------------------------------------------------------------

// Human name for esp_reset_reason(): printed at boot and in DIAG so a field
// reboot separates brownout (dying cell) / panic (fw bug) / task-wdt (wedge) /
// sw (OTA or remote reboot) at a glance.
static const char *resetReasonStr(esp_reset_reason_t r)
{
  switch (r) {
    case ESP_RST_POWERON:   return "poweron";
    case ESP_RST_EXT:       return "ext-pin";
    case ESP_RST_SW:        return "sw-restart";
    case ESP_RST_PANIC:     return "panic";
    case ESP_RST_INT_WDT:   return "int-wdt";
    case ESP_RST_TASK_WDT:  return "task-wdt";
    case ESP_RST_WDT:       return "other-wdt";
    case ESP_RST_DEEPSLEEP: return "deepsleep-wake";
    case ESP_RST_BROWNOUT:  return "brownout";
    case ESP_RST_SDIO:      return "sdio";
    default:                return "unknown";
  }
}

static void logHeap(const char *tag)
{
  Serial.printf(
    "[MEM] %-18s int free=%6u  largest=%6u  min=%6u  psram free=%u\n",
    tag,
    (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
    (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
    (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
    (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM)
  );
}

// -----------------------------------------------------------------------------
// GUI helpers
// -----------------------------------------------------------------------------

static void runGui()
{
  screen.routine();
  delay(2); // short yield: keeps touch polling snappy without starving RTOS
}

// Service the GUI for one tick from inside long connectivity work (big upload).
// No-op now: GUI is driven exclusively by loop() on core 1, and connLoop() runs
// on core 0 (the net task), which must never touch LVGL. Kept so connectivity's
// existing pump calls compile; loop() repaints on its own, uninterrupted.
void sateHookGuiPump() { }

static void pumpGuiMs(unsigned long durationMs)
{
  unsigned long start = millis();
  while (millis() - start < durationMs) {
    runGui();
  }
}

// -----------------------------------------------------------------------------
// Backlight + screen auto-dim (battery saver)
// FNK0104AB drives the LCD backlight on GPIO45 (active HIGH, see the TFT_eSPI
// FNK0104AB setup). We take the pin over with LEDC PWM after display init so we
// can fade it: full brightness in use, a low duty after 5 min idle. Any touch or
// button press wakes it back to full. Dimming the backlight is the real power
// saver on an LCD (an on-screen overlay would not cut backlight current).
// -----------------------------------------------------------------------------

#define TFT_BL_PIN        45
static const int     BL_PWM_FREQ = 5000;
static const int     BL_PWM_RES  = 8;     // 8-bit duty: 0-255
static const uint8_t BL_FULL     = 255;   // in-use brightness
static const uint8_t BL_DIM      = 10;    // idle brightness (~4%): readable, low draw
static const uint32_t SCREEN_DIM_MS = 5UL * 60UL * 1000UL;  // 5 min idle -> dim

static bool g_blPwm        = false;   // true once LEDC owns the pin
static bool g_screenDimmed = false;

static void backlightSet(uint8_t duty)
{
  if (g_blPwm) ledcWrite(TFT_BL_PIN, duty);
  else { pinMode(TFT_BL_PIN, OUTPUT); digitalWrite(TFT_BL_PIN, duty ? HIGH : LOW); }
}

static void backlightInit()
{
  // Reconfigure GPIO45 from the plain HIGH that TFT_eSPI set in begin() to LEDC
  // PWM so brightness is adjustable. Fall back to digital on/off if attach fails.
  g_blPwm = ledcAttach(TFT_BL_PIN, BL_PWM_FREQ, BL_PWM_RES);
  backlightSet(BL_FULL);
}

// Restore full brightness and reset the idle timer. Call on any user event and
// before blocking work that should keep the screen lit (recording).
static void wakeScreen()
{
  lv_disp_trig_activity(NULL);   // count this as activity for the dim timer
  if (g_screenDimmed) { backlightSet(BL_FULL); g_screenDimmed = false; }
}

// Dim after SCREEN_DIM_MS of no touch/button activity; wake otherwise. Cheap;
// called every loop pass. LVGL tracks touch inactivity; button presses call
// wakeScreen()/lv_disp_trig_activity() so they reset it too.
static void serviceScreenDim()
{
  uint32_t idle = lv_disp_get_inactive_time(NULL);
  if (idle >= SCREEN_DIM_MS) {
    if (!g_screenDimmed) { backlightSet(BL_DIM); g_screenDimmed = true; }
  } else if (g_screenDimmed) {
    backlightSet(BL_FULL);
    g_screenDimmed = false;
  }
}

static void setScreenWhite()
{
  lv_obj_set_style_bg_color(lv_scr_act(), lv_color_hex(COL_BG), 0);
  lv_obj_set_style_bg_opa(lv_scr_act(), LV_OPA_COVER, 0);
  // Pin the screen: a child that overruns 240x320 by a pixel must not make the
  // whole page pan. Kill scrolling + the scrollbar on every screen.
  lv_obj_clear_flag(lv_scr_act(), LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_set_scrollbar_mode(lv_scr_act(), LV_SCROLLBAR_MODE_OFF);
}

static void setStatePill(const char *text, uint32_t bg, uint32_t fg)
{
  if (!statePill || !statePillText) return;
  lv_obj_set_style_bg_color(statePill, lv_color_hex(bg), 0);
  lv_obj_set_style_text_color(statePillText, lv_color_hex(fg), 0);
  lv_label_set_text(statePillText, text);
}

static void showStatus(const char *status, const char *hint = "")
{
  Serial.print("[STATUS] ");
  Serial.println(status);
  // No screen builder creates these labels, so build them here the first time
  // a message is raised on the current screen: a banner card drawn over
  // whatever is showing. Before this, every status ("SD card full", "Record
  // failed", the low-battery warning) went only to the debug serial port and
  // the device looked like it silently did nothing. The next screen rebuild
  // (lv_obj_clean + uiResetPointers) deletes the card, so a message never
  // outlives the flow that raised it.
  if (!statusLabel || !hintLabel) {
    lv_obj_t *card = lv_obj_create(lv_scr_act());
    lv_obj_set_size(card, 228, LV_SIZE_CONTENT);
    lv_obj_align(card, LV_ALIGN_CENTER, 0, 30);
    lv_obj_set_style_radius(card, 12, 0);
    lv_obj_set_style_bg_color(card, lv_color_hex(COL_TEXT_DARK), 0);
    lv_obj_set_style_bg_opa(card, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(card, 0, 0);
    lv_obj_set_style_pad_all(card, 12, 0);
    lv_obj_set_style_pad_row(card, 6, 0);
    lv_obj_set_style_shadow_width(card, 14, 0);
    lv_obj_set_style_shadow_ofs_y(card, 4, 0);
    lv_obj_set_style_shadow_opa(card, LV_OPA_30, 0);
    lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(card, LV_FLEX_FLOW_COLUMN);

    statusLabel = lv_label_create(card);
    lv_obj_set_style_text_font(statusLabel, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(statusLabel, lv_color_hex(0xFFFFFF), 0);
    lv_label_set_long_mode(statusLabel, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(statusLabel, lv_pct(100));

    hintLabel = lv_label_create(card);
    lv_obj_set_style_text_color(hintLabel, lv_color_hex(COL_CARD_BORDER), 0);
    lv_label_set_long_mode(hintLabel, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(hintLabel, lv_pct(100));
  }
  lv_label_set_text(statusLabel, status);
  lv_label_set_text(hintLabel, hint);
  wakeScreen();   // a message must be readable: undo the idle backlight dim
  for (int i = 0; i < 3; i++) runGui();
}

// Shortcut: set the font on any label/button.
static inline void setFont(lv_obj_t *o, const lv_font_t *f)
{
  lv_obj_set_style_text_font(o, f, 0);
}

static void styleButton(lv_obj_t *btn, uint32_t bgColor, uint32_t textColor)
{
  lv_obj_set_style_radius(btn, 14, 0);
  lv_obj_set_style_bg_color(btn, lv_color_hex(bgColor), 0);
  lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(btn, 0, 0);
  lv_obj_set_style_text_color(btn, lv_color_hex(textColor), 0);
  // Soft drop shadow for depth + a clear pressed state.
  lv_obj_set_style_shadow_width(btn, 10, 0);
  lv_obj_set_style_shadow_ofs_y(btn, 3, 0);
  lv_obj_set_style_shadow_color(btn, lv_color_hex(0x9CA3AF), 0);
  lv_obj_set_style_shadow_opa(btn, LV_OPA_30, 0);
  lv_obj_set_style_bg_opa(btn, LV_OPA_80, LV_STATE_PRESSED);
  lv_obj_set_style_shadow_width(btn, 2, LV_STATE_PRESSED);
  lv_obj_set_style_translate_y(btn, 1, LV_STATE_PRESSED);
}

static void stylePanel(lv_obj_t *panel)
{
  lv_obj_set_style_bg_color(panel, lv_color_hex(COL_CARD_BG), 0);
  lv_obj_set_style_border_color(panel, lv_color_hex(COL_CARD_BORDER), 0);
  lv_obj_set_style_border_width(panel, 1, 0);
  lv_obj_set_style_radius(panel, 16, 0);
  // Subtle elevation so cards lift off the white background.
  lv_obj_set_style_shadow_width(panel, 14, 0);
  lv_obj_set_style_shadow_ofs_y(panel, 4, 0);
  lv_obj_set_style_shadow_color(panel, lv_color_hex(0xCBD5E1), 0);
  lv_obj_set_style_shadow_opa(panel, LV_OPA_40, 0);
  lv_obj_clear_flag(panel, LV_OBJ_FLAG_SCROLLABLE);
}

// Generic button event: stores action (+arg) for loop() to dispatch.
static void actionEvent(lv_event_t *e)
{
  if (lv_event_get_code(e) != LV_EVENT_CLICKED) return;
  intptr_t packed = (intptr_t)lv_event_get_user_data(e);
  pendingAction = (PendingAction)(packed & 0xFF);
  pendingArg    = (int)(packed >> 8);
}

// Set true by the Stop button while a recording is in progress. The capture
// loop polls it directly (loop() is blocked inside the capture), so this can't
// go through the normal pendingAction path.
static volatile bool recordStopReq = false;

static void recordStopEvent(lv_event_t *e)
{
  if (lv_event_get_code(e) == LV_EVENT_CLICKED) recordStopReq = true;
}

// -----------------------------------------------------------------------------
// External push buttons (RECORD + FLAG), active LOW with INPUT_PULLUP.
// Polled both from loop() (idle) and from inside the blocking record loop, so
// each gets a tiny debounced edge-detector. btnPressed() returns true exactly
// once per press (the HIGH->LOW transition), then stays false until release.
// -----------------------------------------------------------------------------

static Btn recBtn  = { REC_BTN_PIN,  false, 0 };
static Btn flagBtn = { FLAG_BTN_PIN, false, 0 };

// Interrupt-latched presses. Polling the pins only works while the loop is free;
// it isn't - the capture loop blocks on I2S/SD, and (before the dual-core split)
// connLoop blocked on HTTP. A press landing during a blocked stretch was seen
// seconds late or missed entirely (level-edge desync). A FALLING-edge ISR latches
// the press the instant it happens, regardless of what either core is doing, so
// RECORD start/stop and FLAG marks register immediately. Debounced in the ISR.
static volatile bool g_recHit = false, g_flagHit = false;
// Per-button release tracking. Cheap buttons bounce on RELEASE, which can fire a
// spurious FALLING edge that looks like a 2nd press (the flag was counting twice:
// once on press, once on the release bounce). We only accept a press when the pin
// is actually held LOW now AND the button was seen STABLY released (HIGH for
// >=50 ms) since the last accept - so release-bounce can never re-trigger.
static uint32_t g_recLastLow = 0,  g_flagLastLow = 0;   // millis the pin was last LOW
static bool     g_recArmed   = true, g_flagArmed  = true;
// After a take ends, ignore RECORD presses for a short settle window. The stop
// press is followed by ~100-300 ms of save + Home rebuild with no feedback, so
// users often tap again - without this guard that 2nd tap starts an unwanted new
// recording. We also drain the latch at end-of-take so a queued press is dropped.
static uint32_t      g_recSettleUntil = 0;

// ISRs do the bare minimum: set the latch. No millis() (its 64-bit divide can
// live in flash, which is unsafe from an IRAM ISR if the cache is ever disabled).
// Debounce happens in btnPressed() below, which runs in task context.
static void IRAM_ATTR isrRecBtn()  { g_recHit  = true; }
static void IRAM_ATTR isrFlagBtn() { g_flagHit = true; }

// Consume one latched press (true exactly once per REAL press). The ISR latches a
// FALLING edge instantly (catches a press even mid-block); here we validate it so
// release-bounce can't double-count: the pin must be held LOW right now, and the
// button must have been STABLY released (HIGH >=50 ms) since the last accept.
static bool btnPressed(Btn &b)
{
  volatile bool *hit;
  uint32_t      *lastLow;
  bool          *armed;
  if      (b.pin == REC_BTN_PIN)  { hit = &g_recHit;  lastLow = &g_recLastLow;  armed = &g_recArmed; }
  else if (b.pin == FLAG_BTN_PIN) { hit = &g_flagHit; lastLow = &g_flagLastLow; armed = &g_flagArmed; }
  else {
    // Fallback polled debounce for any other pin (BOOT etc.).
    bool now = (digitalRead(b.pin) == LOW);
    uint32_t t = millis();
    if (now != b.pressed && (t - b.tEdge) > 30) { b.pressed = now; b.tEdge = t; return now; }
    return false;
  }
  uint32_t t = millis();
  bool low = (digitalRead(b.pin) == LOW);   // active LOW: LOW == pressed
  if (low) *lastLow = t;                     // remember when it was last held
  if ((t - *lastLow) > 50) *armed = true;    // settled release -> ready for next press

  if (!*hit) return false;
  *hit = false;                              // consume the latch regardless
  if (!low) return false;                    // not actually held now -> release-bounce echo
  if (!*armed) return false;                 // no clean release since last accept -> echo
  *armed = false;                            // require a fresh release before the next
  return true;
}

// Flags captured DURING a recording: each is the elapsed offset (ms) from the
// start of the take, marking an important clinical moment. Reset at record
// start, written into the session JSON, and uploaded so the web report can show
// them on the audio timeline.
static const int FLAG_CAP_MAX = 64;
static uint32_t  g_flagMs[FLAG_CAP_MAX];
static int       g_flagCount = 0;

// Lifetime recording counter, reported to the admin dashboard in the heartbeat.
// Persisted in NVS so it survives reboots AND the on-device 5-session auto-trim
// (which is why we can't just count files). Loaded at boot, bumped per take.
static Preferences g_prefs;
static uint32_t    g_totalRecordings = 0;

static void loadTotalRecordings()
{
  g_prefs.begin("sate-stats", false);
  g_totalRecordings = g_prefs.getUInt("recs", 0);
  g_prefs.end();
}

static void bumpTotalRecordings()
{
  g_totalRecordings++;
  g_prefs.begin("sate-stats", false);
  g_prefs.putUInt("recs", g_totalRecordings);
  g_prefs.end();
}

// --- Crash-safe recording resume (NVS) -------------------------------------
// A local take marks itself "active" in NVS with its patient + session number
// while it captures, and clears the mark when it ends cleanly. If the board
// reboots mid-take (brownout, freeze, power loss) the mark survives, so the
// next boot knows a session was interrupted and resumes appending to it. The
// captured 1-minute segments are already on the SD card either way; this just
// continues the SAME session instead of leaving it for the sync uploader.
// "tries" is a boot-loop guard: if resuming keeps crashing, we give up after a
// couple of attempts and let the segments upload as a normal unsynced session.
static void recCrashMark(const char *patientId, uint32_t sessionNum, uint32_t pcmCap)
{
  g_prefs.begin("sate-rec", false);
  g_prefs.putUChar("active", 1);
  g_prefs.putString("pid", patientId);
  g_prefs.putUInt("sess", sessionNum);
  // The take's byte cap must survive a reboot: a server-timed take (fw 1.5.19
  // record_seconds) that crash-resumes with the generic PCM_MAX_BYTES ceiling
  // would turn a 60-second remote capture into an unattended 62-minute one.
  g_prefs.putUInt("cap", pcmCap);
  g_prefs.end();
}

static void recCrashClear()
{
  g_prefs.begin("sate-rec", false);
  g_prefs.clear();   // drops active/pid/sess/tries in one shot
  g_prefs.end();
}

// Cheap probe: does an interrupted take's crash-mark sit in NVS? Used by
// loop()'s resume gate to decide whether the offline fallback must bring the
// net task up before the resume (which BLOCKS inside the capture until Stop).
static bool recCrashMarkPresent()
{
  g_prefs.begin("sate-rec", true);
  bool present = g_prefs.getUChar("active", 0) == 1 && g_prefs.getUInt("sess", 0) != 0;
  g_prefs.end();
  return present;
}

static lv_obj_t *makeActionButton(lv_obj_t *parent, const char *text,
                                  uint32_t bg, uint32_t fg,
                                  PendingAction act, int arg = 0)
{
  lv_obj_t *btn = lv_btn_create(parent);
  styleButton(btn, bg, fg);
  intptr_t packed = ((intptr_t)arg << 8) | (intptr_t)act;
  lv_obj_add_event_cb(btn, actionEvent, LV_EVENT_CLICKED, (void *)packed);
  lv_obj_t *lbl = lv_label_create(btn);
  lv_label_set_text(lbl, text);
  lv_obj_center(lbl);
  return btn;
}

static void updateConnBadge()
{
  if (!connIcon) return;
  switch (connGetMode()) {
    case CONN_WIFI_ONLINE:
      lv_label_set_text(connIcon, LV_SYMBOL_WIFI);
      lv_obj_set_style_text_color(connIcon, lv_color_hex(COL_OK), 0);
      break;
    case CONN_WIFI_TRYING:
      lv_label_set_text(connIcon, LV_SYMBOL_REFRESH);
      lv_obj_set_style_text_color(connIcon, lv_color_hex(COL_TEXT_MUTED), 0);
      break;
    case CONN_BLE_ADV:
    case CONN_BLE_CONNECTED:
      lv_label_set_text(connIcon, LV_SYMBOL_BLUETOOTH);
      lv_obj_set_style_text_color(connIcon, lv_color_hex(COL_PRIMARY), 0);
      break;
    default:
      lv_label_set_text(connIcon, "");
      break;
  }
}

// Header used by every screen: title left, state pill right, divider.
// backAction != ACT_NONE adds a back arrow on the left.
static void createHeader(const char *title, PendingAction backAction = ACT_NONE,
                         uint8_t backScale = 1)
{
  lv_obj_t *header = lv_obj_create(lv_scr_act());
  lv_obj_set_size(header, 240, 40);
  lv_obj_align(header, LV_ALIGN_TOP_LEFT, 0, 0);
  lv_obj_set_style_bg_color(header, lv_color_hex(COL_BG), 0);
  lv_obj_set_style_border_width(header, 0, 0);
  lv_obj_set_style_radius(header, 0, 0);
  lv_obj_set_style_pad_all(header, 0, 0);
  lv_obj_clear_flag(header, LV_OBJ_FLAG_SCROLLABLE);

  int titleX = 12;

  if (backAction != ACT_NONE) {
    lv_obj_t *back = makeActionButton(header, LV_SYMBOL_LEFT, COL_PRIMARY_BG, COL_PRIMARY_DK, backAction);
    int bw = 34 * backScale;
    int bh = 28 * backScale;
    if (bh > 38) bh = 38;                 // keep inside the 40px header
    lv_obj_set_size(back, bw, bh);
    lv_obj_set_style_radius(back, 8, 0);
    lv_obj_align(back, LV_ALIGN_LEFT_MID, 8, 0);
    if (backScale > 1) lv_obj_set_style_text_font(back, &lv_font_montserrat_20, 0);
    titleX = 16 + bw;
  }

  lv_obj_t *titleLbl = lv_label_create(header);
  lv_label_set_text(titleLbl, title);
  setFont(titleLbl, &lv_font_montserrat_14);
  lv_obj_set_style_text_color(titleLbl, lv_color_hex(COL_PRIMARY_DK), 0);
  lv_obj_align(titleLbl, LV_ALIGN_LEFT_MID, titleX, 0);

  statePill = lv_obj_create(header);
  lv_obj_set_size(statePill, 70, 22);
  lv_obj_align(statePill, LV_ALIGN_RIGHT_MID, -10, 0);
  lv_obj_set_style_radius(statePill, 11, 0);
  lv_obj_set_style_border_width(statePill, 0, 0);
  lv_obj_set_style_pad_all(statePill, 0, 0);
  lv_obj_clear_flag(statePill, LV_OBJ_FLAG_SCROLLABLE);

  statePillText = lv_label_create(statePill);
  lv_obj_center(statePillText);

  // Connectivity icon (tappable): opens the Connection screen.
  lv_obj_t *connBtn = lv_btn_create(header);
  lv_obj_set_size(connBtn, 32, 28);
  styleButton(connBtn, COL_BG, COL_PRIMARY);
  lv_obj_align(connBtn, LV_ALIGN_RIGHT_MID, -84, 0);
  lv_obj_add_event_cb(connBtn, actionEvent, LV_EVENT_CLICKED, (void *)(intptr_t)ACT_OPEN_CONN);
  connIcon = lv_label_create(connBtn);
  lv_label_set_text(connIcon, "");
  lv_obj_center(connIcon);
  updateConnBadge();

  lv_obj_t *divider = lv_obj_create(lv_scr_act());
  lv_obj_set_size(divider, 240, 1);
  lv_obj_align(divider, LV_ALIGN_TOP_LEFT, 0, 40);
  lv_obj_set_style_bg_color(divider, lv_color_hex(COL_CARD_BORDER), 0);
  lv_obj_set_style_border_width(divider, 0, 0);
  lv_obj_set_style_radius(divider, 0, 0);
}

// -----------------------------------------------------------------------------
// Progress overlay (record / playback): created on demand, deleted after.
// -----------------------------------------------------------------------------

static void showProgressOverlay(const char *caption, uint32_t arcColor,
                                bool withStop = false, bool withFlags = false)
{
  progressOverlay = lv_obj_create(lv_scr_act());
  lv_obj_set_size(progressOverlay, 240, 320);
  lv_obj_align(progressOverlay, LV_ALIGN_TOP_LEFT, 0, 0);
  lv_obj_set_style_bg_color(progressOverlay, lv_color_hex(COL_BG), 0);
  lv_obj_set_style_bg_opa(progressOverlay, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(progressOverlay, 0, 0);
  lv_obj_set_style_radius(progressOverlay, 0, 0);
  lv_obj_clear_flag(progressOverlay, LV_OBJ_FLAG_SCROLLABLE);

  progressArc = lv_arc_create(progressOverlay);
  lv_obj_set_size(progressArc, 170, 170);
  lv_obj_align(progressArc, LV_ALIGN_CENTER, 0, -24);
  lv_arc_set_rotation(progressArc, 270);
  lv_arc_set_bg_angles(progressArc, 0, 360);
  lv_arc_set_range(progressArc, 0, 1000);
  lv_arc_set_value(progressArc, 0);
  lv_obj_remove_style(progressArc, NULL, LV_PART_KNOB);
  lv_obj_clear_flag(progressArc, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_set_style_arc_width(progressArc, 10, LV_PART_MAIN);
  lv_obj_set_style_arc_width(progressArc, 10, LV_PART_INDICATOR);
  lv_obj_set_style_arc_color(progressArc, lv_color_hex(COL_TRACK), LV_PART_MAIN);
  lv_obj_set_style_arc_color(progressArc, lv_color_hex(arcColor), LV_PART_INDICATOR);

  progressBig = lv_label_create(progressOverlay);
  lv_label_set_text(progressBig, "");
  setFont(progressBig, &lv_font_montserrat_20);
  lv_obj_set_style_text_color(progressBig, lv_color_hex(COL_TEXT_DARK), 0);
  lv_obj_align(progressBig, LV_ALIGN_CENTER, 0, -34);

  progressSmall = lv_label_create(progressOverlay);
  lv_label_set_text(progressSmall, caption);
  lv_obj_set_style_text_color(progressSmall, lv_color_hex(COL_TEXT_MUTED), 0);
  lv_obj_align(progressSmall, LV_ALIGN_CENTER, 0, -10);

  // Live flag counter (recording only) - the physical FLAG button bumps it.
  progressFlag = nullptr;
  if (withFlags) {
    progressFlag = lv_label_create(progressOverlay);
    lv_label_set_text(progressFlag, LV_SYMBOL_BELL "  Flags: 0");
    setFont(progressFlag, &lv_font_montserrat_14);
    lv_obj_set_style_text_color(progressFlag, lv_color_hex(COL_WARN), 0);
    lv_obj_align(progressFlag, LV_ALIGN_CENTER, 0, 64);
  }

  // Optional on-screen Stop (playback only). Recording is stopped with the
  // physical RECORD button, so its overlay passes withStop=false.
  if (withStop) {
    lv_obj_t *stopBtn = lv_btn_create(progressOverlay);
    styleButton(stopBtn, COL_REC, 0xFFFFFF);
    lv_obj_set_size(stopBtn, 168, 60);
    lv_obj_align(stopBtn, LV_ALIGN_BOTTOM_MID, 0, -26);
    lv_obj_add_event_cb(stopBtn, recordStopEvent, LV_EVENT_CLICKED, NULL);
    lv_obj_t *lbl = lv_label_create(stopBtn);
    lv_label_set_text(lbl, LV_SYMBOL_STOP "  Stop");
    setFont(lbl, &lv_font_montserrat_20);
    lv_obj_center(lbl);
  }

  lv_obj_move_foreground(progressOverlay);
}

static void hideProgressOverlay()
{
  if (!progressOverlay) return;
  lv_obj_del(progressOverlay);
  progressOverlay = progressArc = progressBig = progressSmall = nullptr;
  progressFlag = nullptr;
}

// Brief "Saving..." overlay with a spinner, shown after a take stops while the
// WAV metadata is written. Gives the stop press immediate, unmistakable feedback
// (vs. a blank pause) so nobody taps RECORD again. Full-screen so it covers the
// recording overlay cleanly.
static lv_obj_t *savingOverlay = nullptr;

static void showSavingOverlay()
{
  if (savingOverlay) return;
  savingOverlay = lv_obj_create(lv_scr_act());
  lv_obj_set_size(savingOverlay, 240, 320);
  lv_obj_align(savingOverlay, LV_ALIGN_TOP_LEFT, 0, 0);
  lv_obj_set_style_bg_color(savingOverlay, lv_color_hex(COL_BG), 0);
  lv_obj_set_style_bg_opa(savingOverlay, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(savingOverlay, 0, 0);
  lv_obj_set_style_radius(savingOverlay, 0, 0);
  lv_obj_clear_flag(savingOverlay, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *sp = lv_spinner_create(savingOverlay, 900, 70);
  lv_obj_set_size(sp, 64, 64);
  lv_obj_align(sp, LV_ALIGN_CENTER, 0, -24);
  lv_obj_set_style_arc_width(sp, 7, LV_PART_MAIN);
  lv_obj_set_style_arc_width(sp, 7, LV_PART_INDICATOR);
  lv_obj_set_style_arc_color(sp, lv_color_hex(COL_TRACK), LV_PART_MAIN);
  lv_obj_set_style_arc_color(sp, lv_color_hex(COL_WARN), LV_PART_INDICATOR);
  lv_obj_remove_style(sp, NULL, LV_PART_KNOB);

  lv_obj_t *lbl = lv_label_create(savingOverlay);
  lv_label_set_text(lbl, LV_SYMBOL_SAVE "  Saving...");
  setFont(lbl, &lv_font_montserrat_20);
  lv_obj_set_style_text_color(lbl, lv_color_hex(COL_TEXT_DARK), 0);
  lv_obj_align(lbl, LV_ALIGN_CENTER, 0, 48);

  lv_obj_move_foreground(savingOverlay);
}

static void hideSavingOverlay()
{
  if (!savingOverlay) return;
  lv_obj_del(savingOverlay);
  savingOverlay = nullptr;
}

static void updateProgress(uint16_t permille, const char *bigText)
{
  if (!progressOverlay) return;
  lv_arc_set_value(progressArc, permille);
  if (bigText) lv_label_set_text(progressBig, bigText);
}

// Upload progress overlay (driven from connectivity per ~1 MB slice). These run
// on the net task (core 0), so they only flip flags; loop() (core 1) renders the
// overlay - see renderUploadOverlay().
void sateHookUploadBegin()
{
  connUploadUiPct    = 0;
  connUploadUiActive = true;
}

void sateHookUploadProgress(int pct)
{
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  connUploadUiPct = pct;
}

void sateHookUploadEnd()
{
  connUploadUiActive = false;
  // The upload tail may have trimmed old synced audio (freeSessionAudioKeepMarker
  // on the net task) - drop the SD usage cache so the Home storage chip and the
  // "SD card full" record guard see the freed space on their next refresh.
  sdInvalidateUsageCache();
}

// Render the upload overlay from the net task's flags. Called every loop() pass
// on core 1, where touching LVGL is safe. Cheap: only acts on a state change.
static void renderUploadOverlay()
{
  static bool shown   = false;
  static int  lastPct = -1;
  bool active = connUploadUiActive;
  if (active && !shown) {
    showProgressOverlay("Uploading to SATE", COL_PRIMARY);
    updateProgress(0, "0%");
    shown   = true;
    lastPct = 0;
  }
  if (active) {
    int p = connUploadUiPct;
    if (p != lastPct) {
      lastPct = p;
      char b[8];
      snprintf(b, sizeof(b), "%d%%", p);
      updateProgress((uint16_t)(p * 10), b);
    }
  } else if (shown) {
    hideProgressOverlay();
    shown = false;
  }
}

// -----------------------------------------------------------------------------
// Boot screen: logo pop-in, tagline, spinner, LIVE init checklist
// -----------------------------------------------------------------------------

static lv_obj_t *bootRoot       = nullptr;
static lv_obj_t *bootSpinner    = nullptr;
static lv_obj_t *bootStepLbl[4] = {nullptr, nullptr, nullptr, nullptr};
static const char *bootStepName[4] = {"Display & touch", "SD card", "Audio codec", "SATE services"};

static void bootScreenCreate()
{
  lv_obj_clean(lv_scr_act());
  setScreenWhite();

  bootRoot = lv_obj_create(lv_scr_act());
  lv_obj_set_size(bootRoot, 240, 320);
  lv_obj_align(bootRoot, LV_ALIGN_TOP_LEFT, 0, 0);
  lv_obj_set_style_bg_color(bootRoot, lv_color_hex(COL_BG), 0);
  lv_obj_set_style_bg_opa(bootRoot, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(bootRoot, 0, 0);
  lv_obj_set_style_radius(bootRoot, 0, 0);
  lv_obj_set_style_pad_all(bootRoot, 0, 0);
  lv_obj_clear_flag(bootRoot, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *logo = lv_img_create(bootRoot);
  lv_img_set_src(logo, &sate_logo_white);
  lv_obj_align(logo, LV_ALIGN_CENTER, 0, -72);
  lv_obj_set_style_opa(logo, LV_OPA_TRANSP, 0);
  lv_img_set_zoom(logo, 180);   // 256 = 100%

  lv_anim_t zoom;
  lv_anim_init(&zoom);
  lv_anim_set_var(&zoom, logo);
  lv_anim_set_values(&zoom, 180, 256);
  lv_anim_set_time(&zoom, 900);
  lv_anim_set_path_cb(&zoom, lv_anim_path_overshoot);
  lv_anim_set_exec_cb(&zoom, [](void *obj, int32_t v) {
    lv_img_set_zoom((lv_obj_t *)obj, (uint16_t)v);
  });
  lv_anim_start(&zoom);

  lv_anim_t fade;
  lv_anim_init(&fade);
  lv_anim_set_var(&fade, logo);
  lv_anim_set_values(&fade, LV_OPA_TRANSP, LV_OPA_COVER);
  lv_anim_set_time(&fade, 600);
  lv_anim_set_path_cb(&fade, lv_anim_path_ease_out);
  lv_anim_set_exec_cb(&fade, [](void *obj, int32_t v) {
    lv_obj_set_style_opa((lv_obj_t *)obj, v, 0);
  });
  lv_anim_start(&fade);

  lv_obj_t *tagline = lv_label_create(bootRoot);
  lv_label_set_text(tagline, "CLINICAL SPEECH RECORDER");
  lv_obj_set_style_text_color(tagline, lv_color_hex(COL_TEXT_MUTED), 0);
  lv_obj_set_style_text_letter_space(tagline, 2, 0);
  lv_obj_align(tagline, LV_ALIGN_CENTER, 0, -8);
  lv_obj_set_style_opa(tagline, LV_OPA_TRANSP, 0);

  lv_anim_t tfade;
  lv_anim_init(&tfade);
  lv_anim_set_var(&tfade, tagline);
  lv_anim_set_values(&tfade, LV_OPA_TRANSP, LV_OPA_COVER);
  lv_anim_set_time(&tfade, 600);
  lv_anim_set_delay(&tfade, 350);
  lv_anim_set_path_cb(&tfade, lv_anim_path_ease_out);
  lv_anim_set_exec_cb(&tfade, [](void *obj, int32_t v) {
    lv_obj_set_style_opa((lv_obj_t *)obj, v, 0);
  });
  lv_anim_start(&tfade);

  bootSpinner = lv_spinner_create(bootRoot, 1000, 60);
  lv_obj_set_size(bootSpinner, 32, 32);
  lv_obj_align(bootSpinner, LV_ALIGN_CENTER, 0, 36);
  lv_obj_set_style_arc_width(bootSpinner, 4, LV_PART_MAIN);
  lv_obj_set_style_arc_width(bootSpinner, 4, LV_PART_INDICATOR);
  lv_obj_set_style_arc_color(bootSpinner, lv_color_hex(COL_TRACK), LV_PART_MAIN);
  lv_obj_set_style_arc_color(bootSpinner, lv_color_hex(COL_PRIMARY), LV_PART_INDICATOR);
  lv_obj_remove_style(bootSpinner, NULL, LV_PART_KNOB);

  // Small firmware version, pinned bottom-center.
  lv_obj_t *ver = lv_label_create(bootRoot);
  char vtxt[24];
  snprintf(vtxt, sizeof(vtxt), "v%s", FIRMWARE_VERSION);
  lv_label_set_text(ver, vtxt);
  setFont(ver, &lv_font_montserrat_12);
  lv_obj_set_style_text_color(ver, lv_color_hex(COL_TEXT_MUTED), 0);
  lv_obj_align(ver, LV_ALIGN_BOTTOM_MID, 0, -8);

  for (int i = 0; i < 4; i++) {
    bootStepLbl[i] = lv_label_create(bootRoot);
    lv_label_set_text(bootStepLbl[i], "");
    lv_obj_set_style_text_color(bootStepLbl[i], lv_color_hex(COL_TEXT_MUTED), 0);
    lv_obj_align(bootStepLbl[i], LV_ALIGN_TOP_LEFT, 58, 206 + i * 25);
  }

  pumpGuiMs(1050);   // let the logo intro play
}

static void bootStepBegin(int i)
{
  if (i < 0 || i > 3 || !bootStepLbl[i]) return;
  char t[48];
  snprintf(t, sizeof(t), LV_SYMBOL_REFRESH "  %s", bootStepName[i]);
  lv_label_set_text(bootStepLbl[i], t);
  lv_obj_set_style_text_color(bootStepLbl[i], lv_color_hex(COL_TEXT_MUTED), 0);
  pumpGuiMs(140);
}

static void bootStepDone(int i, bool ok)
{
  if (i < 0 || i > 3 || !bootStepLbl[i]) return;
  char t[48];
  snprintf(t, sizeof(t), "%s  %s", ok ? LV_SYMBOL_OK : LV_SYMBOL_CLOSE, bootStepName[i]);
  lv_label_set_text(bootStepLbl[i], t);
  lv_obj_set_style_text_color(bootStepLbl[i], lv_color_hex(ok ? COL_OK : COL_REC), 0);
  pumpGuiMs(180);
}

static void bootScreenFail(const char *msg)
{
  if (bootSpinner) lv_obj_add_flag(bootSpinner, LV_OBJ_FLAG_HIDDEN);
  lv_obj_t *err = lv_label_create(bootRoot);
  lv_label_set_text(err, msg);
  lv_obj_set_style_text_color(err, lv_color_hex(COL_REC), 0);
  lv_obj_set_width(err, 216);
  lv_label_set_long_mode(err, LV_LABEL_LONG_WRAP);
  lv_obj_set_style_text_align(err, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_align(err, LV_ALIGN_CENTER, 0, 36);
  for (int i = 0; i < 6; i++) runGui();
}

static void bootScreenFinish()
{
  if (bootSpinner) lv_obj_add_flag(bootSpinner, LV_OBJ_FLAG_HIDDEN);

  lv_obj_t *okLbl = lv_label_create(bootRoot);
  lv_label_set_text(okLbl, LV_SYMBOL_OK "  Ready");
  lv_obj_set_style_text_color(okLbl, lv_color_hex(COL_OK), 0);
  lv_obj_align(okLbl, LV_ALIGN_CENTER, 0, 36);
  pumpGuiMs(550);

  // Fade the whole boot layer out (opa is inherited in LVGL v8).
  for (int o = 255; o >= 0; o -= 15) {
    lv_obj_set_style_opa(bootRoot, o, 0);
    runGui();
  }

  lv_obj_del(bootRoot);
  bootRoot = bootSpinner = nullptr;
  for (int i = 0; i < 4; i++) bootStepLbl[i] = nullptr;
}

// -----------------------------------------------------------------------------
// SD helpers (fixed char buffers, no String)
// -----------------------------------------------------------------------------

static bool ensureDir(const char *path)
{
  if (SD_MMC.exists(path)) return true;
  return SD_MMC.mkdir(path);
}

static bool initSdCard()
{
  if (!SD_MMC.setPins(SD_MMC_CLK, SD_MMC_CMD, SD_MMC_D0, SD_MMC_D1, SD_MMC_D2, SD_MMC_D3)) {
    Serial.println("[SD] setPins failed");
    return false;
  }
  if (!SD_MMC.begin()) {
    Serial.println("[SD] mount failed");
    return false;
  }
  Serial.printf("[SD] card size %lu MB\n", (unsigned long)(SD_MMC.cardSize() / (1024 * 1024)));
  ensureDir("/sate");
  ensureDir("/sate/patients");
  return true;
}

// Cheap card-alive probe: the patient root exists from boot, so failing to open
// it means the SDMMC host has lost the card (nudged socket, brown-out on a
// write), not "no data yet".
static bool sdProbe()
{
  File d = SD_MMC.open("/sate/patients");
  if (!d) return false;
  bool ok = d.isDirectory();
  d.close();
  return ok;
}

// One transient card fault must not disable recording until a power cycle:
// re-initialise the SDMMC host (pins set at boot persist across end()). Caller
// MUST hold the SD bus (connSetUiSdBusy(true)) and have seen connNetSdIdle() -
// re-mounting under an open net-task file handle corrupts that transfer.
static bool sdRemount()
{
  Serial.println("[SD] probe failed - re-mounting card");
  SD_MMC.end();
  delay(50);
  if (!SD_MMC.begin()) {
    Serial.println("[SD] re-mount failed");
    return false;
  }
  ensureDir("/sate");
  ensureDir("/sate/patients");
  sdInvalidateUsageCache();   // stale free-space numbers die with the old mount
  Serial.println("[SD] re-mount OK");
  return sdProbe();
}

// Load /sate/patients.json (array of {patient_id,name,age,session_type,clinician}).
static void loadPatientsFromSd()
{
  File f = SD_MMC.open("/sate/patients.json", FILE_READ);
  if (!f) return;
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err != DeserializationError::Ok) return;
  JsonArray arr = doc.as<JsonArray>();
  if (arr.isNull() || arr.size() == 0) return;

  // The selection is kept by patient ID, not slot: a server roster refresh
  // (reload_patients / go-online fetch) can reorder or insert rows, and the
  // old index would silently point the next — possibly remote — take at a
  // different patient.
  char selId[20] = "";
  if (g_patientCount > 0)
    snprintf(selId, sizeof(selId), "%s", g_patients[currentPatientIndex].patientId);

  int n = 0;
  for (JsonObject p : arr) {
    // Cap at MAX_PATIENTS - 1: one slot is RESERVED for the "Standalone" bucket.
    // Filling all six with server patients left ensureStandalonePatient() no
    // room, standaloneIndex() returned -1, and the fallback selected the
    // account's first patient - so standalone reports landed on a real
    // patient's chart. A 6th+ server patient is still reachable by assigning
    // them from the app (applyActivePatient replaces a slot when full).
    if (n >= MAX_PATIENTS - 1) break;
    SatePatient &dst = g_patients[n];
    snprintf(dst.patientId,   sizeof(dst.patientId),   "%s", (const char *)(p["patient_id"] | "PT-????"));
    snprintf(dst.displayName, sizeof(dst.displayName), "%s", (const char *)(p["name"] | "Unknown"));
    snprintf(dst.age,         sizeof(dst.age),         "%s", (const char *)(p["age"] | "-"));
    snprintf(dst.sessionType, sizeof(dst.sessionType), "%s", (const char *)(p["session_type"] | "-"));
    snprintf(dst.clinician,   sizeof(dst.clinician),   "%s", (const char *)(p["clinician"] | "-"));
    n++;
  }
  if (n > 0) {
    g_patientCount = n;
    // A roster arriving from the server is NOT an assignment. Standalone stays in
    // the roster and stays selected unless a patient was explicitly assigned
    // (applyActivePatient) or picked on-device - otherwise the recorder silently
    // filed every standalone report under whichever patient happened to be first.
    ensureStandalonePatient();
    int sel = standaloneIndex();
    if (sel < 0) sel = 0;
    if (selId[0]) {
      for (int i = 0; i < g_patientCount; i++)
        if (!strcmp(g_patients[i].patientId, selId)) { sel = i; break; }
    }
    selectPatientIndex(sel);
    g_standalonePatient = (sel == standaloneIndex());
    Serial.printf("[SD] loaded %d patient(s); active=%s\n",
                  n, g_patients[currentPatientIndex].patientId);
  }
}

static void patientDirPath(char *out, size_t outSize)
{
  // The recorder records STANDALONE: in practice this is always the one
  // "Standalone" dir. Retention still needs to know which dir is live, and it
  // refuses to reclaim anything until it does, so publish it on every use.
  snprintf(out, outSize, "/sate/patients/%s", g_patients[currentPatientIndex].patientId);
}

static void sessionWavPath(char *out, size_t outSize, const char *dir, uint32_t n)
{
  snprintf(out, outSize, "%s/session_%04lu.wav", dir, (unsigned long)n);
}

static void sessionJsonPath(char *out, size_t outSize, const char *dir, uint32_t n)
{
  snprintf(out, outSize, "%s/session_%04lu.json", dir, (unsigned long)n);
}

static void sessionSyncMarkPath(char *out, size_t outSize, const char *dir, uint32_t n)
{
  snprintf(out, outSize, "%s/session_%04lu.synced", dir, (unsigned long)n);
}

// Build the path of segment `part` for a final ".wav" path, e.g.
// "session_0001.wav" + part 2 -> "session_0001.part02.wav".
static void sessionPartPath(char *out, size_t outSize, const char *finalWav, int part)
{
  size_t len = strlen(finalWav);
  if (len >= 4) len -= 4; // strip ".wav"
  snprintf(out, outSize, "%.*s.part%02d.wav", (int)len, finalWav, part);
}

// A session exists if it has segment files / a legacy merged .wav, OR a .synced
// marker (its audio was freed after upload but it still counts for numbering).
static bool sessionExists(const char *dir, uint32_t n)
{
  char wav[160], pp[200], mark[160];
  sessionWavPath(wav, sizeof(wav), dir, n);
  sessionPartPath(pp, sizeof(pp), wav, 0);
  sessionSyncMarkPath(mark, sizeof(mark), dir, n);
  return SD_MMC.exists(pp) || SD_MMC.exists(wav) || SD_MMC.exists(mark);
}

// Does session n still hold real audio (segments or a legacy merged .wav)? A
// slot with ONLY a .synced marker is a tombstone: its audio was freed after the
// server confirmed it, so nothing on the card would be lost by reusing it.
static bool sessionHasAudio(const char *dir, uint32_t n)
{
  char wav[160], pp[200];
  sessionWavPath(wav, sizeof(wav), dir, n);
  sessionPartPath(pp, sizeof(pp), wav, 0);
  return SD_MMC.exists(pp) || SD_MMC.exists(wav);
}

// Release an audio-free slot so its number can be handed out again. Only ever
// called past the 99 wrap, and only for a slot sessionHasAudio() says is empty -
// the recording itself is already durably on the server.
static void clearSessionTombstone(const char *dir, uint32_t n)
{
  char mk[160], js[160];
  sessionSyncMarkPath(mk, sizeof(mk), dir, n);
  sessionJsonPath(js, sizeof(js), dir, n);
  SD_MMC.remove(mk);
  SD_MMC.remove(js);
  Serial.printf("[REC] reused tombstoned slot %lu in %s (audio already on server)\n",
                (unsigned long)n, dir);
}

// One directory walk marking every session number present in `dir` (same
// artifacts sessionExists() accepts: a segment, a legacy merged .wav, or a
// .synced tombstone). `present` must hold SESSION_NUM_MAX + 1 slots. Numbers
// are NOT contiguous - a delete leaves a hole - so callers iterate the whole
// map and skip absent slots instead of stopping at the first gap.
static void scanSessionNumbers(const char *dir, bool *present, bool *audio)
{
  memset(present, 0, SESSION_NUM_MAX + 1);
  if (audio) memset(audio, 0, SESSION_NUM_MAX + 1);
  File root = SD_MMC.open(dir);
  if (!root) return;
  File e;
  while ((e = root.openNextFile())) {
    const char *nm = e.name();               // basename or full path per core
    const char *base = strrchr(nm, '/');
    base = base ? base + 1 : nm;
    if (!strncmp(base, "session_", 8)) {
      uint32_t n = (uint32_t)strtoul(base + 8, nullptr, 10);
      const char *sfx = strchr(base + 8, '.');
      if (n >= 1 && n <= SESSION_NUM_MAX && sfx) {
        const bool isWav  = !strcmp(sfx, ".wav");
        const bool isPart = !strncmp(sfx, ".part", 5);
        // A slot "exists" for numbering if it has any artifact incl. a .synced
        // tombstone; it has AUDIO only if a segment or a legacy merged .wav is
        // present. A tombstone (synced + audio reclaimed) has none.
        if (isWav || isPart || !strcmp(sfx, ".synced")) present[n] = true;
        if (audio && (isWav || isPart)) audio[n] = true;
      }
    }
    e.close();
  }
  root.close();
}

// Remove ALL files of session n (segments, legacy wav, json, .synced marker).
static void deleteSessionFiles(const char *dir, uint32_t n)
{
  char wav[160], pp[200], js[160], mk[160];
  sessionWavPath(wav, sizeof(wav), dir, n);
  SD_MMC.remove(wav);
  for (int k = 0;; k++) {
    sessionPartPath(pp, sizeof(pp), wav, k);
    if (!SD_MMC.exists(pp)) break;
    SD_MMC.remove(pp);
  }
  sessionJsonPath(js, sizeof(js), dir, n);
  SD_MMC.remove(js);
  sessionSyncMarkPath(mk, sizeof(mk), dir, n);
  SD_MMC.remove(mk);
}

// NOTE (1.5.9): nothing deletes a recording automatically any more. The device
// holds the only copy of a take until the SLP explicitly deletes it from the
// Sessions screen, so the three old reclaim paths were removed:
//   - freeSessionAudio()/purgeSyncedAudio(): dropped a .synced session's audio at
//     boot. A ".synced marker" only proves a POST returned 2xx - not that the
//     audio is intact and usable on the server.
//   - trimSessionsToMax(): capped the card at 5 sessions per patient.
// A 32 GB card holds ~278 h at 16 kHz mono, so keeping everything is cheap; the
// take itself now stops cleanly if the card ever does fill (see
// recordWavStreamToSd). The .synced marker still drives the pending count.
//
// Session numbers are allocated MONOTONICALLY and a delete never renumbers the
// survivors (the old down-shift multi-rename could be interrupted mid-loop and,
// worse, renumbered sessions underneath a live upload - splicing two takes into
// one server WAV). A number is an identifier, not a dense index: next number =
// highest existing + 1; past SESSION_NUM_MAX the counter wraps to the LOWEST
// free number. A .synced tombstone still owns its slot, so a number is reused
// only after the SLP explicitly deleted that session - which keeps the server's
// (device_serial, session_number, patient) identity unambiguous. Returns 0 only
// when all SESSION_NUM_MAX numbers are taken.
// A deleted number must NOT come straight back. The server keeps its row for a
// deleted take (the device never deletes server-side), and a remote timed take of
// the same duration produces the SAME byte count - so handing the number back
// makes (patient, number, bytes) ambiguous, and trim's verify could match the old
// take's row and free the new take's only local copy. A per-patient high-water in
// NVS keeps allocation monotonic across deletes; it only resets at the 99 wrap, by
// which point 99 further takes have gone by.
static uint32_t sessionSeqKey(const char *dir, char *out, size_t n)
{
  uint32_t h = 2166136261u;                       // FNV-1a over the patient dir
  for (const char *c = dir; *c; c++) { h ^= (uint8_t)*c; h *= 16777619u; }
  snprintf(out, n, "hw%08lx", (unsigned long)h);  // <=15 chars: NVS key limit
  return h;
}

static uint32_t findNextSessionIndex(const char *dir)
{
  bool present[SESSION_NUM_MAX + 1];
  scanSessionNumbers(dir, present);
  uint32_t highest = 0;
  for (uint32_t i = 1; i <= SESSION_NUM_MAX; i++)
    if (present[i]) highest = i;

  char key[16];
  sessionSeqKey(dir, key, sizeof(key));
  g_prefs.begin("sate-seq", true);
  uint32_t mark = g_prefs.getUInt(key, 0);        // highest number ever used here
  g_prefs.end();
  if (mark > highest) highest = mark;             // a deleted number stays spent

  uint32_t next = 0;
  if (highest < SESSION_NUM_MAX) {
    next = highest + 1;                           // empty dir starts at 1
  } else {
    // Wrap. Prefer a slot that holds nothing at all.
    for (uint32_t i = 1; i <= SESSION_NUM_MAX; i++)
      if (!present[i]) { next = i; break; }
    if (!next) {
      // Every number is taken - but most are AUDIO-FREE tombstones: retention
      // frees a synced take's audio and keeps its .synced marker, and a marker
      // owns its slot forever. Without this the card empties, the numbers stay
      // full, and RECORD dies permanently after 99 lifetime takes (a standalone
      // unit records into one dir, so that is weeks of normal use). Recycle the
      // OLDEST audio-free tombstone: its audio is already durably on the server,
      // and the NVS high-water no longer protects it because we are past the wrap.
      for (uint32_t i = 1; i <= SESSION_NUM_MAX; i++) {
        if (sessionHasAudio(dir, i)) continue;    // real audio: never reuse
        next = i;
        clearSessionTombstone(dir, i);            // free the slot for the new take
        break;
      }
    }
    if (!next) return 0;                          // all 99 slots hold real audio
  }
  g_prefs.begin("sate-seq", false);
  // At the wrap the high-water restarts from the number we just handed out, so
  // the counter tracks the new cycle instead of pinning itself at 99.
  g_prefs.putUInt(key, next);
  g_prefs.end();
  return next;
}

// --- SD card capacity (auto-detected from the mounted card) ----------------

// Card usage is CACHED. `SD_MMC.usedBytes()` runs `f_getfree`, a full FAT
// free-cluster scan that takes many ms (worse now that the net task shares the SD
// bus). It used to run on every record-begin AND every showHomeScreen, dragging
// both. We scan at most every 30 s (and prime it at boot + refresh on the Home
// idle tick), so the hot paths read a cached number with zero SD access. The
// post-take adjustment keeps the % visibly correct without a rescan.
static uint64_t g_sdTotal     = 0;   // constant once mounted
static uint64_t g_sdUsedCache = 0;
static uint32_t g_sdUsedAt    = 0;

// Run the expensive scan if forced or the cache is stale. Call from non-hot paths
// (boot, Home idle tick) - never from record-begin / showHomeScreen directly.
static void sdRefreshUsage(bool force)
{
  uint32_t now = millis();
  if (!force && g_sdUsedAt != 0 && (now - g_sdUsedAt) < 30000) return;
  if (g_sdTotal == 0) g_sdTotal = SD_MMC.totalBytes();
  uint64_t used = SD_MMC.usedBytes();         // the slow f_getfree, now rate-limited
  if (used > g_sdTotal) used = g_sdTotal;
  g_sdUsedCache = used;
  g_sdUsedAt    = now;
}

// Drop the cache so the next sdRefreshUsage(false) rescans immediately. Called
// after anything frees space (session delete, the net task's synced-audio trim)
// so "SD card full" clears as soon as the user follows its advice. Safe from
// either core: a single aligned 32-bit store.
static void sdInvalidateUsageCache()
{
  g_sdUsedAt = 0;
}

// Percent of the card in use, rounded. Reads the cache (no SD access).
static uint8_t sdUsedPercent()
{
  if (g_sdTotal == 0) return 0;
  return (uint8_t)((g_sdUsedCache * 100ULL + g_sdTotal / 2) / g_sdTotal);
}

// Bytes still free on the card (cached; no SD access).
static uint64_t sdFreeBytes()
{
  return (g_sdTotal > g_sdUsedCache) ? (g_sdTotal - g_sdUsedCache) : 0;
}

// Refuse to START a take without room for at least one full segment (+ slack).
// This is not the whole story: a take can run to RECORD_MAX_SECONDS, far past
// this reserve, so recordWavStreamToSd() also watches the remaining space and
// ends the take cleanly if the card fills mid-recording (keeping the audio).
// The SLP frees space by deleting sessions from the Sessions screen.
static const uint64_t SD_MIN_FREE_BYTES = (uint64_t)PCM_SEGMENT_BYTES + 256 * 1024;

// --- Battery (1S LiPo on GPIO34 behind the board's 0.5 divider) ------------

// Cell voltage in mV, or -1 when battery sensing is unavailable.
// Battery sense on GPIO9 (ADC1) via the board's 0.5 divider, per the Freenove
// FNK0104AB ESP32-S3 ch.5 doc. (Earlier 1.0.5 used GPIO34 from the *classic*
// ESP32 example, which isn't an ADC pin on the S3 -> adc_oneshot spam + bootloop.)
#define BAT_SENSE_ENABLED 1

// Temporary 1-point calibration (fw 1.5.5): a FULL cell read ~4142 mV raw on this
// unit, so scale readings up to put full at 4200 mV = 100%. This corrects the
// ~1.4% under-read from the divider tolerance + ESP32 ADC. Refine with a second
// low-end point (multimeter vs the /admin Cell mV column) if the low range drifts.
static const float BAT_CAL_GAIN = 4200.0f / 4142.0f;   // ~1.014

static int readBatteryMv()
{
#if BAT_SENSE_ENABLED
  uint32_t acc = 0;
  for (int i = 0; i < 8; i++) acc += analogReadMilliVolts(BAT_ADC_PIN);
  int cellMv = (int)((acc / 8) * 2);          // *2 undoes the hardware divider
  return (int)(cellMv * BAT_CAL_GAIN + 0.5f); // apply the 1-point calibration
#else
  return -1;
#endif
}

// Map a resting 1S LiPo cell voltage (mV) to a rough state-of-charge %.
// Returns 255 when the reading is unavailable (sensing disabled).
static uint8_t batteryPercent()
{
  int mv = readBatteryMv();
  if (mv < 0) return 255;
  static const int lut[][2] = {
    {4200,100},{4150,95},{4110,90},{4080,85},{4020,80},{3980,75},
    {3950,70},{3910,65},{3870,60},{3850,55},{3840,50},{3820,45},
    {3800,40},{3790,35},{3770,30},{3750,25},{3730,20},{3710,15},
    {3690,10},{3610,5},{3270,0},
  };
  const int n = sizeof(lut) / sizeof(lut[0]);
  if (mv >= lut[0][0]) return 100;
  if (mv <= lut[n - 1][0]) return 0;
  for (int i = 0; i < n - 1; i++) {
    if (mv <= lut[i][0] && mv > lut[i + 1][0]) {
      int v1 = lut[i][0], p1 = lut[i][1], v2 = lut[i + 1][0], p2 = lut[i + 1][1];
      return (uint8_t)(p2 + (long)(mv - v2) * (p1 - p2) / (v1 - v2));
    }
  }
  return 0;
}

// Battery glyph that matches the charge level.
static const char *batterySymbol(uint8_t pct)
{
  if (pct >= 90) return LV_SYMBOL_BATTERY_FULL;
  if (pct >= 65) return LV_SYMBOL_BATTERY_3;
  if (pct >= 40) return LV_SYMBOL_BATTERY_2;
  if (pct >= 15) return LV_SYMBOL_BATTERY_1;
  return LV_SYMBOL_BATTERY_EMPTY;
}

// Charging detection WITHOUT a dedicated charge-status GPIO (fw 1.5.2).
// The board / charge module exposes no CHRG line to the ESP, so we can't read the
// charger directly. The old code used `if (Serial)` (any USB *power* enumerated ->
// "charging", a false positive whenever the unit was merely plugged for power) and
// a fixed >= 4250 mV guess. Instead, watch the cell-voltage TREND: an external
// charger pushes the voltage UP; the device's own load pulls an unplugged cell
// DOWN. So a sustained RISE = on charge, a drop = unplugged. A level a resting 1S
// LiPo can never reach (>= 4300 mV) also means external power. Sampled every ~5 s
// with hysteresis so ADC noise doesn't flicker the icon.
// (For rock-solid detection, wire the charge board's CHRG pad to a spare GPIO and
//  read it LOW = charging — see Hardware.md §8.30.)
static bool isUsbCharging()
{
  static uint32_t lastMs = 0;
  static int      lastMv = -1;
  static bool     state  = false;
  uint32_t now = millis();
  if (lastMs != 0 && now - lastMs < 5000) return state;  // decision cached ~5 s
  lastMs = now;

  int mv = readBatteryMv();
  if (mv < 0) { state = false; lastMv = -1; return false; }  // no sensing -> unknown

  if (mv >= 4300) {                       // above any resting level -> external power
    state = true;
  } else if (lastMv >= 0) {
    int delta = mv - lastMv;
    if (delta >= 15)       state = true;  // voltage climbing -> charging
    else if (delta <= -15) state = false; // voltage sagging  -> unplugged
    // |delta| < 15: flat -> keep previous state (hysteresis, avoids noise flicker)
  }
  lastMv = mv;
  return state;
}

// --- Low-battery protection (fw 1.5.3) --------------------------------------
// A LiPo driven below ~3.0 V is permanently damaged. This board has no hardware
// low-voltage cutoff wired to the ESP, so the firmware guards the cell: near
// empty it warns and drops the ESP into deep sleep (~10 uA vs the ~100 mA running
// floor), which effectively STOPS the discharge so the cell can't sink further.
// Thresholds are in mV AT THE CELL and are deliberately low because the device's
// own load sags the reading below the true resting voltage.
//   *** Use a PROTECTED charge board (TP4056 + DW01/8205, the 6-pad version) for a
//   *** true hardware cutoff too - firmware alone can't protect a bare cell if the
//   *** device is off. See Hardware.md §8.31.
static const int BAT_CRIT_MV = 3350;   // ~3-5% under load -> sleep to protect cell

// Warn, then deep sleep. Wakes on a RECORD-button press (GPIO2, active LOW) or a
// 1 h timer; setup()'s early timer-wake check re-samples the cell and only boots
// normally once it has recovered (been charged).
// quiet=true is the timer-wake re-sleep path: no backlight, no LVGL, no delays -
// it may run before the display/LVGL are initialised, and the whole point of the
// wake is one ADC read. The old loud 5-min recheck (full backlight + 6 s guard +
// 2.6 s warning every wake) averaged ~4 mA and kept draining the cell this sleep
// exists to protect.
static void enterBatterySleep(bool quiet)
{
  recordStopReq = true;                        // abort any capture path cleanly
  if (!quiet) {
    wakeScreen();
    backlightSet(BL_FULL);
    showStatus("Pin yeu - hay sac", "Thiet bi tam tat de bao ve pin");
    pumpGuiMs(2600);
  }
  backlightSet(0);                             // screen fully off for the sleep
  rtc_gpio_pullup_en((gpio_num_t)REC_BTN_PIN); // hold the button HIGH while asleep
  rtc_gpio_pulldown_dis((gpio_num_t)REC_BTN_PIN);
  esp_sleep_enable_ext0_wakeup((gpio_num_t)REC_BTN_PIN, 0); // wake on press (LOW)
  esp_sleep_enable_timer_wakeup(3600ULL * 1000000ULL);      // hourly cell re-check
  esp_deep_sleep_start();                      // never returns
}

// Called every loop: if the cell is critically low for a sustained window and not
// on charge, protect it by sleeping. Never interrupts a recording/save in flight.
static void serviceBatteryGuard()
{
  if (currentState == RECORDING || currentState == SAVING_TO_SD) return;
  static uint32_t last = 0;
  static int      lowStreak = 0;
  uint32_t now = millis();
  if (last != 0 && now - last < 8000) return;  // sample ~8 s
  last = now;
  if (isUsbCharging()) { lowStreak = 0; return; }   // on charge -> never sleep
  int mv = readBatteryMv();
  if (mv < 0) return;                                // no sensing -> can't guard
  if (mv < BAT_CRIT_MV) {
    if (++lowStreak >= 3) enterBatterySleep();       // ~24 s sustained -> sleep
  } else {
    lowStreak = 0;
  }
}

// At boot: if the cell is critically low AND not obviously being charged, don't
// even spin up the ~100 mA running state - warn and go back to sleep. A short
// re-sample lets a unit that's ACTUALLY on a charger (voltage climbing) boot.
static void batteryBootGuard()
{
  int mv = readBatteryMv();
  if (mv < 0 || mv >= BAT_CRIT_MV) return;     // sensing off or enough charge -> boot
  backlightSet(BL_FULL);
  showStatus("Kiem tra pin...", "");
  int mv0 = mv;
  delay(6000);                                 // rare path - watch for a charge climb
  int mv1 = readBatteryMv();
  if (mv1 >= BAT_CRIT_MV || (mv1 - mv0) >= 15) return; // recovered/rising -> boot
  enterBatterySleep();
}

// --- Audio-path health (fw: dead-mic + I2S-fault detection) ------------------
// Set when an I2S read returns 0 mid-take (stalled DMA / codec fault). The next
// take tears the audio path down and re-inits it instead of re-entering the
// same broken RX channel forever (which used to need a power cycle).
static bool g_audioFaulted = false;
// Peak |sample| of the last capture run, written into the session JSON. A dead
// or muted mic clocks full-length buffers of zeros: without this, a silent
// 40-minute WAV saved, uploaded, byte-verified and trimmed with nobody the
// wiser. A live room through the +30 dB PGA sits far above this floor.
static uint32_t g_lastTakePeak = 0;
static const uint32_t SILENT_PEAK_ABS = 40;   // 16-bit counts; digital silence only

static bool isSessionSynced(const char *dir, uint32_t n)
{
  char probe[160];
  sessionSyncMarkPath(probe, sizeof(probe), dir, n);
  return SD_MMC.exists(probe);
}

static uint32_t countUnsynced(const char *dir)
{
  bool present[SESSION_NUM_MAX + 1];
  scanSessionNumbers(dir, present);
  uint32_t pending = 0;
  for (uint32_t i = 1; i <= SESSION_NUM_MAX; i++) {
    if (present[i] && !isSessionSynced(dir, i)) pending++;
  }
  return pending;
}

static void markSessionSynced(const char *dir, uint32_t n)
{
  char path[160];
  sessionSyncMarkPath(path, sizeof(path), dir, n);
  File f = SD_MMC.open(path, FILE_WRITE);
  if (f) {
    f.print("synced-demo");
    f.close();
  }
}

static void jsonEscapeToBuf(const char *value, char *out, size_t outSize)
{
  size_t j = 0;
  for (size_t i = 0; value[i] != '\0' && j + 2 < outSize; i++) {
    char c = value[i];
    if (c == '\\' || c == '"') { out[j++] = '\\'; out[j++] = c; }
    else if (c == '\n')        { out[j++] = '\\'; out[j++] = 'n'; }
    else                       { out[j++] = c; }
  }
  out[j] = '\0';
}

static bool saveMetadataToSd(const char *jsonPath, const char *wavPath,
                             uint32_t pcmBytes, uint32_t durationSec, uint32_t sessionNum)
{
  const SatePatient &p = g_patients[currentPatientIndex];

  File file = SD_MMC.open(jsonPath, FILE_WRITE);
  if (!file) return false;

  char nameEsc[64], typeEsc[64], clinEsc[64];
  jsonEscapeToBuf(p.displayName, nameEsc, sizeof(nameEsc));
  jsonEscapeToBuf(p.sessionType, typeEsc, sizeof(typeEsc));
  jsonEscapeToBuf(p.clinician,  clinEsc, sizeof(clinEsc));

  file.println("{");
  file.printf("  \"firmware_version\": \"%s\",\n", FIRMWARE_VERSION);
  file.printf("  \"patient_id\": \"%s\",\n", p.patientId);
  file.printf("  \"patient_name\": \"%s\",\n", nameEsc);
  file.printf("  \"age\": \"%s\",\n", p.age);
  file.printf("  \"session_type\": \"%s\",\n", typeEsc);
  file.printf("  \"clinician\": \"%s\",\n", clinEsc);
  file.printf("  \"session_number\": %lu,\n", (unsigned long)sessionNum);
  file.printf("  \"audio_path\": \"%s\",\n", wavPath);
  file.printf("  \"audio_pcm_bytes\": %lu,\n", (unsigned long)pcmBytes);
  file.printf("  \"duration_seconds\": %lu,\n", (unsigned long)durationSec);
  file.printf("  \"sample_rate\": %lu,\n", (unsigned long)AUDIO_SAMPLE_RATE);
  file.printf("  \"bit_depth\": %d,\n", AUDIO_BIT_DEPTH);
  file.printf("  \"channels\": %d,\n", AUDIO_CHANNELS);
  file.printf("  \"created_ms_since_boot\": %lu,\n", (unsigned long)millis());
  // Peak |sample| of the capture (this run only, for a crash-resumed take).
  // A near-zero value across a full-length take = dead/muted mic; the server
  // can flag it before the on-device audio is trimmed.
  file.printf("  \"peak_abs\": %lu,\n", (unsigned long)g_lastTakePeak);
  // Flag offsets (ms from start) marked with the FLAG button during the take.
  file.print("  \"flags_ms\": [");
  for (int i = 0; i < g_flagCount; i++) {
    if (i) file.print(",");
    file.printf("%lu", (unsigned long)g_flagMs[i]);
  }
  file.println("]");
  file.println("}");
  file.close();
  return true;
}

// -----------------------------------------------------------------------------
// WAV header helpers
// -----------------------------------------------------------------------------

static void writeWavHeader(File &file, uint32_t pcmBytes)
{
  uint8_t header[44];
  uint32_t byteRate   = AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * (AUDIO_BIT_DEPTH / 8);
  uint16_t blockAlign = AUDIO_CHANNELS * (AUDIO_BIT_DEPTH / 8);
  uint32_t riffSize   = 36 + pcmBytes;

  memcpy(header + 0,  "RIFF", 4);
  memcpy(header + 4,  &riffSize, 4);
  memcpy(header + 8,  "WAVE", 4);
  memcpy(header + 12, "fmt ", 4);
  uint32_t fmtSize = 16;                   memcpy(header + 16, &fmtSize, 4);
  uint16_t audioFormat = 1;                memcpy(header + 20, &audioFormat, 2);
  uint16_t channels = AUDIO_CHANNELS;      memcpy(header + 22, &channels, 2);
  uint32_t sampleRate = AUDIO_SAMPLE_RATE; memcpy(header + 24, &sampleRate, 4);
  memcpy(header + 28, &byteRate, 4);
  memcpy(header + 32, &blockAlign, 2);
  uint16_t bits = AUDIO_BIT_DEPTH;         memcpy(header + 34, &bits, 2);
  memcpy(header + 36, "data", 4);
  memcpy(header + 40, &pcmBytes, 4);

  file.write(header, sizeof(header));
}

static void patchWavHeader(File &file, uint32_t pcmBytes)
{
  uint32_t riffSize = 36 + pcmBytes;
  file.seek(4);  file.write((uint8_t *)&riffSize, 4);
  file.seek(40); file.write((uint8_t *)&pcmBytes, 4);
}

// Concatenate the PCM from all session_NNNN.partKK.wav segments into one final
// session_NNNN.wav, then delete the parts. Returns the merged PCM byte count (0
// on failure / no parts). When pumpUi is set, the GUI is serviced during the
// copy so the screen stays responsive while a long session is stitched.
static uint32_t mergeSessionParts(const char *finalWav, bool pumpUi)
{
  char pp[200];
  uint32_t total = 0;
  for (int k = 0;; k++) {
    sessionPartPath(pp, sizeof(pp), finalWav, k);
    if (!SD_MMC.exists(pp)) break;
    File f = SD_MMC.open(pp, FILE_READ);
    if (f) { uint32_t sz = f.size(); total += (sz > 44) ? (sz - 44) : 0; f.close(); }
  }
  if (total == 0) return 0;

  File out = SD_MMC.open(finalWav, FILE_WRITE);
  if (!out) return 0;
  writeWavHeader(out, total);

  // Big copy buffer: 4 KB reads/writes made the stitch crawl (~30 s for 6 MB);
  // 32 KB cuts the SD op count ~8x. Static so it stays off the loop-task stack.
  static uint8_t mergeBuf[32768];
  uint32_t lastUiMs = 0;
  for (int k = 0;; k++) {
    sessionPartPath(pp, sizeof(pp), finalWav, k);
    if (!SD_MMC.exists(pp)) break;
    File in = SD_MMC.open(pp, FILE_READ);
    if (in) {
      if (in.size() > 44) {
        in.seek(44); // skip the part's WAV header, copy PCM only
        for (;;) {
          size_t got = in.read(mergeBuf, sizeof(mergeBuf));
          if (got == 0) break;
          out.write(mergeBuf, got);
          if (pumpUi) {
            uint32_t now = millis();
            if (now - lastUiMs >= 120) { lastUiMs = now; lv_timer_handler(); delay(1); }
          }
        }
      }
      in.close();
    }
    SD_MMC.remove(pp);
  }
  out.flush();
  out.close();
  return total;
}

// On boot, look for sessions that have segment files but no final WAV (a crash
// or power-loss during recording) and stitch what was captured into a normal
// session, so it uploads like any other instead of being lost.
static void recoverOrphanSegments()
{
  File root = SD_MMC.open("/sate/patients");
  if (!root) return;
  File entry;
  char dir[120], finalWav[160], pp[200];
  while ((entry = root.openNextFile())) {
    if (!entry.isDirectory()) { entry.close(); continue; }
    const char *full = entry.name();
    const char *pid = strrchr(full, '/');
    pid = pid ? pid + 1 : full;
    snprintf(dir, sizeof(dir), "/sate/patients/%s", pid);
    entry.close();
    for (uint32_t n = 1; n <= 9999; n++) {
      sessionWavPath(finalWav, sizeof(finalWav), dir, n);
      sessionPartPath(pp, sizeof(pp), finalWav, 0);
      bool hasPart0 = SD_MMC.exists(pp);
      bool hasFinal = SD_MMC.exists(finalWav);
      if (!hasPart0 && !hasFinal) break; // sessions are contiguous; done here
      if (hasPart0 && !hasFinal) {
        Serial.printf("[REC] recovering orphan segments: %s session %lu\n",
                      pid, (unsigned long)n);
        mergeSessionParts(finalWav, false); // build the final + delete parts
      } else if (hasPart0 && hasFinal) {
        for (int k = 0;; k++) { // stray parts beside a finished session: drop
          sessionPartPath(pp, sizeof(pp), finalWav, k);
          if (!SD_MMC.exists(pp)) break;
          SD_MMC.remove(pp);
        }
      }
    }
  }
  root.close();
}

// -----------------------------------------------------------------------------
// Audio init
// -----------------------------------------------------------------------------

static bool initAudio()
{
  pinMode(AP_ENABLE, OUTPUT);
  digitalWrite(AP_ENABLE, LOW);

  es8311_i2s.setPins(I2S_BCK, I2S_WS, I2S_DOUT, I2S_DINT, I2S_MCK);

  bool ok = es8311_i2s.begin(
    I2S_MODE_STD,
    AUDIO_SAMPLE_RATE,
    I2S_DATA_BIT_WIDTH_16BIT,
    I2S_SLOT_MODE_MONO,
    I2S_STD_SLOT_LEFT
  );
  if (!ok) {
    Serial.println("[AUD] I2S init failed");
    return false;
  }

  if (es8311_codec_init() != ESP_OK) {
    Serial.println("[AUD] ES8311 codec init failed");
    return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// STREAMED recording: mic -> 4 KB chunk -> SD, live countdown ring.
// -----------------------------------------------------------------------------

// Records until the SLP taps Stop (or the safety cap pcmTotal is hit). The WAV
// header is sized for the cap up front, then patched down to the real length.
// startPart/startWritten drive crash-resume: a fresh take passes 0/0 and begins
// at segment part00; a resumed take passes the next free part index and the PCM
// bytes already on the card, so new minutes append to the interrupted session
// and every offset (flags, progress, duration) stays absolute.
static bool recordWavStreamToSd(const char *wavPath, uint32_t *outPcmBytes,
                                uint32_t pcmTotal = PCM_MAX_BYTES,
                                int startPart = 0, uint32_t startWritten = 0)
{
  *outPcmBytes = 0;
  currentState = RECORDING;
  recordStopReq = false;
  // NOTE: connStopReq is deliberately NOT cleared here. sateHookStop() only latches
  // it while a take is armed, so it can never be stale — and clearing it here would
  // swallow a stop issued during this take's own start sequence.
  g_flagCount = 0;                         // fresh flag list for this take
                                           // (pre-crash flags lived in RAM and are lost)
  setStatePill("REC", COL_REC_BG, COL_REC);
  logHeap("record start");

  // Write into 1-minute segment files; each finished minute is flushed to SD so
  // a crash only loses the current minute (the rest is resumed on next boot).
  char partPath[200];
  int  part = startPart;
  sessionPartPath(partPath, sizeof(partPath), wavPath, part);
  File file = SD_MMC.open(partPath, FILE_WRITE);
  if (!file) {
    showStatus("Record failed", "Cannot create WAV on SD");
    return false;
  }
  writeWavHeader(file, PCM_SEGMENT_BYTES);
  showProgressOverlay("recording  -  press RECORD to stop", COL_REC,
                      false /*no on-screen Stop*/, true /*flag counter*/);

  // Drain stale I2S DMA samples so the recording starts clean.
  es8311_i2s.readBytes((char *)audioChunk, sizeof(audioChunk));

  uint32_t written = startWritten;  // total PCM across all segments (seeded on resume)
  uint32_t partWritten = 0;         // PCM in the current segment
  uint32_t lastUiMs = 0;
  uint32_t partFlushed = 0;         // partWritten value at the last mid-segment flush
  // Flush the open segment to SD every ~5 s so a power loss / brownout / watchdog
  // reset loses at most the last few seconds, not the whole current minute. Boot
  // recovery (prepareResumeSegments) sizes each segment from its ACTUAL on-disk
  // bytes and re-patches the header, so a plain flush (no header rewrite, no seek)
  // is enough - the file position stays at the end for the next append.
  const uint32_t FLUSH_EVERY_BYTES = PCM_BYTES_PER_SEC * 5;
  bool ok = true;
  // Running out of card mid-take is NOT a failure - it must never throw away the
  // minutes already captured (nothing deletes recordings automatically any more,
  // so a full card is a normal end-of-life state, not a bug). We stop the take
  // cleanly and keep every finished segment; the caller saves + uploads it as a
  // normal, shorter session.
  bool diskFull = false;
  const uint64_t freeAtStart = sdFreeBytes();

  // Cell + signal watch. loop()'s battery guard is blocked for the whole take
  // (up to ~62 min), so the capture loop samples the cell itself every ~10 s
  // and ends the take CLEANLY (segments patched + closed) before the cell
  // collapses mid-write. It also tracks the peak |sample| so a dead/muted mic
  // is caught during the take, not after the silent WAV synced and trimmed.
  uint32_t lastBatMs    = millis();
  int      batLowStreak = 0;
  bool     batCritical  = false;
  uint32_t peakAbs      = 0;

  // Read the mic in SMALL slices (~32 ms each) rather than one 4 KB block
  // (~128 ms). A short read means we return to service the GUI ~30x/sec, so the
  // on-screen Stop button and the FLAG/REC buttons feel instant instead of
  // sampling only ~8x/sec (which made Stop laggy / easy to miss). SD writes are
  // still buffered, so smaller writes cost little at 32 KB/s.
  const size_t REC_READ_BYTES = 1024;

  while (written < pcmTotal && !recordStopReq) {
    size_t want = pcmTotal - written;
    if (want > REC_READ_BYTES) want = REC_READ_BYTES;

    size_t got = es8311_i2s.readBytes((char *)audioChunk, want);
    if (got == 0) { ok = false; g_audioFaulted = true; break; }

    // Running peak over every sample (~512 int16 per slice - negligible cost).
    {
      const int16_t *smp = (const int16_t *)audioChunk;
      for (size_t i = 0; i < got / 2; i++) {
        int v = smp[i];
        if (v < 0) v = -v;
        if ((uint32_t)v > peakAbs) peakAbs = (uint32_t)v;
      }
    }

    size_t put = file.write(audioChunk, got);
    // A short write means the card just filled. Keep what's already on disk.
    if (put != got) { written += put; partWritten += put; diskFull = true; break; }
    written += put;
    partWritten += put;

    // Stop BEFORE the card is truly full, while there's still room to close the
    // current segment cleanly. freeAtStart is cached at take start; only the bytes
    // added THIS run (written - startWritten) consume it, so a resumed take doesn't
    // count its already-on-card minutes as needing free space.
    if (freeAtStart < (uint64_t)(written - startWritten) + PCM_SEGMENT_BYTES) { diskFull = true; break; }

    // Roll to the next 1-minute segment.
    if (partWritten >= PCM_SEGMENT_BYTES) {
      patchWavHeader(file, partWritten);
      file.flush();
      file.close();
      part++;
      partWritten = 0;
      partFlushed = 0;
      sessionPartPath(partPath, sizeof(partPath), wavPath, part);
      file = SD_MMC.open(partPath, FILE_WRITE);
      if (!file) { diskFull = true; part--; break; } // no room for another segment
      writeWavHeader(file, PCM_SEGMENT_BYTES);
    } else if (partWritten - partFlushed >= FLUSH_EVERY_BYTES) {
      // Mid-segment durability point: push buffered audio to the card so a crash
      // in the current minute keeps everything up to here (recovery reads the
      // real file size). No header patch / seek - the write position is unchanged.
      file.flush();
      partFlushed = partWritten;
    }

    // Physical buttons during capture: RECORD = stop, FLAG = mark this instant.
    // A remote "stop" command (connStopReq) ends the take exactly the same way —
    // before this, a server/app-started take could only be ended at the device.
    if (btnPressed(recBtn) || connStopReq) {
      connStopReq = false;
      recordStopReq = true;
      // Acknowledge the stop on-screen THIS frame so the user sees it took and
      // doesn't tap again (which used to start a stray second recording). The
      // overlay is hidden a few ms later in the finalize below.
      if (progressBig) lv_label_set_text(progressBig, LV_SYMBOL_SAVE);
      setStatePill("SAVE", COL_WARN_BG, COL_WARN);
    }
    if (btnPressed(flagBtn) && g_flagCount < FLAG_CAP_MAX) {
      g_flagMs[g_flagCount++] =
          (uint32_t)((uint64_t)written * 1000ULL / PCM_BYTES_PER_SEC);
      if (progressFlag) {
        char fb[28];
        snprintf(fb, sizeof(fb), LV_SYMBOL_BELL "  Flags: %d", g_flagCount);
        lv_label_set_text(progressFlag, fb);
      }
    }

    // Refresh the ring + elapsed text a few times a second (cheap to skip), but
    // service the GUI/touch EVERY slice so the Stop button stays responsive.
    uint32_t now = millis();
    if (now - lastUiMs >= 150) {
      lastUiMs = now;
      uint32_t elapsed = written / PCM_BYTES_PER_SEC;
      char big[8];
      snprintf(big, sizeof(big), "%lu", (unsigned long)elapsed);
      updateProgress((uint16_t)((written * 1000ULL) / pcmTotal), big);
    }
    if (now - lastBatMs >= 10000) {
      lastBatMs = now;
      int mv = readBatteryMv();
      if (mv >= 0 && mv < BAT_CRIT_MV) {
        if (++batLowStreak >= 3) {          // ~30 s sustained under the floor
          batCritical  = true;
          recordStopReq = true;             // clean stop beats a brownout mid-write
        } else if (progressSmall) {
          lv_label_set_text(progressSmall,
                            LV_SYMBOL_BATTERY_EMPTY "  Low battery - charge soon");
        }
      } else {
        batLowStreak = 0;
        // Digital silence 15+ s into this run: warn NOW, while the SLP can
        // still fix the mic, instead of after the silent take synced.
        if (peakAbs < SILENT_PEAK_ABS && progressSmall &&
            written - startWritten >= PCM_BYTES_PER_SEC * 15)
          lv_label_set_text(progressSmall,
                            LV_SYMBOL_WARNING "  No audio detected - check mic");
      }
    }
    lv_timer_handler();   // reads touch + paints; ~30 Hz keeps Stop instant
    // Yield to the scheduler so a multi-minute capture can't starve the idle
    // task (and trip its watchdog) - this is what keeps long records stable.
    delay(1);
  }

  if (file) {
    patchWavHeader(file, partWritten);
    file.flush();
    file.close();
  }
  logHeap("record end");
  g_lastTakePeak = peakAbs;   // saveMetadataToSd stamps it into the session JSON

  // Only a take with NOTHING usable is discarded. A real read/write error that
  // still produced audio keeps that audio: the segments on the card may be the
  // only copy of what the patient said, so they are saved and uploaded as a
  // (shorter) session rather than deleted to keep the error path tidy.
  if (written == 0) {
    hideProgressOverlay();
    showStatus("Record failed", ok ? "No audio captured" : "I2S read or SD write error");
    for (int k = 0; k <= part; k++) { // clean up empty segments
      sessionPartPath(partPath, sizeof(partPath), wavPath, k);
      SD_MMC.remove(partPath);
    }
    return false;
  }

  // No on-device merge: the 1-minute segments stay on the SD card and the
  // server stitches them as they upload (chunked). Recording ends instantly -
  // no "Saving..." wait.
  hideProgressOverlay();

  // Tell the SLP the take ended on its own, so a short recording is never a
  // silent surprise. The audio is already safe either way.
  if (batCritical) {
    showStatus("Battery critically low", "Recording stopped and saved - charge now");
    pumpGuiMs(1800);
  } else if (diskFull) {
    showStatus("SD card full", "Recording stopped and saved - free space soon");
    pumpGuiMs(1800);
  } else if (!ok) {
    showStatus("Recording stopped early", "Audio up to this point was saved");
    pumpGuiMs(1800);
  } else if (written >= pcmTotal && pcmTotal == PCM_MAX_BYTES) {
    // Hit the ~62-min safety ceiling. The SLP never pressed Stop, so nothing
    // after this instant is being captured — say so instead of snapping back
    // to Home as if the take were ended on purpose. (An exact-duration remote
    // take also exits on written >= pcmTotal; its cap is below PCM_MAX_BYTES,
    // and stopping there is the requested behaviour, so it stays silent.)
    showStatus("Recording limit reached", "62 min max - take saved");
    pumpGuiMs(1800);
  } else if (peakAbs < SILENT_PEAK_ABS &&
             written - startWritten >= PCM_BYTES_PER_SEC * 15) {
    // Whole run was digital silence: the mic/codec path is dead or muted. The
    // take is still saved and uploaded (never discard possible patient audio),
    // but the SLP must not walk away believing the sample was captured.
    showStatus("No audio detected", "Mic may be faulty - take saved, check device");
    pumpGuiMs(1800);
  }

  *outPcmBytes = written;
  Serial.printf("[REC] complete: %d segment(s), %lu PCM bytes (no merge)\n",
                part + 1, (unsigned long)written);
  return true;
}

// -----------------------------------------------------------------------------
// STREAMED playback: SD -> 4 KB chunk -> I2S.
// -----------------------------------------------------------------------------

static bool playWavStreamFromSd(const char *path, const char *caption)
{
  DeviceState prev = currentState;
  currentState = PLAYING;
  setStatePill("PLAY", COL_PRIMARY_BG, COL_PRIMARY_DK);
  logHeap("play start");

  File file = SD_MMC.open(path, FILE_READ);
  if (!file) {
    showStatus("Playback failed", "Cannot open WAV");
    currentState = prev;
    return false;
  }

  size_t size = file.size();
  if (size <= 44) {
    file.close();
    showStatus("Playback failed", "Empty WAV");
    currentState = prev;
    return false;
  }

  file.seek(44);
  uint32_t pcmTotal = size - 44;
  uint32_t sent = 0;
  uint32_t lastUiMs = 0;

  recordStopReq = false; // the overlay Stop button stops playback too
  showProgressOverlay(caption, COL_PRIMARY, true /*Stop = back out of playback*/);

  while (sent < pcmTotal && !recordStopReq) {
    size_t want = pcmTotal - sent;
    if (want > 1024) want = 1024;          // small slices -> responsive Stop
    size_t got = file.read(audioChunk, want);
    if (got == 0) break;

    es8311_i2s.write(audioChunk, got);   // blocks on DMA, keeps audio timing
    sent += got;

    // Physical RECORD button stops playback too (mirrors the on-screen Stop).
    if (btnPressed(recBtn)) recordStopReq = true;
    (void)btnPressed(flagBtn);             // flag is a no-op during playback

    uint32_t now = millis();
    if (now - lastUiMs >= 200) {
      lastUiMs = now;
      uint32_t secLeft = (pcmTotal - sent + PCM_BYTES_PER_SEC - 1) / PCM_BYTES_PER_SEC;
      char big[8];
      snprintf(big, sizeof(big), "%lu", (unsigned long)secLeft);
      updateProgress((uint16_t)((sent * 1000ULL) / pcmTotal), big);
    }
    lv_timer_handler();   // ~15-30 Hz: keeps the Stop button responsive
  }

  file.close();
  hideProgressOverlay();
  logHeap("play end");
  currentState = prev;
  return true;
}

// Play a session for on-device review. New recordings are stored as 1-minute
// segments (no merge), so play them back to back; fall back to a legacy merged
// .wav if one exists.
static bool playSessionAudio(const char *dir, uint32_t n, const char *caption)
{
  char wav[160];
  sessionWavPath(wav, sizeof(wav), dir, n);
  if (SD_MMC.exists(wav)) return playWavStreamFromSd(wav, caption);

  char pp[200];
  uint32_t totalPcm = 0;
  for (int k = 0;; k++) {
    sessionPartPath(pp, sizeof(pp), wav, k);
    if (!SD_MMC.exists(pp)) break;
    File f = SD_MMC.open(pp, FILE_READ);
    if (f) { uint32_t sz = f.size(); totalPcm += (sz > 44) ? (sz - 44) : 0; f.close(); }
  }
  if (totalPcm == 0) { showStatus("Playback failed", "No audio"); return false; }

  DeviceState prev = currentState;
  currentState = PLAYING;
  setStatePill("PLAY", COL_PRIMARY_BG, COL_PRIMARY_DK);
  recordStopReq = false;
  showProgressOverlay(caption, COL_PRIMARY, true /*Stop*/);

  uint32_t played = 0, lastUiMs = 0;
  for (int k = 0; !recordStopReq; k++) {
    sessionPartPath(pp, sizeof(pp), wav, k);
    if (!SD_MMC.exists(pp)) break;
    File in = SD_MMC.open(pp, FILE_READ);
    if (!in) continue;
    if (in.size() > 44) {
      in.seek(44); // skip each segment's header, play PCM
      while (!recordStopReq) {
        size_t got = in.read(audioChunk, AUDIO_CHUNK_BYTES);
        if (got == 0) break;
        es8311_i2s.write(audioChunk, got);
        played += got;
        uint32_t now = millis();
        if (now - lastUiMs >= 200) {
          lastUiMs = now;
          uint32_t secLeft = (totalPcm - played + PCM_BYTES_PER_SEC - 1) / PCM_BYTES_PER_SEC;
          char big[8];
          snprintf(big, sizeof(big), "%lu", (unsigned long)secLeft);
          updateProgress((uint16_t)((played * 1000ULL) / totalPcm), big);
          lv_timer_handler();
        }
      }
    }
    in.close();
  }
  hideProgressOverlay();
  currentState = prev;
  return true;
}

// -----------------------------------------------------------------------------
// Screens
// -----------------------------------------------------------------------------

static void showOnboardingScreen();
static void showHomeScreen();
static void showSessionsScreen();
static void showSyncScreen();
static void showResultsScreen();
static void showConnectionScreen();
static void refreshHomeUpload();
static void refreshSessionsUpload();

// -----------------------------------------------------------------------------
// Live upload status: updated every loop tick on Home / Sessions WITHOUT
// rebuilding the screen, so uploading is always visible and never confusing.
// -----------------------------------------------------------------------------

// Home footer: a coloured dot + one status line + a thin byte-level bar that
// only appears while a session is actually streaming to the server.
static void refreshHomeUpload()
{
  // Battery chip: refreshed here (~250 ms cadence) but the ADC is only sampled
  // every ~5 s since the cell drifts slowly.
  if (homeBatText) {
    static uint32_t lastBat = 0;
    static uint8_t  batPct  = 255;
    static uint8_t  chgFrame = 0;
    static int8_t   wasCharging = -1;
    uint32_t now = millis();
    // TEMP (fw 1.5.6): the voltage-trend charge detection isn't reliable yet, so
    // hide the animated charging chip - always show the static %. Flip to 1 to
    // restore the effect once detection (or a CHRG pin) is trustworthy. NOTE: the
    // low-battery guard calls isUsbCharging() separately, so it's unaffected.
    #define SHOW_CHARGE_EFFECT 0
    bool charging = isUsbCharging();
    if (!SHOW_CHARGE_EFFECT) charging = false;
    bool sampled  = (lastBat == 0 || now - lastBat >= 5000);
    if (sampled) { lastBat = now; batPct = batteryPercent(); }

    char batTxt[28];
    if (charging) {
      // Animated charge: a bolt + the battery glyph sweeping EMPTY->FULL on a
      // ~1.3 s loop (advances each ~250 ms refresh), drawn green, so plugging
      // in USB-C is unmistakable. Keeps showing the real % alongside.
      static const char *fill[5] = {
        LV_SYMBOL_BATTERY_EMPTY, LV_SYMBOL_BATTERY_1, LV_SYMBOL_BATTERY_2,
        LV_SYMBOL_BATTERY_3,     LV_SYMBOL_BATTERY_FULL,
      };
      chgFrame = (uint8_t)((chgFrame + 1) % 5);
      if (batPct == 255)
        snprintf(batTxt, sizeof(batTxt), LV_SYMBOL_CHARGE " %s", fill[chgFrame]);
      else
        snprintf(batTxt, sizeof(batTxt), LV_SYMBOL_CHARGE " %s %u%%",
                 fill[chgFrame], batPct);
      lv_label_set_text(homeBatText, batTxt);
      lv_obj_set_style_text_color(homeBatText, lv_color_hex(COL_OK), 0);
    } else if (sampled || wasCharging == 1) {
      // Static chip: redraw on a fresh sample, or right after charging stops.
      if (batPct == 255)
        snprintf(batTxt, sizeof(batTxt), "%s", batterySymbol(100));
      else
        snprintf(batTxt, sizeof(batTxt), "%s %u%%", batterySymbol(batPct), batPct);
      lv_label_set_text(homeBatText, batTxt);
      uint32_t batCol = (batPct < 15) ? COL_REC : (batPct < 35) ? COL_WARN : COL_OK;
      lv_obj_set_style_text_color(homeBatText, lv_color_hex(batCol), 0);
    }
    wasCharging = charging ? 1 : 0;
  }

  if (!homeUpText || !homeUpBar || !homeUpDot) return;

  uint32_t sent = 0, total = 0;
  bool uploading = connUploadProgress(&sent, &total);
  int  pct       = connUploadPercent();
  uint32_t pending = connPendingTotal();
  ConnMode m = connGetMode();
  bool online = (m == CONN_WIFI_ONLINE);

  char t[72];
  if (uploading && pct >= 0) {
    if (pending > 1)
      snprintf(t, sizeof(t), "Uploading to SATE  %d%%   -   %lu left",
               pct, (unsigned long)pending);
    else
      snprintf(t, sizeof(t), "Uploading to SATE  %d%%", pct);
    lv_label_set_text(homeUpText, t);
    lv_obj_set_style_text_color(homeUpText, lv_color_hex(COL_PRIMARY_DK), 0);
    lv_obj_set_style_bg_color(homeUpDot, lv_color_hex(COL_PRIMARY), 0);
    lv_obj_clear_flag(homeUpBar, LV_OBJ_FLAG_HIDDEN);
    lv_bar_set_value(homeUpBar, pct * 10, LV_ANIM_ON);
  } else if (connSdFault()) {
    // The card is refusing reads/writes: pending==0 here is "cannot read", not
    // "all synced" - never show the reassuring tick over a failed card.
    lv_obj_add_flag(homeUpBar, LV_OBJ_FLAG_HIDDEN);
    lv_label_set_text(homeUpText, LV_SYMBOL_WARNING "  SD card error - check card");
    lv_obj_set_style_text_color(homeUpText, lv_color_hex(COL_REC), 0);
    lv_obj_set_style_bg_color(homeUpDot, lv_color_hex(COL_REC), 0);
  } else if (pending > 0) {
    lv_obj_add_flag(homeUpBar, LV_OBJ_FLAG_HIDDEN);
    if (online) {
      snprintf(t, sizeof(t), "Syncing %lu session(s) to SATE...",
               (unsigned long)pending);
      lv_obj_set_style_text_color(homeUpText, lv_color_hex(COL_PRIMARY_DK), 0);
      lv_obj_set_style_bg_color(homeUpDot, lv_color_hex(COL_PRIMARY), 0);
    } else {
      snprintf(t, sizeof(t), "%lu pending  -  syncs when online",
               (unsigned long)pending);
      lv_obj_set_style_text_color(homeUpText, lv_color_hex(COL_WARN), 0);
      lv_obj_set_style_bg_color(homeUpDot, lv_color_hex(COL_WARN), 0);
    }
    lv_label_set_text(homeUpText, t);
  } else {
    lv_obj_add_flag(homeUpBar, LV_OBJ_FLAG_HIDDEN);
    lv_label_set_text(homeUpText, LV_SYMBOL_OK "  All sessions synced to SATE");
    lv_obj_set_style_text_color(homeUpText, lv_color_hex(COL_OK), 0);
    lv_obj_set_style_bg_color(homeUpDot, lv_color_hex(COL_OK), 0);
  }
}

// Sessions list: recompute each visible row's badge so the one in flight shows
// a live percent, freshly-synced rows flip to the SATE tick, and the rest read
// "queued" instead of a vague "pending".
static void refreshSessionsUpload()
{
  if (sessRowCount <= 0) return;

  char upPid[24];
  uint32_t upNum = 0;
  bool uploading = connUploadingSession(upPid, sizeof(upPid), &upNum);
  int  pct       = connUploadPercent();

  char dir[96];
  patientDirPath(dir, sizeof(dir));

  for (int i = 0; i < sessRowCount; i++) {
    lv_obj_t *badge = sessRowBadge[i];
    if (!badge) continue;
    uint32_t n = sessRowNum[i];

    if (uploading && upNum == n && pct >= 0 &&
        !strcmp(upPid, sessRowPid)) {
      char b[16];
      snprintf(b, sizeof(b), LV_SYMBOL_UPLOAD " %d%%", pct);
      lv_label_set_text(badge, b);
      lv_obj_set_style_text_color(badge, lv_color_hex(COL_PRIMARY_DK), 0);
    } else if (isSessionSynced(dir, n)) {
      lv_label_set_text(badge, LV_SYMBOL_OK " SATE");
      lv_obj_set_style_text_color(badge, lv_color_hex(COL_OK), 0);
    } else {
      lv_label_set_text(badge, "queued");
      lv_obj_set_style_text_color(badge, lv_color_hex(COL_WARN), 0);
    }
  }
}

// --- Onboarding gate ------------------------------------------------------
// Shown until the recorder is claimed to an account and has a patient roster.
// One vertical step row: state 0 = todo, 1 = active, 2 = done.

static void onboardStepRow(lv_obj_t *parent, int idx, const char *text, int state)
{
  lv_obj_t *icon = lv_label_create(parent);
  lv_label_set_text(icon, state == 2 ? LV_SYMBOL_OK
                          : state == 1 ? LV_SYMBOL_REFRESH
                                       : LV_SYMBOL_MINUS);
  uint32_t c = state == 2 ? COL_OK : state == 1 ? COL_PRIMARY : COL_TEXT_MUTED;
  lv_obj_set_style_text_color(icon, lv_color_hex(c), 0);
  lv_obj_align(icon, LV_ALIGN_TOP_LEFT, 0, idx * 26);

  lv_obj_t *lbl = lv_label_create(parent);
  lv_label_set_text(lbl, text);
  lv_obj_set_style_text_color(lbl, lv_color_hex(state == 0 ? COL_TEXT_MUTED : COL_TEXT_DARK), 0);
  lv_obj_align(lbl, LV_ALIGN_TOP_LEFT, 28, idx * 26);
}

static void showOnboardingScreen()
{
  uiResetPointers();
  lv_obj_clean(lv_scr_act());
  setScreenWhite();

  ConnMode m   = connGetMode();
  bool online  = (m == CONN_WIFI_ONLINE);
  bool appConn = connSetupActive();
  bool prov    = connProvisioned();
  bool hasPat  = g_patientCount > 0;

  lv_obj_t *title = lv_label_create(lv_scr_act());
  lv_label_set_text(title, "Set up recorder");
  setFont(title, &lv_font_montserrat_14);
  lv_obj_set_style_text_color(title, lv_color_hex(COL_PRIMARY_DK), 0);
  lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 12);

  // Device id + full Wi-Fi MAC, so the MAC can be added to a secured network's
  // allowlist before provisioning.
  lv_obj_t *sub = lv_label_create(lv_scr_act());
  char subTxt[64];
  snprintf(subTxt, sizeof(subTxt), "Device %s\nWi-Fi MAC %s", connSerial(), connMac());
  lv_label_set_text(sub, subTxt);
  lv_obj_set_style_text_color(sub, lv_color_hex(COL_TEXT_MUTED), 0);
  lv_obj_set_style_text_align(sub, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_align(sub, LV_ALIGN_TOP_MID, 0, 34);

  lv_obj_t *sym = lv_label_create(lv_scr_act());
  lv_label_set_text(sym, online ? LV_SYMBOL_WIFI : LV_SYMBOL_BLUETOOTH);
  lv_obj_set_style_text_color(sym, lv_color_hex(online ? COL_OK : COL_PRIMARY), 0);
  lv_obj_align(sym, LV_ALIGN_TOP_MID, 0, 80);

  lv_obj_t *st = lv_label_create(lv_scr_act());
  lv_label_set_text(st, connStatusText());
  lv_obj_set_width(st, 216);
  lv_label_set_long_mode(st, LV_LABEL_LONG_WRAP);
  lv_obj_set_style_text_align(st, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_color(st, lv_color_hex(COL_TEXT_DARK), 0);
  lv_obj_align(st, LV_ALIGN_TOP_MID, 0, 108);

  lv_obj_t *card = lv_obj_create(lv_scr_act());
  lv_obj_set_size(card, 216, 122);
  lv_obj_align(card, LV_ALIGN_TOP_MID, 0, 146);
  stylePanel(card);
  lv_obj_set_style_pad_all(card, 12, 0);

  int s1 = (m == CONN_OFF) ? 1 : 2;
  int s2 = (appConn || prov || online) ? 2 : (m == CONN_BLE_ADV ? 1 : 0);
  int s3 = (online || prov) ? 2 : ((m == CONN_WIFI_TRYING || appConn) ? 1 : 0);
  // Step 4 completes on account claim alone; patients are optional (the device
  // records standalone), so claiming is the last gate before Home.
  int s4 = prov ? 2 : (online ? 1 : 0);

  onboardStepRow(card, 0, "Bluetooth ready", s1);
  onboardStepRow(card, 1, "App connected", s2);
  onboardStepRow(card, 2, "Wi-Fi connected", s3);
  onboardStepRow(card, 3, "Account linked", s4);

  (void)hasPat;   // roster no longer gates onboarding

  lv_obj_t *foot = lv_label_create(lv_scr_act());
  lv_label_set_text(foot, "Open the SATE app to finish setup");
  lv_obj_set_width(foot, 216);
  lv_label_set_long_mode(foot, LV_LABEL_LONG_WRAP);
  lv_obj_set_style_text_align(foot, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_color(foot, lv_color_hex(COL_TEXT_MUTED), 0);
  lv_obj_align(foot, LV_ALIGN_BOTTOM_MID, 0, -10);

  currentState = ONBOARDING;
}

static void showHomeScreen()
{
  // Provisioned but no patient yet -> record standalone instead of blocking.
  ensureStandalonePatient();

  uiResetPointers();
  lv_obj_clean(lv_scr_act());
  setScreenWhite();
  createHeader("SATE Recorder");

  // --- Top status chips (SD + battery), small, right under the header --------
  // SD usage chip, top-left. Auto-detected capacity; amber past 75%, red past 90%.
  lv_obj_t *sdLbl = lv_label_create(lv_scr_act());
  setFont(sdLbl, &lv_font_montserrat_14);
  uint8_t sdPct = sdUsedPercent();
  char sdTxt[24];
  snprintf(sdTxt, sizeof(sdTxt), LV_SYMBOL_SD_CARD " %u%%", sdPct);
  lv_label_set_text(sdLbl, sdTxt);
  uint32_t sdCol = (sdPct >= 90) ? COL_REC : (sdPct >= 75) ? COL_WARN : COL_TEXT_MUTED;
  lv_obj_set_style_text_color(sdLbl, lv_color_hex(sdCol), 0);
  lv_obj_align(sdLbl, LV_ALIGN_TOP_LEFT, 14, 50);

  // Battery chip, top-right. Live-refreshed by refreshHomeUpload(). Only shown
  // when the board can actually sense the battery (see BAT_SENSE_ENABLED).
  uint8_t batPct = batteryPercent();
  if (batPct != 255) {
    homeBatText = lv_label_create(lv_scr_act());
    setFont(homeBatText, &lv_font_montserrat_14);
    char batTxt[24];
    snprintf(batTxt, sizeof(batTxt), "%s %u%%", batterySymbol(batPct), batPct);
    lv_label_set_text(homeBatText, batTxt);
    uint32_t batCol = (batPct < 15) ? COL_REC : (batPct < 35) ? COL_WARN : COL_OK;
    lv_obj_set_style_text_color(homeBatText, lv_color_hex(batCol), 0);
    lv_obj_align(homeBatText, LV_ALIGN_TOP_RIGHT, -14, 50);
  }

  // On-screen RECORD button: a big red circular target. Tapping it fires
  // ACT_RECORD (same path as the physical RECORD button on GPIO2), so the SLP
  // can start a take either way. The pressed state darkens the ring for feedback.
  lv_obj_t *recUi = lv_btn_create(lv_scr_act());
  lv_obj_set_size(recUi, 88, 88);
  lv_obj_align(recUi, LV_ALIGN_TOP_MID, 0, 72);
  lv_obj_set_style_radius(recUi, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_bg_color(recUi, lv_color_hex(COL_REC_BG), 0);
  lv_obj_set_style_bg_opa(recUi, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(recUi, 0, 0);
  lv_obj_set_style_shadow_width(recUi, 12, 0);
  lv_obj_set_style_shadow_ofs_y(recUi, 3, 0);
  lv_obj_set_style_shadow_color(recUi, lv_color_hex(COL_REC), 0);
  lv_obj_set_style_shadow_opa(recUi, LV_OPA_30, 0);
  lv_obj_set_style_bg_color(recUi, lv_color_hex(COL_REC), LV_STATE_PRESSED);
  lv_obj_set_style_translate_y(recUi, 1, LV_STATE_PRESSED);
  lv_obj_add_event_cb(recUi, actionEvent, LV_EVENT_CLICKED, (void *)(intptr_t)ACT_RECORD);

  lv_obj_t *recDot = lv_obj_create(recUi);
  lv_obj_set_size(recDot, 42, 42);
  lv_obj_center(recDot);
  lv_obj_set_style_radius(recDot, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_bg_color(recDot, lv_color_hex(COL_REC), 0);
  lv_obj_set_style_bg_opa(recDot, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(recDot, 0, 0);
  lv_obj_clear_flag(recDot, LV_OBJ_FLAG_CLICKABLE);   // let the parent get the tap
  lv_obj_clear_flag(recDot, LV_OBJ_FLAG_SCROLLABLE);

  patientName = lv_label_create(lv_scr_act());
  lv_label_set_text(patientName, "Ready to Record");
  setFont(patientName, &lv_font_montserrat_20);
  lv_obj_set_style_text_color(patientName, lv_color_hex(COL_TEXT_DARK), 0);
  lv_obj_align(patientName, LV_ALIGN_TOP_MID, 0, 174);

  // --- Always-visible upload status: a coloured dot + one line + a thin bar ---
  homeUpDot = lv_obj_create(lv_scr_act());
  lv_obj_set_size(homeUpDot, 10, 10);
  lv_obj_set_style_radius(homeUpDot, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_border_width(homeUpDot, 0, 0);
  lv_obj_set_style_bg_color(homeUpDot, lv_color_hex(COL_OK), 0);
  lv_obj_clear_flag(homeUpDot, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_align(homeUpDot, LV_ALIGN_TOP_LEFT, 14, 234);

  homeUpText = lv_label_create(lv_scr_act());
  setFont(homeUpText, &lv_font_montserrat_14);
  lv_obj_set_style_text_color(homeUpText, lv_color_hex(COL_OK), 0);
  lv_obj_set_width(homeUpText, 194);
  lv_label_set_long_mode(homeUpText, LV_LABEL_LONG_DOT);
  lv_obj_align(homeUpText, LV_ALIGN_TOP_LEFT, 32, 230);

  homeUpBar = lv_bar_create(lv_scr_act());
  lv_obj_set_size(homeUpBar, 212, 6);
  lv_obj_align(homeUpBar, LV_ALIGN_TOP_MID, 0, 254);
  lv_obj_set_style_radius(homeUpBar, 3, LV_PART_MAIN);
  lv_obj_set_style_radius(homeUpBar, 3, LV_PART_INDICATOR);
  lv_bar_set_range(homeUpBar, 0, 1000);
  lv_obj_set_style_bg_color(homeUpBar, lv_color_hex(COL_TRACK), LV_PART_MAIN);
  lv_obj_set_style_bg_color(homeUpBar, lv_color_hex(COL_PRIMARY), LV_PART_INDICATOR);
  lv_obj_add_flag(homeUpBar, LV_OBJ_FLAG_HIDDEN);

  // One full-width button: Sessions. Recording is the physical RECORD button,
  // uploading is automatic, and there is no patient to switch (standalone), so
  // Sessions is the only on-screen control left.
  lv_obj_t *btnSessions = makeActionButton(lv_scr_act(), LV_SYMBOL_LIST "  Sessions",
                                           COL_PRIMARY_BG, COL_PRIMARY_DK, ACT_OPEN_SESSIONS);
  lv_obj_set_size(btnSessions, 220, 46);
  lv_obj_align(btnSessions, LV_ALIGN_BOTTOM_MID, 0, -8);

  setStatePill("READY", COL_OK_BG, COL_OK);
  refreshHomeUpload();   // paint the live status immediately

  currentState = HOME;
}

// --- Sessions list --------------------------------------------------------

static void showSessionsScreen()
{
  uiResetPointers();
  lv_obj_clean(lv_scr_act());
  setScreenWhite();
  createHeader("Sessions", ACT_BACK_HOME, 2);   // 2x-bigger back button
  setStatePill("LIST", COL_PRIMARY_BG, COL_PRIMARY_DK);

  const SatePatient &p = g_patients[currentPatientIndex];

  lv_obj_t *who = lv_label_create(lv_scr_act());
  // Standalone is the implicit default - never surface the placeholder name.
  lv_label_set_text(who, g_standalonePatient ? "Recordings" : p.displayName);
  setFont(who, &lv_font_montserrat_20);
  lv_obj_set_style_text_color(who, lv_color_hex(COL_TEXT_DARK), 0);
  lv_obj_align(who, LV_ALIGN_TOP_MID, 0, 48);

  char dir[96];
  patientDirPath(dir, sizeof(dir));
  bool present[SESSION_NUM_MAX + 1] = {false};
  bool hasAudio[SESSION_NUM_MAX + 1] = {false};
  if (SD_MMC.exists(dir)) scanSessionNumbers(dir, present, hasAudio);
  // Only show recordings whose audio is still ON THE CARD. A synced-and-reclaimed
  // take is a tombstone kept purely for numbering - its audio lives on the server
  // now, there is nothing to play or delete here, so it must not appear as a
  // "record" the user counts. This is why the list showed 21 when only 5 remained.
  uint32_t total = 0;
  for (uint32_t i = 1; i <= SESSION_NUM_MAX; i++)
    if (hasAudio[i]) total++;

  if (total == 0) {
    lv_obj_t *empty = lv_label_create(lv_scr_act());
    lv_label_set_text(empty, "No recordings yet.\n\nGo back and tap Record.");
    lv_obj_set_style_text_color(empty, lv_color_hex(COL_TEXT_MUTED), 0);
    lv_obj_set_style_text_align(empty, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(empty, LV_ALIGN_CENTER, 0, 0);
    currentState = SESSIONS;
    return;
  }

  // All sessions, newest first, in a vertically scrollable list so the SLP can
  // reach every recording (no 6-item cap). Each row's status badge is tracked
  // so refreshSessionsUpload() can drive it live: the session in flight shows a
  // percent, freshly-synced rows flip to the SATE tick.
  lv_obj_t *list = lv_obj_create(lv_scr_act());
  lv_obj_set_size(list, 232, 240);
  lv_obj_align(list, LV_ALIGN_TOP_MID, 0, 74);
  lv_obj_set_style_bg_opa(list, LV_OPA_TRANSP, 0);
  lv_obj_set_style_border_width(list, 0, 0);
  lv_obj_set_style_pad_all(list, 4, 0);
  lv_obj_set_style_pad_row(list, 6, 0);
  lv_obj_set_flex_flow(list, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(list, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER,
                        LV_FLEX_ALIGN_CENTER);
  lv_obj_add_flag(list, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_set_scroll_dir(list, LV_DIR_VER);
  lv_obj_set_scrollbar_mode(list, LV_SCROLLBAR_MODE_AUTO);

  sessRowCount = 0;
  snprintf(sessRowPid, sizeof(sessRowPid), "%s", p.patientId);

  for (uint32_t n = SESSION_NUM_MAX; n >= 1; n--) {
    // Show only recordings with audio on the card; tombstones (synced + reclaimed)
    // are on the server, not here, and are skipped.
    if (!hasAudio[n]) {
      if (n == 1) break;   // avoid uint32 underflow
      continue;
    }
    // Plain info row (NOT a button): the device has no speaker, so sessions are
    // never played on-device - they only upload to SATE. Tapping the row does
    // nothing; the only control is the trash chip to delete.
    lv_obj_t *row = lv_obj_create(list);
    lv_obj_set_size(row, 216, 42);
    lv_obj_set_style_radius(row, 10, 0);
    lv_obj_set_style_bg_color(row, lv_color_hex(COL_CARD_BG), 0);
    lv_obj_set_style_bg_opa(row, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(row, lv_color_hex(COL_CARD_BORDER), 0);
    lv_obj_set_style_border_width(row, 1, 0);
    lv_obj_set_style_pad_all(row, 0, 0);
    lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *name = lv_label_create(row);
    char nameTxt[40];
    snprintf(nameTxt, sizeof(nameTxt), LV_SYMBOL_AUDIO "  Session %lu", (unsigned long)n);
    lv_label_set_text(name, nameTxt);
    setFont(name, &lv_font_montserrat_20);
    lv_obj_set_style_text_color(name, lv_color_hex(COL_TEXT_DARK), 0);
    lv_obj_align(name, LV_ALIGN_LEFT_MID, 6, 0);

    // Delete control: red trash chip on the right edge. A button nested in the
    // plain row, so a tap here fires delete.
    lv_obj_t *del = makeActionButton(row, LV_SYMBOL_TRASH, COL_REC, 0xFFFFFF,
                                     ACT_DELETE_SESSION, (int)n);
    lv_obj_set_size(del, 36, 34);
    lv_obj_align(del, LV_ALIGN_RIGHT_MID, -3, 0);
    lv_obj_set_style_radius(del, 8, 0);

    lv_obj_t *badge = lv_label_create(row);
    lv_obj_align(badge, LV_ALIGN_RIGHT_MID, -42, 0);
    // Real status at creation: rows past the live-refresh tracker's cap
    // (SESS_ROW_MAX) are never repainted, so without this they keep LVGL's
    // literal "Text" placeholder — hiding an old take's queued/synced state.
    bool rowSynced = isSessionSynced(dir, n);
    lv_label_set_text(badge, rowSynced ? LV_SYMBOL_OK " SATE" : "queued");
    lv_obj_set_style_text_color(badge, lv_color_hex(rowSynced ? COL_OK : COL_WARN), 0);
    if (sessRowCount < SESS_ROW_MAX) {
      sessRowBadge[sessRowCount] = badge;
      sessRowNum[sessRowCount]   = n;
      sessRowCount++;
    }

    if (n == 1) break;   // avoid uint32 underflow
  }

  refreshSessionsUpload();   // paint each badge's live status now

  lv_obj_t *hint = lv_label_create(lv_scr_act());
  lv_label_set_text(hint, "Auto-uploads to SATE  -  trash to delete");
  lv_obj_set_style_text_color(hint, lv_color_hex(COL_TEXT_MUTED), 0);
  lv_obj_align(hint, LV_ALIGN_BOTTOM_MID, 0, -8);

  currentState = SESSIONS;
}

// --- Connection screen ------------------------------------------------------
// Live link status: Bluetooth advertising -> app connected -> connecting
// Wi-Fi -> registering -> online. Rebuilt on every connectivity event.

static void showConnectionScreen()
{
  uiResetPointers();
  lv_obj_clean(lv_scr_act());
  setScreenWhite();
  createHeader("Connection", ACT_BACK_HOME);

  ConnMode m = connGetMode();
  const bool online = (m == CONN_WIFI_ONLINE);
  const bool ble    = (m == CONN_BLE_ADV || m == CONN_BLE_CONNECTED);

  setStatePill(online ? "WIFI" : ble ? "BLE" : "LINK",
               online ? COL_OK_BG : COL_PRIMARY_BG,
               online ? COL_OK : COL_PRIMARY_DK);

  // Big mode symbol
  lv_obj_t *sym = lv_label_create(lv_scr_act());
  lv_label_set_text(sym, online ? LV_SYMBOL_WIFI
                        : ble    ? LV_SYMBOL_BLUETOOTH
                                 : LV_SYMBOL_REFRESH);
  lv_obj_set_style_text_color(sym, lv_color_hex(online ? COL_OK : COL_PRIMARY), 0);
  lv_obj_align(sym, LV_ALIGN_TOP_MID, 0, 54);

  // Live status line (from connectivity.cpp)
  lv_obj_t *st = lv_label_create(lv_scr_act());
  lv_label_set_text(st, connStatusText());
  lv_obj_set_width(st, 216);
  lv_label_set_long_mode(st, LV_LABEL_LONG_WRAP);
  lv_obj_set_style_text_align(st, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_color(st, lv_color_hex(COL_TEXT_DARK), 0);
  lv_obj_align(st, LV_ALIGN_TOP_MID, 0, 84);

  // Detail rows
  lv_obj_t *panel = lv_obj_create(lv_scr_act());
  lv_obj_set_size(panel, 216, 132);
  lv_obj_align(panel, LV_ALIGN_TOP_MID, 0, 138);
  stylePanel(panel);
  lv_obj_set_style_pad_all(panel, 12, 0);

  char rows[260];
  char pendTxt[16];
  snprintf(pendTxt, sizeof(pendTxt), "%lu", (unsigned long)connPendingTotal());
  snprintf(rows, sizeof(rows),
           "Serial:  %s\nMode:  %s\nIP:  %s\nPending:  %s session(s)\nSetup:  %s",
           connSerial(),
           online ? "Wi-Fi (online)"
                  : m == CONN_BLE_CONNECTED ? "Bluetooth (app connected)"
                  : m == CONN_BLE_ADV       ? "Bluetooth (advertising)"
                  : m == CONN_WIFI_TRYING   ? "Connecting Wi-Fi..."
                                            : "-",
           connIp()[0] ? connIp() : "-",
           pendTxt,
           connProvisioned() ? "claimed" : "not set up");
  lv_obj_t *rowsLbl = lv_label_create(panel);
  lv_obj_set_width(rowsLbl, 192);
  lv_label_set_long_mode(rowsLbl, LV_LABEL_LONG_WRAP);
  lv_label_set_text(rowsLbl, rows);
  lv_obj_set_style_text_color(rowsLbl, lv_color_hex(COL_TEXT_MUTED), 0);
  lv_obj_set_style_text_line_space(rowsLbl, 5, 0);

  lv_obj_t *hint = lv_label_create(lv_scr_act());
  lv_label_set_text(hint, "Updates live");
  lv_obj_set_style_text_color(hint, lv_color_hex(COL_TEXT_MUTED), 0);
  lv_obj_align(hint, LV_ALIGN_BOTTOM_MID, 0, -12);

  currentState = CONNECTION;
}

// --- Sync screen ----------------------------------------------------------

static void showSyncScreen()
{
  uiResetPointers();
  lv_obj_clean(lv_scr_act());
  setScreenWhite();
  createHeader("Sync to SATE", ACT_BACK_HOME);
  setStatePill("SYNC", COL_PRIMARY_BG, COL_PRIMARY_DK);

  char dir[96];
  patientDirPath(dir, sizeof(dir));
  uint32_t pending = SD_MMC.exists(dir) ? countUnsynced(dir) : 0;

  lv_obj_t *panel = lv_obj_create(lv_scr_act());
  lv_obj_set_size(panel, 216, 150);
  lv_obj_align(panel, LV_ALIGN_TOP_MID, 0, 56);
  stylePanel(panel);

  lv_obj_t *cloud = lv_label_create(panel);
  lv_label_set_text(cloud, LV_SYMBOL_UPLOAD);
  lv_obj_set_style_text_color(cloud, lv_color_hex(COL_PRIMARY), 0);
  lv_obj_align(cloud, LV_ALIGN_TOP_MID, 0, 8);

  lv_obj_t *bigNum = lv_label_create(panel);
  char numTxt[16];
  snprintf(numTxt, sizeof(numTxt), "%lu", (unsigned long)pending);
  lv_label_set_text(bigNum, numTxt);
  lv_obj_set_style_text_color(bigNum, lv_color_hex(COL_TEXT_DARK), 0);
  lv_obj_align(bigNum, LV_ALIGN_CENTER, 0, -4);

  lv_obj_t *cap = lv_label_create(panel);
  lv_label_set_text(cap, pending == 1 ? "session pending upload" : "sessions pending upload");
  lv_obj_set_style_text_color(cap, lv_color_hex(COL_TEXT_MUTED), 0);
  lv_obj_align(cap, LV_ALIGN_CENTER, 0, 22);

  const bool online = (connGetMode() == CONN_WIFI_ONLINE);

  lv_obj_t *note = lv_label_create(panel);
  lv_label_set_text(note, online ? LV_SYMBOL_WIFI "  Online - uploads to SATE"
                                  : "Offline - sync via Wi-Fi or the app");
  lv_obj_set_style_text_color(note, lv_color_hex(online ? COL_OK : COL_WARN), 0);
  lv_obj_align(note, LV_ALIGN_BOTTOM_MID, 0, -8);

  const bool canSync = pending > 0 && online;
  lv_obj_t *btn = makeActionButton(lv_scr_act(),
                                   LV_SYMBOL_UPLOAD "  Upload to SATE",
                                   canSync ? COL_PRIMARY : COL_TRACK,
                                   canSync ? 0xFFFFFF : COL_TEXT_MUTED,
                                   ACT_RUN_SYNC);
  lv_obj_set_size(btn, 216, 46);
  lv_obj_align(btn, LV_ALIGN_BOTTOM_MID, 0, -16);
  if (!canSync) lv_obj_add_state(btn, LV_STATE_DISABLED);

  currentState = SYNC;
}

// --- Simulated upload + analysis -------------------------------------------

static void runSync()
{
  // Real upload only happens when the recorder itself is online over Wi-Fi.
  // Over Bluetooth the companion app pulls sessions; nothing to push here.
  if (connGetMode() != CONN_WIFI_ONLINE) {
    showStatus("Not online", "Use Wi-Fi or the SATE app to sync");
    pumpGuiMs(1300);
    showHomeScreen();
    return;
  }

  currentState = SYNCING;
  logHeap("sync start");

  char dir[96];
  patientDirPath(dir, sizeof(dir));

  // Sum the duration of what we are about to upload (from each session's WAV).
  bool present[SESSION_NUM_MAX + 1];
  scanSessionNumbers(dir, present);
  uint32_t uploadSec = 0;
  for (uint32_t n = 1; n <= SESSION_NUM_MAX; n++) {
    if (!present[n] || isSessionSynced(dir, n)) continue;
    char wavPath[160];
    sessionWavPath(wavPath, sizeof(wavPath), dir, n);
    File f = SD_MMC.open(wavPath, FILE_READ);
    if (f) { uint32_t b = (uint32_t)f.size(); f.close();
             uploadSec += (b > 44) ? (b - 44) / PCM_BYTES_PER_SEC : 0; }
  }

  const uint32_t startPending = connPendingTotal();

  // Build the full-screen sync progress view.
  uiResetPointers();
  lv_obj_clean(lv_scr_act());
  setScreenWhite();
  createHeader("Sync to SATE");
  setStatePill("SYNC", COL_WARN_BG, COL_WARN);

  lv_obj_t *fileLbl = lv_label_create(lv_scr_act());
  lv_obj_set_style_text_color(fileLbl, lv_color_hex(COL_TEXT_DARK), 0);
  lv_obj_align(fileLbl, LV_ALIGN_TOP_MID, 0, 96);
  lv_label_set_text(fileLbl, LV_SYMBOL_UPLOAD "  Uploading to SATE...");

  syncBar = lv_bar_create(lv_scr_act());
  lv_obj_set_size(syncBar, 196, 10);
  lv_obj_align(syncBar, LV_ALIGN_TOP_MID, 0, 130);
  lv_bar_set_range(syncBar, 0, 1000);
  lv_obj_set_style_radius(syncBar, 5, LV_PART_MAIN);
  lv_obj_set_style_radius(syncBar, 5, LV_PART_INDICATOR);
  lv_obj_set_style_bg_color(syncBar, lv_color_hex(COL_TRACK), LV_PART_MAIN);
  lv_obj_set_style_bg_color(syncBar, lv_color_hex(COL_PRIMARY), LV_PART_INDICATOR);

  syncBarText = lv_label_create(lv_scr_act());
  lv_obj_set_style_text_color(syncBarText, lv_color_hex(COL_TEXT_MUTED), 0);
  lv_obj_align(syncBarText, LV_ALIGN_TOP_MID, 0, 154);

  // Kick the connectivity upload sweep; the core-0 net task drives it to
  // completion (one session per pass, marked synced on SD only after the server
  // accepts it), so the pending count is ground truth. We only animate progress
  // here - we must NOT call connLoop() (it now runs on the net task; calling it
  // here too would double-drive uploads and race the shared HTTP client).
  connNotifyNewSession();

  uint32_t guard = millis() + 120000;   // hard stop so the UI never wedges
  uint32_t pending = startPending;
  while (pending > 0 && (int32_t)(millis() - guard) < 0 &&
         connGetMode() == CONN_WIFI_ONLINE) {
    runGui();
    delay(5);                  // let the net task make progress
    pending = connPendingTotal();
    uint32_t done = (startPending > pending) ? (startPending - pending) : 0;

    // Smooth byte-level progress: blend completed sessions with the fraction of
    // the session in flight, so a single small session still animates 0->100%
    // instead of sitting at "0 / 1" until it lands all at once.
    uint32_t permille;
    uint32_t sent = 0, total = 0;
    if (connUploadProgress(&sent, &total) && total) {
      uint32_t base = (done * 1000ULL) / startPending;          // sessions done
      uint32_t span = (startPending ? (1000ULL / startPending) : 1000);
      permille = base + (uint32_t)((uint64_t)sent * span / total); // + current
    } else {
      permille = startPending ? (uint32_t)((done * 1000ULL) / startPending) : 1000;
    }
    if (permille > 1000) permille = 1000;
    lv_bar_set_value(syncBar, (int32_t)permille, LV_ANIM_ON);

    char t[64];
    if (total) {
      snprintf(t, sizeof(t), "%lu / %lu  -  %lu%%",
               (unsigned long)done, (unsigned long)startPending,
               (unsigned long)(permille / 10));
    } else {
      snprintf(t, sizeof(t), "%lu / %lu uploaded",
               (unsigned long)done, (unsigned long)startPending);
    }
    lv_label_set_text(syncBarText, t);
    delay(15);
  }

  lastSync.uploaded = (int)((startPending > connPendingTotal())
                            ? startPending - connPendingTotal() : 0);
  lastSync.totalSec = uploadSec;
  snprintf(lastSync.patientName, sizeof(lastSync.patientName), "%s",
           g_patients[currentPatientIndex].displayName);

  logHeap("sync end");
  showResultsScreen();
}

// --- Results screen ---------------------------------------------------------

static void showResultsScreen()
{
  uiResetPointers();
  lv_obj_clean(lv_scr_act());
  setScreenWhite();
  createHeader("Sync complete");
  setStatePill("DONE", COL_OK_BG, COL_OK);

  // Big check
  lv_obj_t *check = lv_label_create(lv_scr_act());
  lv_label_set_text(check, LV_SYMBOL_OK);
  lv_obj_set_style_text_color(check, lv_color_hex(COL_OK), 0);
  lv_obj_align(check, LV_ALIGN_TOP_MID, 0, 58);

  lv_obj_t *headline = lv_label_create(lv_scr_act());
  char head[48];
  snprintf(head, sizeof(head), "%d session(s) uploaded", lastSync.uploaded);
  lv_label_set_text(headline, head);
  lv_obj_set_style_text_color(headline, lv_color_hex(COL_TEXT_DARK), 0);
  lv_obj_align(headline, LV_ALIGN_TOP_MID, 0, 88);

  lv_obj_t *panel = lv_obj_create(lv_scr_act());
  lv_obj_set_size(panel, 216, 120);
  lv_obj_align(panel, LV_ALIGN_TOP_MID, 0, 122);
  stylePanel(panel);
  lv_obj_set_style_pad_all(panel, 12, 0);

  char body[260];
  snprintf(
    body, sizeof(body),
    "Patient:  %s\n"
    "Uploaded:  %d session(s)\n"
    "Audio:  %lu:%02lu\n"
    "Sent to:  SATE Cloud\n"
    "Status:  saved to your account",
    lastSync.patientName[0] ? lastSync.patientName : "-",
    lastSync.uploaded,
    (unsigned long)(lastSync.totalSec / 60),
    (unsigned long)(lastSync.totalSec % 60));

  lv_obj_t *bodyLbl = lv_label_create(panel);
  lv_obj_set_width(bodyLbl, 192);
  lv_label_set_long_mode(bodyLbl, LV_LABEL_LONG_WRAP);
  lv_obj_set_style_text_color(bodyLbl, lv_color_hex(COL_TEXT_MUTED), 0);
  lv_obj_set_style_text_line_space(bodyLbl, 5, 0);
  lv_label_set_text(bodyLbl, body);

  lv_obj_t *footer = lv_label_create(lv_scr_act());
  uint32_t stillPending = connPendingTotal();
  char footTxt[64];
  if (stillPending > 0)
    snprintf(footTxt, sizeof(footTxt), "%lu still pending - will retry",
             (unsigned long)stillPending);
  else
    snprintf(footTxt, sizeof(footTxt), LV_SYMBOL_OK "  All sessions synced");
  lv_label_set_text(footer, footTxt);
  lv_obj_set_style_text_color(footer, lv_color_hex(stillPending ? COL_WARN : COL_OK), 0);
  lv_obj_align(footer, LV_ALIGN_TOP_MID, 0, 250);

  lv_obj_t *btn = makeActionButton(lv_scr_act(), "Done", COL_PRIMARY, 0xFFFFFF, ACT_RESULTS_DONE);
  lv_obj_set_size(btn, 216, 40);
  lv_obj_align(btn, LV_ALIGN_BOTTOM_MID, 0, -8);

  currentState = RESULTS;
}

// -----------------------------------------------------------------------------
// Record session flow
// -----------------------------------------------------------------------------

// Write the session metadata, bump counters, kick the uploader, and return to
// Home. Shared by a normal take and a crash-resumed one so both land identically.
static void finalizeSavedSession(const char *wavPath, const char *jsonPath,
                                 uint32_t sessionNum, uint32_t pcmBytes)
{
  currentState = SAVING_TO_SD;
  setStatePill("SAVE", COL_WARN_BG, COL_WARN);

  // Spinner while the metadata is written, so the stop press has clear feedback.
  showSavingOverlay();
  pumpGuiMs(80);           // paint the spinner before the (fast) SD write

  uint32_t durationSec = pcmBytes / PCM_BYTES_PER_SEC;
  saveMetadataToSd(jsonPath, wavPath, pcmBytes, durationSec, sessionNum);
  bumpTotalRecordings();    // lifetime count for the admin dashboard
  // Update the cached usage by what we just wrote, so the Home storage chip is
  // right without a fresh f_getfree scan.
  g_sdUsedCache += pcmBytes;
  if (g_sdUsedCache > g_sdTotal) g_sdUsedCache = g_sdTotal;
  connNotifyNewSession(); // Wi-Fi mode uploads it; BLE mode updates the advert

  // Release the SD bus so uploads can resume immediately.
  connSetUiSdBusy(false);
  // No artificial hold: the spinner already showed during the real save (the
  // pumpGuiMs(80) above + the write). Double-tap is blocked by the settle window
  // below, not the spinner, so go straight to Home for a snappy stop.
  hideSavingOverlay();
  showHomeScreen();
  // Drop any RECORD press queued during the take/save and start a brief settle
  // window, so a double-tap meant for "stop" doesn't immediately start a new take.
  g_recHit = false;
  g_recSettleUntil = millis() + 700;
  logHeap("session done");
}

// review  = play the sample back so the SLP can confirm it (on-device tap).
// pcmTotal = capture size; remote (app/server) captures are shorter and skip
//            the review playback since nobody is holding the unit.
static void runRecordSavePlaySession(bool review = true,
                                     uint32_t pcmTotal = PCM_MAX_BYTES)
{
  wakeScreen();   // keep the screen lit through the take (loop's dim-check is blocked)

  // Own the SD bus for the whole take: the net task pauses its uploads/scans so
  // they don't fight the capture writes (was a big source of begin/stop drag).
  connSetUiSdBusy(true);

  // SD self-heal: a nudged/re-seated card leaves every SD op failing until the
  // SDMMC host is re-initialised, which used to need a power cycle - the unit
  // silently could not record while looking perfectly healthy. Probe cheaply;
  // on failure wait for the net task to leave the card, then re-mount once.
  if (!sdProbe()) {
    uint32_t sdGuard = millis() + 8000;
    while (!connNetSdIdle() && (int32_t)(millis() - sdGuard) < 0) {
      lv_timer_handler();
      delay(5);
    }
    if (!connNetSdIdle() || !sdRemount()) {
      connSetUiSdBusy(false);
      showStatus("SD card error", "Reinsert the card, then try again");
      pumpGuiMs(1800);
      showHomeScreen();
      return;
    }
  }

  // A previous take died on an I2S read fault (readBytes returned 0). Nothing
  // else ever re-inits the audio path, so without this the next RECORD press
  // re-enters the same broken RX channel and fails identically until a power
  // cycle. Tear it down and bring it back up before this take arms.
  if (g_audioFaulted) {
    es8311_i2s.end();
    if (initAudio()) {
      g_audioFaulted = false;
      Serial.println("[REC] audio path re-initialised after I2S fault");
    } else {
      connSetUiSdBusy(false);
      showStatus("Audio error", "Codec re-init failed - restart the device");
      pumpGuiMs(1800);
      showHomeScreen();
      return;
    }
  }

  // Pre-flight cell check: loop()'s battery guard is blocked for the whole take
  // and a take can run ~62 min. Below the critical floor the cell cannot carry
  // any useful capture - refuse cleanly now instead of browning out mid-write.
  // (A plugged-in unit keeps recording: the charger holds the cell up.)
  {
    int mv = readBatteryMv();
    if (mv >= 0 && mv < BAT_CRIT_MV && !isUsbCharging()) {
      connSetUiSdBusy(false);
      showStatus("Battery too low", "Charge the device before recording");
      pumpGuiMs(1600);
      showHomeScreen();
      return;
    }
  }

  char dir[96];
  patientDirPath(dir, sizeof(dir));
  if (!SD_MMC.exists(dir)) SD_MMC.mkdir(dir);

  // Never silently drop a recording that might not be synced yet. If the card
  // is (nearly) full, refuse to start and tell the SLP to free space by hand.
  if (sdFreeBytes() < SD_MIN_FREE_BYTES) {
    connSetUiSdBusy(false);
    showStatus("SD card full", "Open Sessions and delete old recordings");
    pumpGuiMs(1600);
    showHomeScreen();
    return;
  }

  uint32_t sessionNum = findNextSessionIndex(dir);
  if (sessionNum == 0) {
    connSetUiSdBusy(false);
    showStatus("Folder full", "Too many sessions for patient");
    showHomeScreen();
    return;
  }

  char wavPath[160], jsonPath[160];
  sessionWavPath(wavPath, sizeof(wavPath), dir, sessionNum);
  sessionJsonPath(jsonPath, sizeof(jsonPath), dir, sessionNum);

  // Mark this take crash-resumable BEFORE the first sample lands. Since fw 1.5.16
  // this covers REMOTE/server-started takes too: an SLP who starts a recording from
  // the app expects it to keep going if the unit reboots (brownout / power blip),
  // not to end early. It resumes from local NVS + the SD segments alone — no Wi-Fi
  // and no server involvement — and can be ended at the device or with the remote
  // "stop" command (fw >=1.5.15). The `tries` boot-loop guard in
  // maybeResumeRecording() still applies. Cleared the instant capture returns.
  recTakeArmed = true;      // from here a remote "stop" belongs to this take
  recCrashMark(g_patients[currentPatientIndex].patientId, sessionNum, pcmTotal);
  // Report the live state HERE, for EVERY take - button, on-screen, and remote
  // alike. Only the remote branch used to report, so a button-started take
  // kept the heartbeat at "idle" for its whole duration and the app happily
  // queued a second record against a recorder that was already recording.
  connSetLiveState("recording");

  uint32_t pcmBytes = 0;
  bool ok = recordWavStreamToSd(wavPath, &pcmBytes, pcmTotal);
  recTakeArmed = false;
  // Drop any stop latched in the armed-but-not-capturing tail (ceiling / disk
  // full / I2S-error exits skip the loop's clear): it belongs to THIS take,
  // which is already over, and left set it would end the NEXT take at ~32 ms.
  // Order matters: disarm first so sateHookStop can't re-latch in between.
  connStopReq = false;
  connSetLiveState("idle");
  // Belt-and-braces for the arm race: a remote record that slipped in between
  // the loop() consuming a request and recTakeArmed going up (sateHookRecord
  // drops anything after that) is stale - the operator saw a pre-take state.
  // Left latched it would start an unattended take the moment we return Home.
  if (connRecordReq) {
    connRecordReq  = false;
    connRecordSecs = 0;
    Serial.println("[REC] remote record dropped - arrived during a take");
  }
  recCrashClear();   // every take is marked now, so every take clears its mark

  if (!ok) {
    SD_MMC.remove(wavPath);
    connSetUiSdBusy(false);
    pumpGuiMs(900);
    showHomeScreen();
    return;
  }

  finalizeSavedSession(wavPath, jsonPath, sessionNum, pcmBytes);
}

// Walk the existing part00.. segments of an interrupted session, summing their
// real PCM bytes and patching each header to that size (the last one was left
// cap-sized when the board died). Returns the next free part index; *outBytes =
// total PCM already captured, used to seed the resumed take's absolute offsets.
static int prepareResumeSegments(const char *wavPath, uint32_t *outBytes)
{
  char pp[200];
  uint32_t bytes = 0;
  int part = 0;
  for (;; part++) {
    sessionPartPath(pp, sizeof(pp), wavPath, part);
    if (!SD_MMC.exists(pp)) break;
    File f = SD_MMC.open(pp, FILE_READ);
    if (!f) break;
    uint32_t sz = f.size();
    f.close();
    uint32_t pcm = (sz > 44) ? (sz - 44) : 0;   // strip the 44-byte WAV header
    File pf = SD_MMC.open(pp, "r+");             // clean up the header in place
    if (pf) { patchWavHeader(pf, pcm); pf.flush(); pf.close(); }
    bytes += pcm;
  }
  *outBytes = bytes;
  return part;                                   // == count of existing segments
}

// Called once at boot: if a local take was interrupted mid-capture (NVS mark
// survived the reboot), continue recording into the SAME session instead of
// leaving it for the sync uploader. Audio is never lost either way - this just
// stitches the resumed minutes onto the interrupted ones as one recording.
static void maybeResumeRecording()
{
  g_prefs.begin("sate-rec", true);
  bool     active = g_prefs.getUChar("active", 0) == 1;
  uint8_t  tries  = g_prefs.getUChar("tries", 0);
  uint32_t sess   = g_prefs.getUInt("sess", 0);
  uint32_t cap    = g_prefs.getUInt("cap", 0);
  char pid[40] = {0};
  g_prefs.getString("pid", pid, sizeof(pid));
  g_prefs.end();
  if (cap == 0) cap = PCM_MAX_BYTES;   // mark written by older fw carries no cap

  // Diagnostics: this path used to be silent, so a take that failed to resume was
  // invisible on the wire. Every branch now says why (grep "[REC] resume").
  if (!active || sess == 0) {
    Serial.printf("[REC] resume: nothing to resume (active=%d sess=%lu)\n", (int)active, (unsigned long)sess);
    return;
  }
  Serial.printf("[REC] resume: interrupted take found - session %lu patient '%s' tries=%u\n",
                (unsigned long)sess, pid, (unsigned)tries);

  // Unprovisioned boot with a live mark: the reboot came from a factory reset /
  // server unclaim mid-take. The mark must not survive to fire on a LATER
  // provisioned boot (it would append a fresh take onto a session that may be
  // synced by then). The segments still upload as a normal unsynced session.
  if (!deviceReady()) {
    Serial.println("[REC] resume: ABORT - device unprovisioned; mark cleared, segments upload via sync");
    recCrashClear(); return;
  }

  // Boot-loop guard: if resuming has itself crashed the board a couple of times,
  // stop trying. The captured segments still upload as a normal unsynced session.
  if (tries >= 2) {
    Serial.println("[REC] resume: ABORT - boot-loop guard (tries>=2); segments upload via sync");
    recCrashClear(); return;
  }
  g_prefs.begin("sate-rec", false);
  g_prefs.putUChar("tries", tries + 1);
  g_prefs.end();

  // Map the stored patient id back to a slot (patientDirPath keys off it).
  int idx = -1;
  for (int i = 0; i < g_patientCount; i++)
    if (!strcmp(g_patients[i].patientId, pid)) { idx = i; break; }
  if (idx < 0) {
    Serial.printf("[REC] resume: ABORT - patient '%s' not in roster (%d loaded)\n", pid, g_patientCount);
    recCrashClear(); return;                     // patient gone -> sync handles it
  }
  selectPatientIndex(idx);

  // Own the SD bus BEFORE touching the session's files or pumping the status
  // screen: the net task may already be uploading this very session (the sweep
  // starts the instant Wi-Fi comes up), and if it marks it .synced before the
  // capture re-arms, every resumed minute is skipped by the pending scan
  // forever. Setting the flag is asynchronous, so also wait for the positive
  // net-task acknowledgement, same handshake the delete path uses.
  connSetUiSdBusy(true);
  {
    uint32_t guard = millis() + 120000;   // rides out a final-slice POST (~60 s)
    while (!connNetSdIdle() && (int32_t)(millis() - guard) < 0) {
      lv_timer_handler();
      delay(5);
    }
  }
  if (!connNetSdIdle()) {
    // Net task never yielded (wedged mid-transfer): never append under a live
    // upload. Keep the mark - the next boot retries, bounded by the tries guard.
    Serial.println("[REC] resume: ABORT - net task never released the SD bus");
    connSetUiSdBusy(false);
    return;
  }

  char dir[96], wavPath[160], jsonPath[160], part0[200], mark[160];
  patientDirPath(dir, sizeof(dir));
  sessionWavPath(wavPath, sizeof(wavPath), dir, sess);
  sessionJsonPath(jsonPath, sizeof(jsonPath), dir, sess);
  sessionPartPath(part0, sizeof(part0), wavPath, 0);
  sessionSyncMarkPath(mark, sizeof(mark), dir, sess);
  if (SD_MMC.exists(mark)) {
    // The interrupted part already reached the server (uploaded before this
    // boot's bus claim, or on a previous boot). Appending would strand the new
    // audio - the pending scan skips marked sessions - so leave it be.
    Serial.printf("[REC] resume: ABORT - session %lu already synced; not appending\n", (unsigned long)sess);
    connSetUiSdBusy(false);
    recCrashClear(); return;
  }
  if (!SD_MMC.exists(part0)) {
    Serial.printf("[REC] resume: ABORT - %s missing on the card\n", part0);
    connSetUiSdBusy(false);
    recCrashClear(); return;
  }

  uint32_t existingBytes = 0;
  int startPart = prepareResumeSegments(wavPath, &existingBytes);
  if (existingBytes == 0) {
    // Board died before any audio was flushed: only a header-only part00 exists.
    // Don't discard the take - RESTART recording into the SAME session (overwrite
    // from segment 0) so an interrupted recording always continues on boot. With
    // the ~5 s mid-segment flush this window is tiny, but when it does happen the
    // user still gets a live take back instead of a silently dropped one.
    startPart = 0;
    existingBytes = 0;
  }

  // Refuse to resume onto a (nearly) full card - same rule as starting a take.
  if (sdFreeBytes() < SD_MIN_FREE_BYTES) {
    connSetUiSdBusy(false);
    recCrashClear();
    showStatus("Recording recovered", "Interrupted take saved - card is full");
    pumpGuiMs(1600);
    showHomeScreen();
    return;
  }

  // Tell the SLP the take is continuing and give them a beat to hit Stop.
  recTakeArmed = true;      // arm BEFORE the status screen: the remote stop that
                            // ends this take often arrives during the pump below
  connSetLiveState("recording");   // a resumed take reports live state too
  Serial.printf("[REC] resume session %lu from part %d (%lu bytes already on card, cap %lu)\n",
                (unsigned long)sess, startPart, (unsigned long)existingBytes, (unsigned long)cap);
  showStatus("Resuming recording", "Interrupted take - press RECORD to stop");
  pumpGuiMs(1500);

  // Resume with the ORIGINAL cap (written is seeded with existingBytes, so the
  // absolute byte ceiling carries over) - a server-timed take stays timed.
  uint32_t pcmBytes = 0;
  bool ok = recordWavStreamToSd(wavPath, &pcmBytes, cap, startPart, existingBytes);
  recTakeArmed = false;
  connStopReq = false;   // same stale-stop drop as the normal take path above
  connSetLiveState("idle");
  if (connRecordReq) {   // same stale remote-record drop as the normal take path
    connRecordReq  = false;
    connRecordSecs = 0;
    Serial.println("[REC] remote record dropped - arrived during a take");
  }
  recCrashClear();

  if (!ok || pcmBytes == 0) {
    // Never delete captured audio: the segments stay and upload via sync.
    connSetUiSdBusy(false);
    showHomeScreen();
    return;
  }

  finalizeSavedSession(wavPath, jsonPath, sess, pcmBytes);
}

static void playSessionFromList(int sessionNum)
{
  char dir[96];
  patientDirPath(dir, sizeof(dir));

  if (!sessionExists(dir, (uint32_t)sessionNum)) {
    showSessionsScreen();
    return;
  }

  char caption[40];
  snprintf(caption, sizeof(caption), "playing session_%04d", sessionNum);
  connSetUiSdBusy(true);   // pause net SD work so playback reads aren't fighting it
  playSessionAudio(dir, (uint32_t)sessionNum, caption);
  connSetUiSdBusy(false);
  showSessionsScreen();
}

// -----------------------------------------------------------------------------
// Hold BOOT 5 s -> FACTORY RESET (wipe Wi-Fi + account, reboot to first-time
// setup), claimed or not. Changing Wi-Fi without a reset is done from the app
// (BLE / wifi_change), so the on-board button is the deliberate full wipe.
// A red countdown banner shows while held; releasing before 5 s cancels.
// -----------------------------------------------------------------------------

static uint32_t bootHoldStart = 0;

static void serviceFactoryResetButton()
{
  if (digitalRead(BOOT_BTN_PIN) == LOW) {          // pressed (active LOW)
    if (bootHoldStart == 0) bootHoldStart = millis();
    uint32_t held = millis() - bootHoldStart;

    if (held >= 700 && !resetBanner) {             // show banner after a beat
      resetBanner = lv_obj_create(lv_scr_act());
      lv_obj_set_size(resetBanner, 210, 76);
      lv_obj_center(resetBanner);
      stylePanel(resetBanner);
      lv_obj_set_style_bg_color(resetBanner, lv_color_hex(COL_REC_BG), 0);
      lv_obj_set_style_border_color(resetBanner, lv_color_hex(COL_REC), 0);
      lv_obj_t *l = lv_label_create(resetBanner);
      setFont(l, &lv_font_montserrat_14);
      lv_obj_set_style_text_color(l, lv_color_hex(COL_REC), 0);
      lv_obj_set_style_text_align(l, LV_TEXT_ALIGN_CENTER, 0);
      lv_obj_center(l);
      lv_obj_move_foreground(resetBanner);
    }
    if (resetBanner) {
      int secLeft = 5 - (int)(held / 1000);
      if (secLeft < 0) secLeft = 0;
      char t[48];
      snprintf(t, sizeof(t), LV_SYMBOL_TRASH "  Factory reset in %d", secLeft);
      lv_label_set_text(lv_obj_get_child(resetBanner, 0), t);
    }
    if (held >= 5000) {
      if (resetBanner) { lv_obj_del(resetBanner); resetBanner = nullptr; }
      bootHoldStart = 0;
      connFactoryReset();                    // wipe config + account, restart
    }
  } else {
    bootHoldStart = 0;
    if (resetBanner) { lv_obj_del(resetBanner); resetBanner = nullptr; }
  }
}

// -----------------------------------------------------------------------------
// Arduino setup / loop
// -----------------------------------------------------------------------------

void setup()
{
  // Timer wake from the battery-protect deep sleep: the wake exists ONLY to
  // re-sample the cell. Decide before the serial delay, screen init or
  // backlight - a cell still under the floor goes straight back to sleep after
  // one ADC read, keeping the sleep's ~10 uA promise instead of a full-bright
  // reboot every recheck. A recovered (charged) cell falls through to boot.
  if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_TIMER) {
    int mv = readBatteryMv();
    if (mv >= 0 && mv < BAT_CRIT_MV) enterBatterySleep(true);  // never returns
  }

  Serial.begin(SERIAL_BAUD);
  delay(1200);

  Serial.println();
  Serial.println("=== SATE Clinical Recorder ===");
  Serial.print("Firmware: ");
  Serial.println(FIRMWARE_VERSION);
  // Why this boot happened + which OTA slot is running: a panic vs brownout vs
  // clean power-cycle is the single fact that decides where a field bug lives,
  // and a slot label of app0 (no ota_1) exposes a huge_app mis-flash instantly.
  {
    const esp_partition_t *part = esp_ota_get_running_partition();
    Serial.printf("[BOOT] reset=%s(%d) slot=%s\n",
                  resetReasonStr(esp_reset_reason()), (int)esp_reset_reason(),
                  part ? part->label : "?");
#if SATE_HAS_COREDUMP
    // After a panic the stored core dump names the crashing task + PC - the
    // difference between "the resume path crashed" and "LVGL crashed" without
    // ever attaching a debugger.
    if (esp_reset_reason() == ESP_RST_PANIC) {
      esp_core_dump_summary_t sum;
      if (esp_core_dump_get_summary(&sum) == ESP_OK) {
        Serial.printf("[BOOT] crash: task=%s pc=0x%08lx\n",
                      sum.exc_task, (unsigned long)sum.exc_pc);
      }
    }
#endif
  }

  currentState = BOOTING;
  pinMode(BOOT_BTN_PIN, INPUT_PULLUP); // hold 5 s to factory-reset
  pinMode(REC_BTN_PIN,  INPUT_PULLUP); // external RECORD button (active LOW)
  pinMode(FLAG_BTN_PIN, INPUT_PULLUP); // external FLAG button (active LOW)
  // FALLING edge = press (active LOW). ISR latches it instantly, so a press is
  // never lost while a core is blocked in capture/HTTP - see btnPressed().
  attachInterrupt(digitalPinToInterrupt(REC_BTN_PIN),  isrRecBtn,  FALLING);
  attachInterrupt(digitalPinToInterrupt(FLAG_BTN_PIN), isrFlagBtn, FALLING);
  logHeap("boot");

  // One shared Wire bus for touch + ES8311. Begin once, before display init.
  Wire.begin(I2C_SDA, I2C_SCL, I2C_SPEED);

  screen.init();
  backlightInit();        // take over GPIO45 with PWM so the screen can auto-dim
  batteryBootGuard();     // if the cell is critically low, sleep instead of booting
  bootScreenCreate();

  bootStepBegin(0);                       // display & touch already up
  bootStepDone(0, true);

  bootStepBegin(1);                       // SD card (real init)
  bool sdOk = initSdCard();
  bootStepDone(1, sdOk);
  if (!sdOk) {
    bootScreenFail("Insert SD card and reboot");
    currentState = ERROR_STATE;
    return;
  }
  loadPatientsFromSd();                   // server/app-pushed list, if any
  loadTotalRecordings();                   // lifetime recording count (NVS) for telemetry
  sdRefreshUsage(true);                    // prime the usage cache so the first
                                           // record-begin / Home never pays f_getfree
  // A take interrupted by a reboot is resumed below (maybeResumeRecording, after
  // audio init). Any segments we can't resume still upload as an unsynced session.

  bootStepBegin(2);                       // audio codec (real init)
  bool audioOk = initAudio();
  bootStepDone(2, audioOk);
  if (!audioOk) {
    bootScreenFail("ES8311 audio init failed");
    currentState = ERROR_STATE;
    return;
  }

  bootStepBegin(3);                       // SATE services: Wi-Fi / BLE bring-up
  connInit(FIRMWARE_VERSION);
  // Net task is NOT started here. During provisioning connLoop() runs on the main
  // loop (see loop()) so the register TLS handshake has heap to spare while BLE is
  // up - matching single-core SATE_Up. loop() starts the net task once online.
  pumpGuiMs(400);
  bootStepDone(3, true);

  bootScreenFinish();
  // Gate: until the recorder is claimed to an account and has a real patient
  // roster, the user only sees the onboarding screen.
  if (deviceReady()) {
    showHomeScreen();
  } else {
    showOnboardingScreen();
    // Booted unprovisioned: any surviving crash-mark predates the factory
    // reset / unclaim that rebooted us, so it can NEVER be resumed - and if it
    // lingered, a re-claim could complete before the resume check runs and the
    // mark would append a new take onto the old (possibly synced) session.
    // Decide staleness HERE, at boot, where provisioning state is unambiguous.
    recCrashClear();
  }
  // Defer resuming an interrupted take to loop(). Doing it HERE would block
  // setup() inside the capture (it runs until Stop), so connStartNetTask() in
  // loop() would never run: the unit would record on with no network — no
  // heartbeat, no remote "stop", unreachable until someone pressed the button.
  // Armed on EVERY boot, provisioned or not: an unprovisioned boot (factory
  // reset / server unclaim mid-take) must still consume a stale crash-mark, or
  // it fires on a LATER provisioned boot and appends a new take onto a session
  // that may already be synced. maybeResumeRecording() gates on deviceReady().
  g_resumePending = true;
  g_bootMs = millis();
  logHeap("ready");
}

// ---- Screen mirror (DEBUG / USB-CDC builds ONLY) --------------------------
// On-demand only: the host sends "SCREENDUMP\n" over the debug serial and the
// firmware base64-streams ONE RGB565 snapshot of the active LVGL screen. It never
// runs on its own, is compiled out of production builds entirely (gated on
// ARDUINO_USB_CDC_ON_BOOT, set only by the --debug/CDC FQBN), and refuses while
// RECORDING so it can never disturb a take. Host side: hwtest `sate screenshot`.
#if ARDUINO_USB_CDC_ON_BOOT
#include "mbedtls/base64.h"

static void streamScreenshotB64(const uint8_t *data, uint32_t n)
{
  static char out[4160];
  const uint32_t CH = 3072;              // multiple of 3 -> 4096 base64 chars, no interior padding
  uint32_t i = 0;
  while (i < n) {
    uint32_t chunk = (n - i < CH) ? (n - i) : CH;
    size_t olen = 0;
    if (mbedtls_base64_encode((unsigned char *)out, sizeof(out), &olen, data + i, chunk) != 0) break;
    Serial.write((const uint8_t *)out, olen);
    Serial.write('\n');
    i += chunk;
    delay(1);                            // let the USB-CDC TX buffer drain
  }
}

static void doScreenDump()
{
  if (currentState == RECORDING) { Serial.println("[SCREENSHOT-ERR busy-recording]"); return; }
  lv_obj_t *scr = lv_scr_act();
  lv_img_dsc_t *snap = lv_snapshot_take(scr, LV_IMG_CF_TRUE_COLOR);
  if (!snap) { Serial.println("[SCREENSHOT-ERR snapshot-failed]"); return; }
  Serial.printf("\n[SCREENSHOT-BEGIN w=%u h=%u fmt=rgb565 swap=%d bytes=%u]\n",
                (unsigned)snap->header.w, (unsigned)snap->header.h,
                (int)LV_COLOR_16_SWAP, (unsigned)snap->data_size);
  streamScreenshotB64((const uint8_t *)snap->data, snap->data_size);
  Serial.println("[SCREENSHOT-END]");
  lv_snapshot_free(snap);
}

// "DIAG\n" over the debug serial: one-shot dump of everything a bench session
// starts by asking for - heap/PSRAM, stack high-water of both hot tasks, SD /
// Wi-Fi / session state, and why the last boot happened. Read-only, no SD I/O.
static void doDiagDump()
{
  static const char *stateNames[] = {
    "BOOTING", "ONBOARDING", "HOME", "RECORDING", "SAVING_TO_SD", "PLAYING",
    "SESSIONS", "SYNC", "SYNCING", "RESULTS", "CONNECTION", "ERROR_STATE"
  };
  int st = (int)currentState;
  const char *stName = (st >= 0 && st < (int)(sizeof(stateNames) / sizeof(stateNames[0])))
                           ? stateNames[st] : "?";
  const esp_partition_t *part = esp_ota_get_running_partition();
  Serial.println("[DIAG] ---- state dump ----");
  Serial.printf("[DIAG] fw=%s up=%lus reset=%s(%d) slot=%s\n",
                FIRMWARE_VERSION, (unsigned long)(millis() / 1000),
                resetReasonStr(esp_reset_reason()), (int)esp_reset_reason(),
                part ? part->label : "?");
  Serial.printf("[DIAG] heap int free=%u largest=%u min=%u | psram free=%u largest=%u\n",
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
                (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM));
  Serial.printf("[DIAG] stack floor: loop=%u net=%u bytes (never-used minimum)\n",
                (unsigned)uxTaskGetStackHighWaterMark(NULL),
                (unsigned)connNetStackHighWater());
  Serial.printf("[DIAG] ui state=%s ready=%d patient=%s (%d/%d) bat=%dmV\n",
                stName, (int)deviceReady(),
                g_patientCount ? g_patients[currentPatientIndex].patientId : "-",
                currentPatientIndex, g_patientCount, readBatteryMv());
  {
    // What the user sees on the Sessions screen vs what is really on the card:
    // recordings with audio (playable) vs tombstones (synced + reclaimed, on the
    // server now). This is the line that answers "why does it say N records?".
    char ddir[96];
    patientDirPath(ddir, sizeof(ddir));
    bool dpres[SESSION_NUM_MAX + 1] = {false}, daud[SESSION_NUM_MAX + 1] = {false};
    if (SD_MMC.exists(ddir)) scanSessionNumbers(ddir, dpres, daud);
    uint32_t withAudio = 0, tombstones = 0;
    for (uint32_t i = 1; i <= SESSION_NUM_MAX; i++) {
      if (daud[i]) withAudio++;
      else if (dpres[i]) tombstones++;
    }
    Serial.printf("[DIAG] %s: %lu record(s) with audio (shown), %lu synced tombstone(s) on card\n",
                  g_patients[currentPatientIndex].patientId,
                  (unsigned long)withAudio, (unsigned long)tombstones);
  }
  Serial.printf("[DIAG] sd used=%llu/%llu MB fault=%d | conn mode=%d '%s' ip=%s pending=%lu upload=%d%%\n",
                (unsigned long long)(g_sdUsedCache / (1024 * 1024)),
                (unsigned long long)(g_sdTotal / (1024 * 1024)),
                (int)connSdFault(), (int)connGetMode(), connStatusText(),
                connIp(), (unsigned long)connPendingTotal(), connUploadPercent());
  Serial.println("[DIAG] ---- end ----");
}

static void serviceSerialScreendump()
{
  if (!Serial.available()) return;
  static char cmd[24];
  static uint8_t ci = 0;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      cmd[ci] = 0;
      if (ci > 0 && strcmp(cmd, "SCREENDUMP") == 0) doScreenDump();
      else if (ci > 0 && strcmp(cmd, "DIAG") == 0) doDiagDump();
      ci = 0;
    } else if (ci < sizeof(cmd) - 1) {
      cmd[ci++] = c;
    }
  }
}
#else
static inline void serviceSerialScreendump() {}   // production: compiled out, zero cost
#endif

void loop()
{
  runGui();
  serviceSerialScreendump();   // DEBUG builds only: on-demand screen mirror over serial

  // Resume an interrupted take once the net task is up (or ~8 s in if we are
  // offline), so the whole resumed take stays reachable by the remote "stop".
  // An UNPROVISIONED boot never reaches HOME, but must still run this so a
  // stale crash-mark is cleared (maybeResumeRecording refuses the resume).
  if (g_resumePending && (currentState == HOME || !deviceReady()) &&
      (connNetTaskStarted() || (millis() - g_bootMs) > 8000)) {
    g_resumePending = false;
    // Offline fallback (8 s and the net task never came up): the resume BLOCKS
    // loop() inside the capture until Stop, and the net task normally starts
    // only after Wi-Fi associates (enterWifiOnline -> g_wantNetTask, evaluated
    // by connLoop, which only THIS loop drives until then). Start it NOW, so
    // core 0 keeps driving Wi-Fi retries / the BLE fallback, the remote "stop",
    // the heartbeat, and the OTA health-confirm for the whole resumed take - a
    // boot where the AP is down (mains outage that killed recorder and AP
    // together) must not go dark until the ~62-min ceiling (the 1.5.17 failure,
    // offline flavour). Skipped when there is nothing resumable or the device
    // is unprovisioned: those paths return without blocking, and provisioning
    // needs connLoop() on the main loop for the register TLS heap headroom.
    if (!connNetTaskStarted() && deviceReady() && recCrashMarkPresent())
      connStartNetTask();
    maybeResumeRecording();
  }
  serviceFactoryResetButton(); // hold BOOT 5 s -> wipe config + reboot
  serviceScreenDim();          // dim backlight after 5 min idle, wake on activity
  serviceBatteryGuard();       // sleep near-empty to protect the LiPo (fw 1.5.3)

  // Physical RECORD button when idle: start a take from Home, otherwise jump
  // back to Home from any sub-screen. (While RECORDING, loop() is blocked inside
  // the capture, where the same button is polled to Stop - see recordWavStreamToSd.)
  if (btnPressed(recBtn)) {
    wakeScreen();              // a button press always wakes the screen
    if ((int32_t)(millis() - g_recSettleUntil) < 0) {
      // Stray tap right after a take just ended - ignore (see g_recSettleUntil).
      // Wrap-safe compare: a settle window armed just before the ~49.7-day
      // millis() wrap must not latch the button dead until the next wrap.
    } else if (currentState == HOME && deviceReady()) {
      runRecordSavePlaySession();
    } else if (currentState == SESSIONS || currentState == SYNC ||
               currentState == CONNECTION || currentState == RESULTS) {
      showHomeScreen();
    }
  }
  if (btnPressed(flagBtn)) wakeScreen();   // FLAG acts only during a take; here just wake

  if (currentState != ERROR_STATE) {
    // Until the device is online, drive connectivity HERE on the main loop (BLE +
    // Wi-Fi connect + register), exactly like single-core SATE_Up - this keeps the
    // heap roomy for the register TLS handshake. Once online, connStartNetTask()
    // hands connLoop() to core 0 and the GUI/buttons never wait on HTTP again.
    if (!connNetTaskStarted()) {
      connLoop();
      if (connNetTaskWanted()) connStartNetTask();
    }
    // connLoop() runs on the core-0 net task once online - then we only consume the
    // request flags it sets and render the upload overlay from its flags.
    renderUploadOverlay();

    // UI is idle on these screens; safe to react to connectivity events.
    bool uiIdle = currentState == HOME || currentState == SESSIONS ||
                  currentState == SYNC || currentState == RESULTS ||
                  currentState == CONNECTION || currentState == ONBOARDING;

    if (connStateReq) {
      connStateReq = false;
      if (currentState == ONBOARDING) {
        // Still gated: unlock Home once claimed + roster present, else keep
        // the live onboarding status fresh.
        if (deviceReady()) showHomeScreen();
        else               showOnboardingScreen();
      } else if (connSetupActive() && uiIdle && currentState != CONNECTION) {
        showConnectionScreen();      // app just connected: show live progress
      } else if (currentState == CONNECTION) {
        // App still connected -> keep the live view. App left (e.g. backed out of
        // Change-Wi-Fi without updating) -> auto-return to the main page instead
        // of sitting on "waiting for app".
        if (connSetupActive())     showConnectionScreen();
        else if (deviceReady())    showHomeScreen();
        else                       showOnboardingScreen();
      } else {
        // Any non-transition state (incl. HOME): just refresh the small
        // connectivity icon. Do NOT full-rebuild Home here - that fired on every
        // connectivity ping and caused periodic jank. The live status line +
        // counts refresh on their own 250 ms cadence (refreshHomeUpload), and a
        // real roster change rebuilds Home via connPatientsReq below.
        updateConnBadge();
      }
    }
    if (connPatientsReq && uiIdle) {
      connPatientsReq = false;
      loadPatientsFromSd();
      if (currentState == ONBOARDING) {
        if (deviceReady()) showHomeScreen();   // setup just completed
        else               showOnboardingScreen();
      } else if (currentState == HOME) {
        showHomeScreen();
      }
    }
    // App-typed patient for the next remote recording: select it (adding to the
    // roster if new) so the captured session is tagged to the right person.
    if (connActivePatientReq && uiIdle) {
      connActivePatientReq = false;
      applyActivePatient();
      if (currentState == HOME) showHomeScreen();
      else if (currentState == ONBOARDING && deviceReady()) showHomeScreen();
    }
    // Remote record (app/server "record" command). The capture only runs from
    // Home, but the UI never returns to Home on its own — so navigate there
    // from any idle sub-screen first. The request is only CONSUMED once it can
    // actually run: the server has already dequeued the command and never
    // re-sends it, so consuming it on the Sessions/Sync/Results screen used to
    // silently drop the take while the app kept showing "idle".
    if (connRecordReq) {
      if (currentState == SESSIONS || currentState == SYNC ||
          currentState == RESULTS || currentState == CONNECTION ||
          (currentState == ONBOARDING && deviceReady())) {
        showHomeScreen();
      }
      if (currentState == HOME && deviceReady()) {
        connRecordReq = false;
        uint32_t secs = connRecordSecs;
        connRecordSecs = 0;
        // A timed take caps the capture at exactly secs of PCM; untimed runs
        // to Stop (or the safety cap) as before.
        uint32_t cap = PCM_MAX_BYTES;
        if (secs > 0) {
          uint64_t want = (uint64_t)secs * PCM_BYTES_PER_SEC;
          if (want < cap) cap = (uint32_t)want;
        }
        // Live state ("recording"/"idle") is reported by
        // runRecordSavePlaySession() itself now, for every start path alike -
        // reporting it here too would claim "recording" even when the take is
        // refused (SD error / low battery / full card) before it ever arms.
        runRecordSavePlaySession(false /*review*/, cap);
      } else if (!deviceReady()) {
        // Unclaimed unit can't record. Drop the request rather than latch it:
        // a stale record firing whenever the device is finally claimed would
        // be a take nobody asked for.
        connRecordReq = false;
        connRecordSecs = 0;
        Serial.println("[REC] remote record dropped - device not set up");
      }
      // else: leave the request latched; retried on the next loop pass.
    }

    // Live upload status: drive the always-visible Home footer / Sessions
    // badges every ~250 ms without rebuilding the screen, so uploading is
    // visible and never confusing. Cheap (a couple of label/bar updates).
    static uint32_t lastUpRefresh = 0;
    uint32_t nowMs = millis();
    if (nowMs - lastUpRefresh >= 250) {
      lastUpRefresh = nowMs;
      if (currentState == HOME)          refreshHomeUpload();
      else if (currentState == SESSIONS) refreshSessionsUpload();
    }
    // Keep the SD-usage cache fresh off the hot path: this self-limits to one
    // f_getfree per 30 s, on Home, when idle - so record-begin / showHomeScreen
    // never pay the scan, and the storage chip stays accurate.
    if (currentState == HOME) sdRefreshUsage(false);

    // Device telemetry for the admin dashboard: refresh battery % + lifetime
    // recording count into connectivity every ~10 s (sent on the next heartbeat).
    // Slow cadence keeps the battery ADC sampling light.
    static uint32_t lastTelemetry = 0;
    if (lastTelemetry == 0 || nowMs - lastTelemetry >= 10000) {
      lastTelemetry = nowMs;
      connSetTelemetry((int)batteryPercent(), g_totalRecordings, readBatteryMv());
    }

    // Immediate GUI tick after any network/SD work so a screen rebuilt by the
    // flag handlers above paints now instead of waiting a whole loop.
    screen.routine();
  }

  PendingAction act = pendingAction;
  if (act == ACT_NONE) {
    if (currentState == ERROR_STATE) delay(10);
    return;
  }
  pendingAction = ACT_NONE;
  int arg = pendingArg;

  switch (act) {
    case ACT_RECORD:
      if (currentState == HOME) runRecordSavePlaySession();
      break;

    case ACT_NEXT_PATIENT:
      if (currentState == HOME) {
        // Quick fade for a smooth patient switch.
        for (int o = 255; o >= 0; o -= 28) {
          if (patientCard) lv_obj_set_style_opa(patientCard, o, 0);
          runGui();
        }
        selectPatientIndex((currentPatientIndex + 1) % g_patientCount);
        showHomeScreen();
      }
      break;

    case ACT_OPEN_SESSIONS:
      if (currentState == HOME) showSessionsScreen();
      break;

    case ACT_OPEN_SYNC:
      if (currentState == HOME) showSyncScreen();
      break;

    case ACT_BACK_HOME:
      if (currentState == SESSIONS || currentState == SYNC ||
          currentState == CONNECTION) showHomeScreen();
      break;

    case ACT_OPEN_CONN:
      if (currentState == HOME || currentState == SESSIONS ||
          currentState == SYNC || currentState == RESULTS) showConnectionScreen();
      break;

    case ACT_RUN_SYNC:
      if (currentState == SYNC) runSync();
      break;

    case ACT_PLAY_SESSION:
      if (currentState == SESSIONS) playSessionFromList(arg);
      break;

    case ACT_DELETE_SESSION:
      if (currentState == SESSIONS) {
        char dir[96];
        patientDirPath(dir, sizeof(dir));
        // A delete never renumbers: only session `arg`'s own files go, every
        // other session keeps its number, so a live upload of a DIFFERENT
        // session is untouched. Still take the SD bus and WAIT for the net task
        // to positively acknowledge it is out of ALL its SD work (not just the
        // upload): removing the very files an open upFile is streaming corrupts
        // that transfer, and unlinking an open file is undefined on FAT.
        // connNetSdIdle() is that acknowledgement - it covers the upload
        // (including the writeSyncMarker + trim tail) and BLE file transfers,
        // and is raised by the net task BEFORE it re-reads uiSdBusy, so there
        // is no check-then-act hole.
        //
        // The wait must ride out a chunk POST already in flight (final-slice
        // timeout ~60 s) plus trim's verify round trips. If the net task still
        // has not yielded at the cap, ABORT the delete instead of unlinking
        // files it may hold open - the user can simply tap Delete again. The
        // common case exits in well under a second.
        connSetUiSdBusy(true);
        if (!connNetSdIdle()) {
          showStatus("Deleting", "Finishing current sync first...");
        }
        uint32_t guard = millis() + 120000;
        bool netIdle = true;
        while (!connNetSdIdle()) {
          if ((int32_t)(millis() - guard) >= 0) { netIdle = false; break; }
          lv_timer_handler();
          delay(5);
        }
        if (netIdle) {
          deleteSessionFiles(dir, (uint32_t)arg);
          // Drop the uploader's memory of this (patient, number) - resume
          // point, strikes, and any still-latched in-flight upload - BEFORE
          // the number can be reallocated to a future take.
          connNotifySessionDeleted(g_patients[currentPatientIndex].patientId,
                                   (uint32_t)arg);
          // Space was just freed: rescan now (still holding the SD bus) so the
          // "SD card full" record guard and the storage chip clear immediately
          // instead of after the 30 s cache window.
          sdRefreshUsage(true);
        } else {
          Serial.println("[UI] delete aborted - net task never released the SD bus");
        }
        connSetUiSdBusy(false);   // uploads resume; the aborted one restarts later
        if (!netIdle) {
          // Say what happened. Silently repainting the unchanged list (after the
          // user watched "Finishing current sync first..." for two minutes) made
          // Delete look broken with no diagnostic. The session is intact; the
          // net task was just still holding the card - a retry usually succeeds.
          showStatus("Couldn't delete", "Sync is busy - try again in a moment");
          pumpGuiMs(1800);
        }
        showSessionsScreen();     // rebuild the list from disk
      }
      break;

    case ACT_RESULTS_DONE:
      if (currentState == RESULTS) showHomeScreen();
      break;

    default:
      break;
  }
}
