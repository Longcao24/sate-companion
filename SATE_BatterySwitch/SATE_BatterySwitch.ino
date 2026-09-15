// SATE_BatterySwitch — verify the GPIO21 battery-switch sense before it goes in the product.
//
// WHAT THIS IS FOR
// ----------------
// The board exposes no battery-detect line, and the analogue approach does not work: the
// sense divider sits on the board's BAT node, which the charger holds at CV whenever USB is
// present — so with USB in, the node reads the same whether a cell is hanging off it or not.
// Measured: identical mean and identical 62 mV peak-to-peak (the ADC noise floor) with the
// battery in, out, and back in again. The sense point is on the wrong side of the switch and
// no firmware trick changes that.
//
// A wire from the switch to GPIO21 replaces all of that guessing with a fact.
//
//   GPIO21 HIGH (internal pull-up)  -> battery CONNECTED
//   GPIO21 LOW  (switch shorts GND) -> battery DISCONNECTED
//
// GPIO21 was checked free against the full pin map: buttons 0/2/14, ground rail 3, codec I2S
// 4-8, battery sense 9, LCD SPI 10-13 + 46, I2C 15/16, touch 17/18, SD 38-40, backlight 45.
// It is also an RTC GPIO (0-21 on the S3) so it can wake from deep sleep, and it is NOT a
// strapping pin (those are 0, 3, 45, 46).
//
// WHAT THIS SENSE CANNOT DO
// -------------------------
// It cannot give a graceful shutdown. The switch cuts the battery, so with USB unplugged the
// board loses power in the same instant GPIO21 goes low — there is no time to flush. A hold-up
// capacitor does not rescue it either: at ~120 mA, holding 3V3 for 200 ms needs ~80,000 uF, and
// the brownout detector trips long before the rail sags that far.
//
// That is survivable, because the firmware already expects to lose power: audio is flushed to
// SD every 5 s and maybeResumeRecording() picks an interrupted take back up. The one real cost
// was the upload restarting from byte 0, and that is fixed separately by persisting the resume
// offset to NVS.
//
// So this pin's value is KNOWING, not reacting: warn while there is still a battery to warn
// about, and never let a user start a long take on USB alone.
//
// BUILD (CDC flags are required or Serial prints nothing over USB):
//   arduino-cli compile --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi,CDCOnBoot=cdc,USBMode=hwcdc" SATE_BatterySwitch
//   arduino-cli upload -p <port> --fqbn "...,CDCOnBoot=cdc,USBMode=hwcdc" SATE_BatterySwitch
//
// HOW TO TEST
//   Keep USB plugged in (with the battery switched off, USB is the only thing keeping the
//   board alive). Flip the switch back and forth; every change should print within ~50 ms.

#include <Arduino.h>

static const int PIN_BAT_SWITCH = 21;   // LOW = battery cut
static const int PIN_BAT_ADC    = 9;    // for context only — see note above about why it lies
static const int PIN_GND_OUT    = 3;    // the buttons' ground rail; the switch may share it

// A slide switch bounces like any other contact. 40 ms is far longer than the bounce and far
// shorter than a human flip, so a real change is never missed and a bounce is never reported.
static const uint32_t DEBOUNCE_MS = 40;

static int      stable = HIGH;      // last DEBOUNCED level
static int      pending = HIGH;     // level currently being timed
static uint32_t pendingSince = 0;
static uint32_t changes = 0;

static int cellMv()
{
  return (int)(analogReadMilliVolts(PIN_BAT_ADC) * 2);   // x2 undoes the board's 0.5 divider
}

static void report(const char *why)
{
  const bool battery = (stable == HIGH);
  Serial.printf("[%7lums] %-8s  GPIO21=%s  -> battery %-12s  node=%d mV  (changes: %lu)\n",
                (unsigned long)millis(), why,
                battery ? "HIGH" : "LOW",
                battery ? "CONNECTED" : "DISCONNECTED",
                cellMv(), (unsigned long)changes);
  if (!battery) {
    Serial.println("           ^ running on USB ONLY — unplugging the cable now would cut power");
  }
}

void setup()
{
  Serial.begin(115200);
  delay(600);

  // IO3 is a GROUND RAIL, not a signal: it must be driven LOW before anything wired against
  // it can pull a pin down. The product firmware does the same thing, and holds it low through
  // deep sleep as well — without that the RECORD button's wake dies.
  pinMode(PIN_GND_OUT, OUTPUT);
  digitalWrite(PIN_GND_OUT, LOW);

  pinMode(PIN_BAT_SWITCH, INPUT_PULLUP);
  delay(10);
  stable = pending = digitalRead(PIN_BAT_SWITCH);

  Serial.println();
  Serial.println("==================================================================");
  Serial.println("SATE battery-switch sense — GPIO21");
  Serial.println("  HIGH = battery connected     LOW = battery cut");
  Serial.println("  Keep USB plugged in, then flip the switch back and forth.");
  Serial.println("==================================================================");
  report("boot");
}

void loop()
{
  const int now = digitalRead(PIN_BAT_SWITCH);

  if (now != pending) {            // a new level — start timing it
    pending = now;
    pendingSince = millis();
  } else if (pending != stable && (millis() - pendingSince) >= DEBOUNCE_MS) {
    stable = pending;              // held long enough to be real
    changes++;
    report("CHANGE");
  }

  // A slow heartbeat, so a silent line means "sketch died", not "nothing happened".
  static uint32_t lastTick = 0;
  if (millis() - lastTick >= 5000) {
    lastTick = millis();
    report("tick");
  }

  delay(5);
}
