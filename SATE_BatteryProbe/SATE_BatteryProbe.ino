// SATE_BatteryProbe — is a battery actually connected?
//
// THE QUESTION
// ------------
// The board exposes no battery-detect pin (doc/12-hardware.md §8.30: the charger
// has no CHRG/STAT line either), so presence has to be INFERRED from the one
// analogue signal there is: the cell node on GPIO9, behind the board's 0.5 divider.
//
// WHY THE PRODUCT FIRMWARE CANNOT SEE IT
// --------------------------------------
// readBatteryMv() averages 32 reads taken back-to-back in ~3 ms. That is exactly
// right for killing ADC noise, and it is exactly wrong here: it destroys the signal
// we want. A charger with NO cell on it cycles — it charges its output cap to the CV
// setpoint, terminates, the node sags, it charges again — with a period of SECONDS.
// Averaged over 3 ms you see a clean DC level and learn nothing. Sampled over
// seconds, the cycling is obvious. Same pin, different cadence.
//
// A real cell's capacitance flattens that ripple completely.
//
//   ripple LARGE  -> no battery          (trustworthy)
//   ripple FLAT   -> probably a battery  (NOT trustworthy — see below)
//
// ⚠️ The asymmetry is the same trap as the charge detection in §8.30: one direction
// is evidence, the other is only an absence of evidence. If this particular charger
// holds CV steadily instead of cycling, or its output cap is large, then "no battery"
// also reads flat and the test is useless in that direction. THAT is what this probe
// is here to find out — measure it, do not assume it.
//
// Deliberately NOT using voltage LEVEL to decide: a relaxed cell sits ~4.15-4.18 V and
// an empty node sits at the ~4.2 V setpoint, a 20-50 mV gap — smaller than the error in
// BAT_CAL_GAIN, which is a one-point calibration taken on a single unit.
//
// BUILD — the CDC flags matter, without them Serial prints NOTHING over USB:
//   arduino-cli compile --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi,CDCOnBoot=cdc,USBMode=hwcdc" SATE_BatteryProbe
//   arduino-cli upload -p <port> --fqbn "...,CDCOnBoot=cdc,USBMode=hwcdc" SATE_BatteryProbe
//
// HOW TO RUN
//   1. Keep USB plugged in (the board runs off USB, and the charger needs VBUS to
//      cycle at all — that is the signal).
//   2. Open the serial monitor at 115200.
//   3. Run it WITH the battery in. Note the p-p figure.
//   4. Unplug the battery, leave USB in. Note the p-p figure.
//   5. Compare. If they differ by a lot, presence is detectable in firmware.
//      If both are flat, it is not — and that needs hardware, not code.

#include <Arduino.h>

static const int  PIN_BAT_ADC = 9;          // ADC1, behind the board's 0.5 divider
static const int  SAMPLE_HZ   = 20;         // spread over seconds, NOT back-to-back
static const int  WINDOW_S    = 2;          // report every 2 s
static const int  WINDOW_N    = SAMPLE_HZ * WINDOW_S;

// Raw single read, x2 for the divider. No BAT_CAL_GAIN on purpose: it is a one-point
// calibration from a DIFFERENT unit, and a linear scale cannot change a ratio anyway.
static int cellMvRaw()
{
  return (int)(analogReadMilliVolts(PIN_BAT_ADC) * 2);
}

void setup()
{
  Serial.begin(115200);
  delay(600);
  Serial.println();
  Serial.println("=================================================================");
  Serial.println("SATE battery probe — watching the cell node for charger ripple");
  Serial.println("  Keep USB PLUGGED IN. Pull the battery, then put it back, and");
  Serial.println("  compare the p-p (peak-to-peak) column.");
  Serial.println("    p-p large -> no battery.  p-p flat -> probably a battery.");
  Serial.println("=================================================================");
  Serial.println("     mean      min      max      p-p   verdict");
}

void loop()
{
  int mn = INT32_MAX, mx = INT32_MIN;
  long sum = 0;

  for (int i = 0; i < WINDOW_N; i++) {
    const int v = cellMvRaw();
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    sum += v;
    delay(1000 / SAMPLE_HZ);
  }

  const int mean = (int)(sum / WINDOW_N);
  const int pp   = mx - mn;

  // 40 mV is well clear of this ADC's noise on a 2 s window (a few mV) while being far
  // below the swing a cycling charger produces. Tune it once the real numbers are in —
  // that is the entire point of running this.
  const char *verdict = (pp > 40) ? "RIPPLE -> no battery?" : "flat -> battery?";

  Serial.printf("  %6d   %6d   %6d   %6d   %s\n", mean, mn, mx, pp, verdict);
}
