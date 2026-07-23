# Build, flash & firmware release

Real commands for every component. Line-precise detail and the long-form recipe are in
`CLAUDE.md` and `doc/07-runbook.md`.

**Quick path — the `sate` CLI** (`pip install -e hwtest`, or `./hwtest/sate`):

```bash
sate flash recorder     # build + flash the recorder (auto-detects the port)
sate flash pendant      # build + flash the pendant (Seeed core)
sate doctor --device    # diagnose a board before/after flashing
```

`sate flash` wraps the exact `arduino-cli` / `flash_xiao.sh` invocations below; use those
directly when you need finer control (compile-only, a specific port, the release image).

## Recorder firmware (ESP32-S3)

Folder name matches the `.ino`, so it builds in place — no temp copy.

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi" SATE_Recorder
arduino-cli upload -p <port> --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi" SATE_Recorder
```

- Board is 16 MB flash + 8 MB octal (OPI) PSRAM. `PSRAM=opi` mandatory.
- **`PartitionScheme` MUST be `default_8MB`** (dual `ota_0`+`ota_1`). Never `huge_app` (single
  slot, silently kills OTA).
- Check `~/Documents/Arduino/libraries/lv_conf.h`: `LV_TICK_CUSTOM 1` + montserrat 12/14/20.
  A fresh `lib install lvgl` resets these — re-fix after any lvgl install.
- Manual esptool merged-bin flashing needs flash mode **dio** (qio = black screen); the port is
  `/dev/cu.usbmodem101`. Serial only appears when built `CDCOnBoot=cdc,USBMode=hwcdc`.
- iCloud gotcha: `~/Documents/Arduino/libraries` is under iCloud; lvgl can evict to placeholders
  and `cc1plus` hangs. Fix: `arduino-cli lib uninstall lvgl && arduino-cli lib install lvgl@8.4.0`,
  then re-fix `lv_conf.h`.

## Pendant firmware (nRF52840)

```bash
./SATE_Pendant/flash_xiao.sh SATE_Pendant     # FQBN Seeeduino:nrf52:xiaonRF52840SensePlus
```

Seeed core only. A factory-fresh or Adafruit-corrupted board needs a DFU SoftDevice+bootloader
restore first (`adafruit-nrfutil dfu serial … Seeed_…_s140_7.3.0.zip`). See `doc/09-pendant.md`.

## Firmware release + OTA (recorder)

1. Bump `FIRMWARE_VERSION` in `SATE_Recorder/SATE_Recorder.ino`, compile with the FQBN above.
2. The OTA image is the **app** bin (`SATE_Recorder.ino.bin`, ~1.7 MB), NOT `.ino.merged.bin`
   (full 8 MB, first USB flash only).
3. Publish (programmatic path — no browser):
   ```bash
   curl -X POST "$SUPABASE_URL/storage/v1/object/firmware/sate_<v>.bin" \
     -H "Authorization: Bearer $KEY" -H "apikey: $KEY" \
     -H "Content-Type: application/octet-stream" -H "x-upsert: true" --data-binary @<bin>
   ```
   then insert a row via the Supabase MCP `execute_sql`:
   `insert into sate_firmware (version, url, notes) values ('<v>', '$SUPABASE_URL/storage/v1/object/public/firmware/sate_<v>.bin', '<notes>');`
   `$KEY` = the Supabase `sb_secret_…` key (not the repo's `svc-…` app key). Verify the public
   URL 200s and its SHA-256 matches the local bin. Treat a pasted secret as compromised → rotate.
4. **OTA with a backlog fails `err-get-1`** (fragmented heap): queue `reboot`, wait for it to come
   back, THEN queue `ota`.

## Mobile app (Expo, iOS)

Plaud is iOS-device-only (no simulator) and needs a custom dev build (not Expo Go).

```bash
npm install
npm run ios            # expo run:ios — build + install the dev client on a device
npm start              # expo start --dev-client — Metro for an installed build
npx tsc --noEmit       # typecheck (filter react_app_sate-ui_update @/… alias noise)
xcodebuild -workspace ios/SATECompanion.xcworkspace -scheme SATECompanion -sdk iphoneos \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build   # compile-check native module, no signing
```

Proprietary Plaud frameworks under `modules/plaud-sate/ios/Frameworks/` are git-ignored — never commit.

## Web app (React 19 + Vite 6)

```bash
cd react_app_sate-ui_update && npm install
npm run dev
npm run build          # tsc -b && vite build — REQUIRED before push (noUnusedLocals fails on unused vars)
npm run preview
git subtree push --prefix=react_app_sate-ui_update webapp <branch>   # Vercel builds the subtree repo
```

## Docs site

```bash
cd docs-site && npm install
npm start
npm run build && npm run deploy:cf     # → sate-docs.pages.dev
```
