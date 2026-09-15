// SATE_PowerTest — measure what the RECORDER BOARD actually draws in deep sleep.
//
// WHY THIS EXISTS
// ---------------
// Every power decision for this product hangs on one number nobody has measured:
// the whole-board deep-sleep current. The docs repeat "~10 uA", but that is the
// ESP32-S3 DATASHEET figure for the bare chip. A dev board is the chip plus a
// regulator, a power LED, an LCD controller, an audio codec, an SD card, 8 MB of
// PSRAM and a battery divider — and those, not the chip, decide whether the unit
// survives three weeks in a bag.
//
// This sketch is deliberately SEPARATE from SATE_Recorder: it must not be able to
// put a clinician's recorder to sleep by accident, and it needs to strip the board
// down further than the product firmware ever would.
//
//   arduino-cli compile --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi" SATE_PowerTest
//   arduino-cli upload  -p <port> --fqbn "..." SATE_PowerTest
//
// HOW TO MEASURE
// --------------
//   1. Put a uA-capable meter IN SERIES WITH THE BATTERY (not USB — USB powers the
//      board around the cell and you would measure nothing). A plain multimeter on
//      uA is fine for a static reading; a Nordic PPK2 / Joulescope shows the wake
//      spikes too.
//   2. Flash, then UNPLUG USB. The board runs on battery, prints the countdown, and
//      drops into deep sleep.
//   3. Read the current once the screen is dark and it has settled (~10 s).
//   4. Press the RECORD button to wake it and read the next stage.
//
// WHAT THE NUMBER MEANS (3000 mAh cell)
//   < 200 uA  -> ~1.7 years. Deep sleep is fine; change nothing.
//   ~1 mA     -> ~125 days.  Acceptable.
//   ~5 mA     -> ~25 days.   A unit used twice a month arrives flat.
//   > 5 mA    -> the 3V3 rail has to be cut in hardware.
//
// STAGES
// ------
// The point is not one number, it is WHERE the current goes. Each press of RECORD
// advances one stage, turning off one more thing, so the DELTA between stages names
// the culprit. Note the reading at every stage.
//
// ⚠️ Charging is unaffected by any of this. Per doc/12-hardware.md §8.30, USB-C feeds
// the charger in parallel with the S3 — the charger does not care whether the ESP is
// awake, asleep, or held in reset. "Keep charging while off" is already true; the
// only question this sketch answers is how much the SLEEPING board costs.

#include <Arduino.h>
#include <driver/rtc_io.h>
#include <esp_sleep.h>
#include <SD_MMC.h>

// ---- Pins (from doc/12-hardware.md §2 — keep in step with the real firmware) ----
static const gpio_num_t PIN_REC_BTN = GPIO_NUM_2;    // RECORD, active LOW, RTC-capable
static const gpio_num_t PIN_GND_OUT = GPIO_NUM_3;    // GROUND RAIL for the buttons, not a signal
static const int        PIN_BACKLIGHT = 45;          // active HIGH
static const int        PIN_BAT_ADC = 9;             // ADC1, behind the board's 0.5 divider

// SD (SD_MMC 1-bit, as the recorder uses it)
static const int PIN_SD_CLK = 39, PIN_SD_CMD = 38, PIN_SD_D0 = 40;

// Seconds to hold each stage awake before sleeping, so the meter can settle and the
// serial line can be read.
static const uint32_t SETTLE_S = 12;

RTC_DATA_ATTR int stage = 0;   // survives deep sleep — this is what advances each wake

struct Stage { const char *name; const char *what; };
static const Stage STAGES[] = {
  { "baseline",   "deep sleep exactly as the product firmware does it (backlight off only)" },
  { "sd-off",     "+ SD card unmounted and its bus pins released" },
  { "quiesced",   "+ every non-RTC GPIO floated (LCD controller, codec and any LED left undriven)" },
};
static const int STAGE_COUNT = sizeof(STAGES) / sizeof(STAGES[0]);

static int batteryMv()
{
  // The board halves the cell through an on-board divider, so read x2. Same as the
  // firmware's readBatteryMv() minus the 1-point calibration, which does not matter
  // for a power measurement.
  return (int)(analogReadMilliVolts(PIN_BAT_ADC) * 2);
}

static void backlightOff()
{
  pinMode(PIN_BACKLIGHT, OUTPUT);
  digitalWrite(PIN_BACKLIGHT, LOW);
}

static void sdOff()
{
  // Unmounting is NOT the same as removing power: the card keeps its own idle draw
  // (0.2-5 mA on a bad card, which would dwarf the chip). Releasing the bus at least
  // stops us holding lines high into it.
  SD_MMC.end();
  for (int p : { PIN_SD_CLK, PIN_SD_CMD, PIN_SD_D0 }) {
    gpio_reset_pin((gpio_num_t)p);
  }
}

static void floatEverything()
{
  // Return every non-RTC, non-essential pin to a high-impedance input so nothing is
  // being driven into the LCD controller, the codec or an LED while we sleep. GPIO3
  // is deliberately EXCLUDED: it is the buttons' ground rail and must keep sinking,
  // or the wake below can never fire.
  for (int p = 0; p <= 21; p++) {
    if (p == PIN_REC_BTN || p == PIN_GND_OUT) continue;
    gpio_reset_pin((gpio_num_t)p);
  }
  for (int p = 33; p <= 48; p++) {
    gpio_reset_pin((gpio_num_t)p);
  }
}

static void sleepNow()
{
  // IO3 must KEEP sinking through deep sleep. A normal GPIO output is released when
  // the digital core powers down, so the RECORD button — whose common sits on IO3 —
  // would have no return path and the ext0 wake could never fire. IO3 is RTC-capable,
  // so latch it low in the RTC domain and hold it. (Same rule as the firmware.)
  rtc_gpio_init(PIN_GND_OUT);
  rtc_gpio_set_direction(PIN_GND_OUT, RTC_GPIO_MODE_OUTPUT_ONLY);
  rtc_gpio_set_level(PIN_GND_OUT, 0);
  rtc_gpio_hold_en(PIN_GND_OUT);

  rtc_gpio_pullup_en(PIN_REC_BTN);
  rtc_gpio_pulldown_dis(PIN_REC_BTN);
  esp_sleep_enable_ext0_wakeup(PIN_REC_BTN, 0);   // wake on press (LOW)

  Serial.println("[PWR] asleep — READ THE METER NOW. Press RECORD for the next stage.");
  Serial.flush();
  delay(50);
  esp_deep_sleep_start();                         // never returns
}

void setup()
{
  Serial.begin(115200);
  delay(400);

  // Release the hold applied before the last sleep, or IO3 stays latched and the
  // pin cannot be reconfigured.
  rtc_gpio_hold_dis(PIN_GND_OUT);
  rtc_gpio_deinit(PIN_GND_OUT);
  pinMode((int)PIN_GND_OUT, OUTPUT);
  digitalWrite((int)PIN_GND_OUT, LOW);
  pinMode((int)PIN_REC_BTN, INPUT_PULLUP);

  const bool woke = esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT0;
  if (woke) stage++;
  if (stage >= STAGE_COUNT) stage = 0;

  Serial.println();
  Serial.println("=====================================================");
  Serial.printf("SATE power test — stage %d/%d: %s\n", stage + 1, STAGE_COUNT, STAGES[stage].name);
  Serial.printf("  %s\n", STAGES[stage].what);
  Serial.printf("  cell: %d mV\n", batteryMv());
  Serial.println("  UNPLUG USB if you have not — otherwise you measure nothing.");
  Serial.println("=====================================================");

  backlightOff();
  if (stage >= 1) sdOff();
  if (stage >= 2) floatEverything();

  for (uint32_t i = SETTLE_S; i > 0; i--) {
    Serial.printf("  sleeping in %lus\r", (unsigned long)i);
    Serial.flush();
    delay(1000);
  }
  Serial.println();
  sleepNow();
}

void loop() { /* never reached — setup() always ends in deep sleep */ }
