# SATE_PowerTest — what the board really draws asleep

A standalone sketch, deliberately **separate from `SATE_Recorder/`**. It exists to answer one
question that every power decision for this product depends on, and that nobody has measured:

> How much current does the **whole board** draw in deep sleep?

The docs repeat `~10 µA`. That is the **ESP32-S3 datasheet figure for the bare chip**. The thing
in the bag is the chip *plus* a regulator, a power LED, an LCD controller, an ES8311 codec, an SD
card, 8 MB of PSRAM and a battery divider. Those — not the chip — decide whether a recorder used
twice a month is alive when the clinician picks it up.

It is a separate sketch so it can never put a real recorder to sleep by accident, and so it can
strip the board down further than the product firmware ever would.

## Build and flash

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi" SATE_PowerTest
arduino-cli upload -p <port> --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi" SATE_PowerTest
```

Same FQBN as the recorder — `default_8MB`, `PSRAM=opi`. Flashing this **replaces** the recorder
firmware on that unit; reflash `SATE_Recorder` afterwards to put it back.

## Measuring

1. Put a **µA-capable meter in series with the BATTERY**. Not USB — USB powers the board around
   the cell and you would measure nothing. A multimeter on µA gives the static figure; a Nordic
   PPK2 / Joulescope also shows the wake spikes.
2. Flash, then **unplug USB**. The board prints a countdown and drops into deep sleep.
3. Read the current once the screen is dark and it has settled (~10 s).
4. **Press RECORD** to wake it into the next stage.

## The three stages

The useful output is not one number — it is *where* the current goes. Each stage turns off one
more thing, so the **delta between stages names the culprit**. Write down all three.

| Stage | What is off | A big drop here means |
|---|---|---|
| 1 · baseline | backlight only — deep sleep exactly as the product firmware does it | — |
| 2 · sd-off | + SD unmounted, bus pins released | the SD card was the load (0.2–5 mA is normal, a bad card is worse) |
| 3 · quiesced | + every non-RTC GPIO floated | the LCD controller or the codec was being driven |

If the number barely moves across all three, the load is **not** something firmware can reach:
it is the regulator's quiescent current, an always-on power LED, or the battery divider — and
then no amount of sleeping code will fix it.

## Reading the result (3000 mAh cell)

| Measured | Runtime | Verdict |
|---|---|---|
| < 200 µA | ~1.7 years | Deep sleep is fine. Change nothing. |
| ~1 mA | ~125 days | Acceptable. |
| ~5 mA | ~25 days | A unit used twice a month arrives flat. |
| > 5 mA | < 25 days | The 3V3 rail has to be cut in hardware. |

## What this does NOT need to prove

**Charging already works while the system is off.** `doc/12-hardware.md` §8.30: *"USB-C feeds both
the S3's native USB and the charger."* The charger sits on VBUS in parallel with the ESP — it does
not care whether the chip is awake, asleep or held in reset. So no charger IC, power-path chip or
load switch has to be added to keep charging while off. The only open question is what the
**sleeping** board costs, which is what this measures.

## If the rail does have to be cut

Cheapest route, given the charger is already independent: a switch on the **3V3 regulator's EN
pin** — one switch, one wire, no added circuit. VBUS keeps feeding the charger; the whole 3V3 rail
(ESP, LCD, codec, SD, PSRAM) dies.

Two things that come with cutting power abruptly, both verified in the firmware:

- **Mid-recording is survivable.** `FLUSH_EVERY_BYTES = PCM_BYTES_PER_SEC * 5`, so at most ~5 s is
  lost, and `maybeResumeRecording()` picks the take back up on the next boot.
- **Mid-upload is not.** `upResumeOffset` is static RAM, never written to NVS, so a power cut loses
  the resume point and the next attempt restarts from byte 0 — expensive on a 118 MB session.
  A soft-latch (switch → GPIO sense, MCU holds its own power until it has flushed) avoids this for
  about five extra components.

⚠️ **A protected cell (DW01+8205, the 6-pad kind) becomes mandatory.** `enterBatterySleep()` is the
only thing keeping the cell off a deep discharge, and it only runs while the firmware runs. Switch
off with a low cell, leave it three weeks, and the pack is destroyed. The firmware cannot protect
what it is not powering.
