# 1_core — single-core fallback build

A **demo backup** of the recorder firmware. Identical features to
`Hardware_w_Screen/` (2-button + flag, GPIO2 record, ISR buttons, saving spinner,
cached SD, reliable Wi-Fi join + registration, etc.) but it runs **fully
single-core** — the connectivity net task is **never started**, so `connLoop()`
always runs on the main loop, exactly like the original SATE_Up.

Use this if the dual-core build (`Hardware_w_Screen/`) ever **sticks** during a
demo (a rare cross-core hang between the GUI core and the net task). Single-core
can't have that class of bug.

## What's different from `Hardware_w_Screen/`
Just one spot in `loop()`:

```cpp
// dual-core (Hardware_w_Screen): start the net task once online, hand off connLoop()
if (!connNetTaskStarted()) { connLoop(); if (connNetTaskWanted()) connStartNetTask(); }

// 1_core: never start the net task - connLoop() always runs on the main loop
connLoop();
```

Plus the version string is `1.2.23-1c` so the dashboard shows which build is on the
board. Everything else is byte-for-byte the same.

**Trade-off:** while a poll/upload HTTP call is in flight the loop briefly blocks
(~1-2 s during the 12 s command poll). The **ISR-latched buttons still catch the
press instantly** and act on the next pass, so RECORD/FLAG stay responsive; the
screen just may hitch for a moment during a network call. Uploads run between
takes (not during recording), like SATE_Up.

## Build + flash
Folder name != the `.ino` name, so build from a temp sketch dir whose name matches
the `.ino` (arduino-cli requirement):

```bash
SK=/tmp/SATE_Touch_Patient_Record_Play_White
mkdir -p "$SK"
cp 1_core/SATE_Touch_Patient_Record_Play_White.ino "$SK/"
cp 1_core/*.cpp 1_core/*.h "$SK/"
FQBN="esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=8M,PartitionScheme=huge_app,PSRAM=opi"
arduino-cli compile --fqbn "$FQBN" "$SK"
arduino-cli upload -p /dev/cu.usbmodem1101 --fqbn "$FQBN" "$SK"
```

A good flash ends with `Hard resetting via RTS pin...`. The boot screen shows
`v1.2.23-1c`.

## Switch back to dual-core
Flash `Hardware_w_Screen/` the same way (it reports `v1.2.23`). No config is lost -
both builds share the same NVS/SD layout, so a provisioned device stays provisioned
across the swap.
