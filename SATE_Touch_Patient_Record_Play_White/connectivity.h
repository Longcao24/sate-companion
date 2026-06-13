// SATE Recorder connectivity (firmware v0.5.0)
// Wi-Fi mode:  uploads sessions straight to the SATE server and polls
//              GET /api/devices/:id/commands (~15 s) for remote commands.
// BLE mode:    when Wi-Fi is unavailable, advertises the SATE service with
//              manufacturer data [0x5A, flags, pending, 0] so the companion
//              app can provision, bridge-sync sessions, and send commands.
//
// The GATT protocol (service/characteristic UUIDs, JSON ops, chunk framing)
// mirrors src/protocol.ts in the companion app exactly.
//
// Libraries required (Arduino IDE -> Library Manager):
//   - NimBLE-Arduino  (v2.x)
//   - ArduinoJson     (v7.x)

#pragma once
#include <Arduino.h>

enum ConnMode {
  CONN_OFF = 0,        // not started / SD failed
  CONN_WIFI_TRYING,    // STA connect attempt in progress
  CONN_WIFI_ONLINE,    // online: uploading + polling commands
  CONN_BLE_ADV,        // advertising, waiting for the companion app
  CONN_BLE_CONNECTED,  // companion app connected (provision / bridge sync)
};

void        connInit(const char *fwVersion);
void        connLoop();              // call every loop() pass; never blocks long
ConnMode    connGetMode();
const char *connSerial();            // "SATE-XXXXXX" (from eFuse MAC)
bool        connProvisioned();
uint32_t    connPendingTotal();      // unsynced sessions across all patients
void        connNotifyNewSession();  // a recording was just saved

// Live status for the on-device Connection screen.
const char *connStatusText();        // e.g. "Connecting to Wi-Fi \"Clinic\"..."
const char *connIp();                // "" when not connected
bool        connSetupActive();       // app connected over BLE / provisioning

// Report what the recorder is doing right now ("idle" / "recording" /
// "uploading"). Pushed to the server in the heartbeat so the app can show it;
// when online it also forces an immediate heartbeat so the change is instant.
void        connSetLiveState(const char *state);

// Wipe stored Wi-Fi + account config and reboot, so the recorder comes back up
// unprovisioned (back to first-time setup). Triggered by holding BOOT 5 s.
void        connFactoryReset();

// UI hooks implemented by the .ino — invoked from loop() context only.
extern void sateHookPatientsUpdated(); // /sate/patients.json was rewritten
extern void sateHookConnChanged();     // mode or pending count changed
extern void sateHookRecord();          // app/server asked for a remote recording
