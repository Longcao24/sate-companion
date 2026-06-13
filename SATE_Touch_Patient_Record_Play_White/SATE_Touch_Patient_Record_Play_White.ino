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
 *     commands (sync_now / reload_patients / identify / reboot)
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
#include "esp_heap_caps.h"
#include "esp_random.h"

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

static const int      SERIAL_BAUD       = 115200;
static const int      RECORD_SECONDS    = 30;
static const uint32_t AUDIO_SAMPLE_RATE = 16000;
static const int      AUDIO_BIT_DEPTH   = 16;
static const int      AUDIO_CHANNELS    = 1;
static const char    *FIRMWARE_VERSION  = "0.6.4";

static const uint32_t PCM_BYTES_PER_SEC = AUDIO_SAMPLE_RATE * (AUDIO_BIT_DEPTH / 8) * AUDIO_CHANNELS;
static const uint32_t PCM_TOTAL_BYTES   = PCM_BYTES_PER_SEC * RECORD_SECONDS;

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
  ACT_RESULTS_DONE,
  ACT_OPEN_CONN       // tap the header connectivity icon
};

static volatile PendingAction pendingAction = ACT_NONE;
static volatile int           pendingArg    = 0;

// Connectivity hook flags: set from connLoop() handlers, consumed by loop().
static volatile bool connIdentifyReq = false;
static volatile bool connPatientsReq = false;
static volatile bool connStateReq    = false;

void sateHookIdentify()        { connIdentifyReq = true; }
void sateHookPatientsUpdated() { connPatientsReq = true; }
void sateHookConnChanged()     { connStateReq = true; }

// The recorder is usable only once it has been claimed to a SATE account AND
// has a real patient roster. Until then the user sees the onboarding screen
// only - no Home, no recording.
static bool deviceReady() { return connProvisioned() && g_patientCount > 0; }

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
static lv_obj_t *syncBar         = nullptr;
static lv_obj_t *syncBarText     = nullptr;
static lv_obj_t *connIcon        = nullptr;

static void uiResetPointers()
{
  statePill = statePillText = nullptr;
  patientCard = patientName = patientIdChip = patientRows = nullptr;
  statusLabel = hintLabel = nullptr;
  progressOverlay = progressArc = progressBig = progressSmall = nullptr;
  syncBar = syncBarText = nullptr;
  connIcon = nullptr;
}

// -----------------------------------------------------------------------------
// Memory telemetry
// -----------------------------------------------------------------------------

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
  delay(5);
}

static void pumpGuiMs(unsigned long durationMs)
{
  unsigned long start = millis();
  while (millis() - start < durationMs) {
    runGui();
  }
}

static void setScreenWhite()
{
  lv_obj_set_style_bg_color(lv_scr_act(), lv_color_hex(COL_BG), 0);
  lv_obj_set_style_bg_opa(lv_scr_act(), LV_OPA_COVER, 0);
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
  if (statusLabel) lv_label_set_text(statusLabel, status);
  if (hintLabel)   lv_label_set_text(hintLabel, hint);
  for (int i = 0; i < 3; i++) runGui();
}

static void styleButton(lv_obj_t *btn, uint32_t bgColor, uint32_t textColor)
{
  lv_obj_set_style_radius(btn, 12, 0);
  lv_obj_set_style_bg_color(btn, lv_color_hex(bgColor), 0);
  lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(btn, 0, 0);
  lv_obj_set_style_shadow_width(btn, 0, 0);
  lv_obj_set_style_text_color(btn, lv_color_hex(textColor), 0);
}

static void stylePanel(lv_obj_t *panel)
{
  lv_obj_set_style_bg_color(panel, lv_color_hex(COL_CARD_BG), 0);
  lv_obj_set_style_border_color(panel, lv_color_hex(COL_CARD_BORDER), 0);
  lv_obj_set_style_border_width(panel, 1, 0);
  lv_obj_set_style_radius(panel, 14, 0);
  lv_obj_set_style_shadow_width(panel, 0, 0);
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
static void createHeader(const char *title, PendingAction backAction = ACT_NONE)
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
    lv_obj_set_size(back, 34, 28);
    lv_obj_set_style_radius(back, 8, 0);
    lv_obj_align(back, LV_ALIGN_LEFT_MID, 8, 0);
    titleX = 50;
  }

  lv_obj_t *titleLbl = lv_label_create(header);
  lv_label_set_text(titleLbl, title);
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

static void showProgressOverlay(const char *caption, uint32_t arcColor)
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
  lv_obj_set_style_text_color(progressBig, lv_color_hex(COL_TEXT_DARK), 0);
  lv_obj_align(progressBig, LV_ALIGN_CENTER, 0, -34);

  progressSmall = lv_label_create(progressOverlay);
  lv_label_set_text(progressSmall, caption);
  lv_obj_set_style_text_color(progressSmall, lv_color_hex(COL_TEXT_MUTED), 0);
  lv_obj_align(progressSmall, LV_ALIGN_CENTER, 0, -10);

  lv_obj_move_foreground(progressOverlay);
}

static void hideProgressOverlay()
{
  if (!progressOverlay) return;
  lv_obj_del(progressOverlay);
  progressOverlay = progressArc = progressBig = progressSmall = nullptr;
}

static void updateProgress(uint16_t permille, const char *bigText)
{
  if (!progressOverlay) return;
  lv_arc_set_value(progressArc, permille);
  if (bigText) lv_label_set_text(progressBig, bigText);
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
    Serial.println("SD_MMC.setPins failed.");
    return false;
  }
  if (!SD_MMC.begin()) {
    Serial.println("SD_MMC.begin failed.");
    return false;
  }
  Serial.printf("SD card size MB: %lu\n", (unsigned long)(SD_MMC.cardSize() / (1024 * 1024)));
  ensureDir("/sate");
  ensureDir("/sate/patients");
  return true;
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

  int n = 0;
  for (JsonObject p : arr) {
    if (n >= MAX_PATIENTS) break;
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
    if (currentPatientIndex >= n) currentPatientIndex = 0;
    Serial.printf("Loaded %d patient(s) from SD\n", n);
  }
}

static void patientDirPath(char *out, size_t outSize)
{
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

// Sessions are numbered contiguously from 1; first missing wav = next free.
static uint32_t findNextSessionIndex(const char *dir)
{
  char probe[160];
  for (uint32_t i = 1; i <= 9999; i++) {
    sessionWavPath(probe, sizeof(probe), dir, i);
    if (!SD_MMC.exists(probe)) return i;
  }
  return 0;
}

// Count of recorded sessions for the current patient.
static uint32_t sessionCount(const char *dir)
{
  uint32_t next = findNextSessionIndex(dir);
  return (next == 0) ? 9999 : next - 1;
}

static bool isSessionSynced(const char *dir, uint32_t n)
{
  char probe[160];
  sessionSyncMarkPath(probe, sizeof(probe), dir, n);
  return SD_MMC.exists(probe);
}

static uint32_t countUnsynced(const char *dir)
{
  uint32_t total = sessionCount(dir);
  uint32_t pending = 0;
  for (uint32_t i = 1; i <= total; i++) {
    if (!isSessionSynced(dir, i)) pending++;
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
  file.printf("  \"created_ms_since_boot\": %lu\n", (unsigned long)millis());
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
    Serial.println("Failed to initialize I2S bus.");
    return false;
  }

  if (es8311_codec_init() != ESP_OK) {
    Serial.println("ES8311 init failed.");
    return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// STREAMED recording: mic -> 4 KB chunk -> SD, live countdown ring.
// -----------------------------------------------------------------------------

static bool recordWavStreamToSd(const char *wavPath, uint32_t *outPcmBytes)
{
  *outPcmBytes = 0;
  currentState = RECORDING;
  setStatePill("REC", COL_REC_BG, COL_REC);
  logHeap("record start");

  File file = SD_MMC.open(wavPath, FILE_WRITE);
  if (!file) {
    showStatus("Record failed", "Cannot create WAV on SD");
    return false;
  }

  writeWavHeader(file, PCM_TOTAL_BYTES);
  showProgressOverlay("recording  -  speak clearly", COL_REC);

  // Drain stale I2S DMA samples so the recording starts clean.
  es8311_i2s.readBytes((char *)audioChunk, sizeof(audioChunk));

  uint32_t written = 0;
  uint32_t lastUiMs = 0;
  bool ok = true;

  while (written < PCM_TOTAL_BYTES) {
    size_t want = PCM_TOTAL_BYTES - written;
    if (want > AUDIO_CHUNK_BYTES) want = AUDIO_CHUNK_BYTES;

    size_t got = es8311_i2s.readBytes((char *)audioChunk, want);
    if (got == 0) { ok = false; break; }

    size_t put = file.write(audioChunk, got);
    if (put != got) { ok = false; break; }
    written += put;

    uint32_t now = millis();
    if (now - lastUiMs >= 120) {
      lastUiMs = now;
      uint32_t secLeft = (PCM_TOTAL_BYTES - written + PCM_BYTES_PER_SEC - 1) / PCM_BYTES_PER_SEC;
      char big[8];
      snprintf(big, sizeof(big), "%lu", (unsigned long)secLeft);
      updateProgress((uint16_t)((written * 1000ULL) / PCM_TOTAL_BYTES), big);
      lv_timer_handler();
    }
  }

  patchWavHeader(file, written);
  file.flush();
  file.close();

  *outPcmBytes = written;
  logHeap("record end");

  if (!ok || written == 0) {
    hideProgressOverlay();
    showStatus("Record failed", "I2S read or SD write error");
    return false;
  }

  Serial.printf("Recording complete. PCM bytes: %lu\n", (unsigned long)written);
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

  showProgressOverlay(caption, COL_PRIMARY);

  while (sent < pcmTotal) {
    size_t got = file.read(audioChunk, AUDIO_CHUNK_BYTES);
    if (got == 0) break;

    es8311_i2s.write(audioChunk, got);   // blocks on DMA, keeps audio timing
    sent += got;

    uint32_t now = millis();
    if (now - lastUiMs >= 200) {
      lastUiMs = now;
      uint32_t secLeft = (pcmTotal - sent + PCM_BYTES_PER_SEC - 1) / PCM_BYTES_PER_SEC;
      char big[8];
      snprintf(big, sizeof(big), "%lu", (unsigned long)secLeft);
      updateProgress((uint16_t)((sent * 1000ULL) / pcmTotal), big);
      lv_timer_handler();
    }
  }

  file.close();
  hideProgressOverlay();
  logHeap("play end");
  currentState = prev;
  return true;
}

// -----------------------------------------------------------------------------
// Identify (remote command): three beeps + blue screen flashes so the SLP
// can spot the recorder. Only runs from loop() while the UI is idle.
// -----------------------------------------------------------------------------

static void identifyBeepFlash()
{
  lv_obj_t *ov = lv_obj_create(lv_scr_act());
  lv_obj_set_size(ov, 240, 320);
  lv_obj_align(ov, LV_ALIGN_TOP_LEFT, 0, 0);
  lv_obj_set_style_bg_color(ov, lv_color_hex(COL_PRIMARY), 0);
  lv_obj_set_style_bg_opa(ov, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(ov, 0, 0);
  lv_obj_set_style_radius(ov, 0, 0);

  lv_obj_t *lbl = lv_label_create(ov);
  lv_label_set_text(lbl, LV_SYMBOL_BELL "  Here I am!");
  lv_obj_set_style_text_color(lbl, lv_color_hex(0xFFFFFF), 0);
  lv_obj_center(lbl);

  // 1 kHz tone, 16-bit mono @ 16 kHz; one chunk = 128 ms of audio.
  const int samples = AUDIO_CHUNK_BYTES / 2;
  int16_t *pcm = (int16_t *)audioChunk;
  for (int i = 0; i < samples; i++) {
    pcm[i] = (int16_t)(9000.0f * sinf(2.0f * PI * 1000.0f * i / AUDIO_SAMPLE_RATE));
  }

  for (int b = 0; b < 3; b++) {
    lv_obj_clear_flag(ov, LV_OBJ_FLAG_HIDDEN);
    runGui();
    es8311_i2s.write(audioChunk, AUDIO_CHUNK_BYTES);  // ~128 ms beep
    es8311_i2s.write(audioChunk, AUDIO_CHUNK_BYTES);  // ~256 ms total
    lv_obj_add_flag(ov, LV_OBJ_FLAG_HIDDEN);
    pumpGuiMs(180);
  }

  lv_obj_del(ov);
  runGui();
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
  lv_obj_set_style_text_color(title, lv_color_hex(COL_PRIMARY_DK), 0);
  lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 14);

  lv_obj_t *sub = lv_label_create(lv_scr_act());
  char subTxt[40];
  snprintf(subTxt, sizeof(subTxt), "Device %s", connSerial());
  lv_label_set_text(sub, subTxt);
  lv_obj_set_style_text_color(sub, lv_color_hex(COL_TEXT_MUTED), 0);
  lv_obj_align(sub, LV_ALIGN_TOP_MID, 0, 38);

  lv_obj_t *sym = lv_label_create(lv_scr_act());
  lv_label_set_text(sym, online ? LV_SYMBOL_WIFI : LV_SYMBOL_BLUETOOTH);
  lv_obj_set_style_text_color(sym, lv_color_hex(online ? COL_OK : COL_PRIMARY), 0);
  lv_obj_align(sym, LV_ALIGN_TOP_MID, 0, 64);

  lv_obj_t *st = lv_label_create(lv_scr_act());
  lv_label_set_text(st, connStatusText());
  lv_obj_set_width(st, 216);
  lv_label_set_long_mode(st, LV_LABEL_LONG_WRAP);
  lv_obj_set_style_text_align(st, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_color(st, lv_color_hex(COL_TEXT_DARK), 0);
  lv_obj_align(st, LV_ALIGN_TOP_MID, 0, 94);

  lv_obj_t *card = lv_obj_create(lv_scr_act());
  lv_obj_set_size(card, 216, 128);
  lv_obj_align(card, LV_ALIGN_TOP_MID, 0, 132);
  stylePanel(card);
  lv_obj_set_style_pad_all(card, 12, 0);

  int s1 = (m == CONN_OFF) ? 1 : 2;
  int s2 = (appConn || prov || online) ? 2 : (m == CONN_BLE_ADV ? 1 : 0);
  int s3 = (online || prov) ? 2 : ((m == CONN_WIFI_TRYING || appConn) ? 1 : 0);
  int s4 = (prov && hasPat) ? 2 : (prov ? 1 : 0);

  onboardStepRow(card, 0, "Bluetooth ready", s1);
  onboardStepRow(card, 1, "App connected", s2);
  onboardStepRow(card, 2, "Wi-Fi connected", s3);
  onboardStepRow(card, 3, "Account + patients", s4);

  lv_obj_t *foot = lv_label_create(lv_scr_act());
  lv_label_set_text(foot, (prov && !hasPat) ? "Waiting for patient list..."
                                            : "Open the SATE app to finish setup");
  lv_obj_set_width(foot, 216);
  lv_label_set_long_mode(foot, LV_LABEL_LONG_WRAP);
  lv_obj_set_style_text_align(foot, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_color(foot, lv_color_hex(COL_TEXT_MUTED), 0);
  lv_obj_align(foot, LV_ALIGN_BOTTOM_MID, 0, -10);

  currentState = ONBOARDING;
}

static void showHomeScreen()
{
  uiResetPointers();
  lv_obj_clean(lv_scr_act());
  setScreenWhite();
  createHeader("SATE Recorder");

  // Patient card
  patientCard = lv_obj_create(lv_scr_act());
  lv_obj_set_size(patientCard, 220, 118);
  lv_obj_align(patientCard, LV_ALIGN_TOP_MID, 0, 48);
  stylePanel(patientCard);
  lv_obj_set_style_pad_all(patientCard, 12, 0);

  const SatePatient &p = g_patients[currentPatientIndex];

  patientName = lv_label_create(patientCard);
  lv_label_set_text(patientName, p.displayName);
  lv_obj_set_style_text_color(patientName, lv_color_hex(COL_TEXT_DARK), 0);
  lv_obj_align(patientName, LV_ALIGN_TOP_LEFT, 0, 0);

  patientIdChip = lv_label_create(patientCard);
  lv_label_set_text(patientIdChip, p.patientId);
  lv_obj_set_style_text_color(patientIdChip, lv_color_hex(COL_PRIMARY_DK), 0);
  lv_obj_set_style_bg_color(patientIdChip, lv_color_hex(COL_PRIMARY_BG), 0);
  lv_obj_set_style_bg_opa(patientIdChip, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(patientIdChip, 8, 0);
  lv_obj_set_style_pad_hor(patientIdChip, 7, 0);
  lv_obj_set_style_pad_ver(patientIdChip, 3, 0);
  lv_obj_align(patientIdChip, LV_ALIGN_TOP_RIGHT, 0, -2);

  char dir[96];
  patientDirPath(dir, sizeof(dir));
  uint32_t total   = SD_MMC.exists(dir) ? sessionCount(dir) : 0;
  uint32_t pending = SD_MMC.exists(dir) ? countUnsynced(dir) : 0;

  patientRows = lv_label_create(patientCard);
  lv_obj_set_width(patientRows, 196);
  lv_label_set_long_mode(patientRows, LV_LABEL_LONG_WRAP);
  lv_obj_set_style_text_color(patientRows, lv_color_hex(COL_TEXT_MUTED), 0);
  lv_obj_set_style_text_line_space(patientRows, 5, 0);
  lv_obj_align(patientRows, LV_ALIGN_TOP_LEFT, 0, 32);

  char rows[200];
  snprintf(rows, sizeof(rows),
           "Age:  %s\nSession:  %s\nSLP:  %s",
           p.age, p.sessionType, p.clinician);
  lv_label_set_text(patientRows, rows);

  // Status + hint
  statusLabel = lv_label_create(lv_scr_act());
  lv_obj_set_style_text_color(statusLabel, lv_color_hex(0x0F766E), 0);
  lv_obj_set_width(statusLabel, 220);
  lv_label_set_long_mode(statusLabel, LV_LABEL_LONG_WRAP);
  lv_obj_set_style_text_align(statusLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_align(statusLabel, LV_ALIGN_TOP_MID, 0, 172);

  hintLabel = lv_label_create(lv_scr_act());
  lv_obj_set_style_text_color(hintLabel, lv_color_hex(COL_TEXT_MUTED), 0);
  lv_obj_set_width(hintLabel, 220);
  lv_label_set_long_mode(hintLabel, LV_LABEL_LONG_WRAP);
  lv_obj_set_style_text_align(hintLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_align(hintLabel, LV_ALIGN_TOP_MID, 0, 193);

  // Buttons: 2 x 2 grid
  lv_obj_t *btnRecord = makeActionButton(lv_scr_act(), LV_SYMBOL_AUDIO "  Record",
                                         COL_PRIMARY, 0xFFFFFF, ACT_RECORD);
  lv_obj_set_size(btnRecord, 104, 42);
  lv_obj_align(btnRecord, LV_ALIGN_BOTTOM_LEFT, 12, -62);

  lv_obj_t *btnNext = makeActionButton(lv_scr_act(), "Next " LV_SYMBOL_RIGHT,
                                       COL_PRIMARY_BG, COL_PRIMARY_DK, ACT_NEXT_PATIENT);
  lv_obj_set_size(btnNext, 104, 42);
  lv_obj_align(btnNext, LV_ALIGN_BOTTOM_RIGHT, -12, -62);

  lv_obj_t *btnSessions = makeActionButton(lv_scr_act(), LV_SYMBOL_LIST "  Sessions",
                                           COL_PRIMARY_BG, COL_PRIMARY_DK, ACT_OPEN_SESSIONS);
  lv_obj_set_size(btnSessions, 104, 42);
  lv_obj_align(btnSessions, LV_ALIGN_BOTTOM_LEFT, 12, -12);

  lv_obj_t *btnSync = makeActionButton(lv_scr_act(), LV_SYMBOL_UPLOAD "  Sync",
                                       pending > 0 ? COL_OK : COL_PRIMARY_BG,
                                       pending > 0 ? 0xFFFFFF : COL_PRIMARY_DK,
                                       ACT_OPEN_SYNC);
  lv_obj_set_size(btnSync, 104, 42);
  lv_obj_align(btnSync, LV_ALIGN_BOTTOM_RIGHT, -12, -12);

  setStatePill("READY", COL_OK_BG, COL_OK);

  char status[80];
  if (pending > 0) {
    snprintf(status, sizeof(status), "%lu session(s)  -  %lu pending sync",
             (unsigned long)total, (unsigned long)pending);
    showStatus(status, "Tap Sync to send to SATE");
  } else if (total > 0) {
    snprintf(status, sizeof(status), "%lu session(s)  -  all synced to SATE",
             (unsigned long)total);
    showStatus(status, "Tap Record to start a new session");
  } else {
    showStatus("No sessions yet", "Tap Record to start a session");
  }

  currentState = HOME;
}

// --- Sessions list --------------------------------------------------------

static const int SESSIONS_LIST_MAX = 6;

static void showSessionsScreen()
{
  uiResetPointers();
  lv_obj_clean(lv_scr_act());
  setScreenWhite();
  createHeader("Sessions", ACT_BACK_HOME);
  setStatePill("LIST", COL_PRIMARY_BG, COL_PRIMARY_DK);

  const SatePatient &p = g_patients[currentPatientIndex];

  lv_obj_t *who = lv_label_create(lv_scr_act());
  char whoTxt[64];
  snprintf(whoTxt, sizeof(whoTxt), "%s  (%s)", p.displayName, p.patientId);
  lv_label_set_text(who, whoTxt);
  lv_obj_set_style_text_color(who, lv_color_hex(COL_TEXT_MUTED), 0);
  lv_obj_align(who, LV_ALIGN_TOP_MID, 0, 50);

  char dir[96];
  patientDirPath(dir, sizeof(dir));
  uint32_t total = SD_MMC.exists(dir) ? sessionCount(dir) : 0;

  if (total == 0) {
    lv_obj_t *empty = lv_label_create(lv_scr_act());
    lv_label_set_text(empty, "No recordings yet.\n\nGo back and tap Record.");
    lv_obj_set_style_text_color(empty, lv_color_hex(COL_TEXT_MUTED), 0);
    lv_obj_set_style_text_align(empty, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(empty, LV_ALIGN_CENTER, 0, 0);
    currentState = SESSIONS;
    return;
  }

  // Show up to the 6 most recent sessions, newest first.
  uint32_t first = (total > SESSIONS_LIST_MAX) ? total - SESSIONS_LIST_MAX + 1 : 1;
  int rowY = 76;

  for (uint32_t n = total; n >= first && n >= 1; n--) {
    bool synced = isSessionSynced(dir, n);

    lv_obj_t *row = makeActionButton(lv_scr_act(), "", COL_CARD_BG, COL_TEXT_DARK,
                                     ACT_PLAY_SESSION, (int)n);
    lv_obj_set_size(row, 216, 34);
    lv_obj_align(row, LV_ALIGN_TOP_MID, 0, rowY);
    lv_obj_set_style_radius(row, 10, 0);
    lv_obj_set_style_border_color(row, lv_color_hex(COL_CARD_BORDER), 0);
    lv_obj_set_style_border_width(row, 1, 0);

    lv_obj_t *name = lv_label_create(row);
    char nameTxt[40];
    snprintf(nameTxt, sizeof(nameTxt), LV_SYMBOL_PLAY "  session_%04lu", (unsigned long)n);
    lv_label_set_text(name, nameTxt);
    lv_obj_set_style_text_color(name, lv_color_hex(COL_TEXT_DARK), 0);
    lv_obj_align(name, LV_ALIGN_LEFT_MID, 6, 0);

    lv_obj_t *badge = lv_label_create(row);
    lv_label_set_text(badge, synced ? LV_SYMBOL_OK " SATE" : "pending");
    lv_obj_set_style_text_color(badge, lv_color_hex(synced ? COL_OK : COL_WARN), 0);
    lv_obj_align(badge, LV_ALIGN_RIGHT_MID, -6, 0);

    rowY += 40;
    if (n == 1) break;   // avoid uint32 underflow
  }

  lv_obj_t *hint = lv_label_create(lv_scr_act());
  lv_label_set_text(hint, "Tap a session to play it back");
  lv_obj_set_style_text_color(hint, lv_color_hex(COL_TEXT_MUTED), 0);
  lv_obj_align(hint, LV_ALIGN_BOTTOM_MID, 0, -10);

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
  uint32_t total = sessionCount(dir);
  uint32_t uploadSec = 0;
  for (uint32_t n = 1; n <= total; n++) {
    if (isSessionSynced(dir, n)) continue;
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

  // Kick the connectivity upload sweep and drive it to completion. connLoop()
  // uploads one real session per pass (and marks it synced on the SD only
  // after the server accepts it), so the pending count is ground truth.
  connNotifyNewSession();

  uint32_t guard = millis() + 120000;   // hard stop so the UI never wedges
  uint32_t pending = startPending;
  while (pending > 0 && millis() < guard &&
         connGetMode() == CONN_WIFI_ONLINE) {
    connLoop();
    runGui();
    pending = connPendingTotal();
    uint32_t done = (startPending > pending) ? (startPending - pending) : 0;
    lv_bar_set_value(syncBar, startPending ? (int32_t)((done * 1000ULL) / startPending) : 1000,
                     LV_ANIM_ON);
    char t[48];
    snprintf(t, sizeof(t), "%lu / %lu uploaded",
             (unsigned long)done, (unsigned long)startPending);
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

static void runRecordSavePlaySession()
{
  char dir[96];
  patientDirPath(dir, sizeof(dir));
  if (!SD_MMC.exists(dir)) SD_MMC.mkdir(dir);

  uint32_t sessionNum = findNextSessionIndex(dir);
  if (sessionNum == 0) {
    showStatus("Folder full", "Too many sessions for patient");
    showHomeScreen();
    return;
  }

  char wavPath[160], jsonPath[160];
  sessionWavPath(wavPath, sizeof(wavPath), dir, sessionNum);
  sessionJsonPath(jsonPath, sizeof(jsonPath), dir, sessionNum);

  uint32_t pcmBytes = 0;
  bool ok = recordWavStreamToSd(wavPath, &pcmBytes);

  if (!ok) {
    SD_MMC.remove(wavPath);
    pumpGuiMs(900);
    showHomeScreen();
    return;
  }

  currentState = SAVING_TO_SD;
  setStatePill("SAVE", COL_WARN_BG, COL_WARN);

  uint32_t durationSec = pcmBytes / PCM_BYTES_PER_SEC;
  saveMetadataToSd(jsonPath, wavPath, pcmBytes, durationSec, sessionNum);
  connNotifyNewSession(); // Wi-Fi mode uploads it; BLE mode updates the advert

  // Quick review playback so the SLP can confirm the sample, then home.
  playWavStreamFromSd(wavPath, "review playback");

  showHomeScreen();
  logHeap("session done");
}

static void playSessionFromList(int sessionNum)
{
  char dir[96], wavPath[160];
  patientDirPath(dir, sizeof(dir));
  sessionWavPath(wavPath, sizeof(wavPath), dir, (uint32_t)sessionNum);

  if (!SD_MMC.exists(wavPath)) {
    showSessionsScreen();
    return;
  }

  char caption[40];
  snprintf(caption, sizeof(caption), "playing session_%04d", sessionNum);
  playWavStreamFromSd(wavPath, caption);
  showSessionsScreen();
}

// -----------------------------------------------------------------------------
// Arduino setup / loop
// -----------------------------------------------------------------------------

void setup()
{
  Serial.begin(SERIAL_BAUD);
  delay(1200);

  Serial.println();
  Serial.println("=== SATE Clinical Recorder ===");
  Serial.print("Firmware: ");
  Serial.println(FIRMWARE_VERSION);

  currentState = BOOTING;
  logHeap("boot");

  // One shared Wire bus for touch + ES8311. Begin once, before display init.
  Wire.begin(I2C_SDA, I2C_SCL, I2C_SPEED);

  screen.init();
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
  pumpGuiMs(400);
  bootStepDone(3, true);

  bootScreenFinish();
  // Gate: until the recorder is claimed to an account and has a real patient
  // roster, the user only sees the onboarding screen.
  if (deviceReady()) showHomeScreen();
  else               showOnboardingScreen();
  logHeap("ready");
}

void loop()
{
  runGui();

  if (currentState != ERROR_STATE) {
    connLoop();

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
        showConnectionScreen();      // refresh the live view
      } else if (currentState == HOME) {
        showHomeScreen();            // refresh counts + badge
      } else {
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
    if (connIdentifyReq && uiIdle) {
      connIdentifyReq = false;
      identifyBeepFlash();
    }
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
        currentPatientIndex = (currentPatientIndex + 1) % g_patientCount;
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

    case ACT_RESULTS_DONE:
      if (currentState == RESULTS) showHomeScreen();
      break;

    default:
      break;
  }
}
