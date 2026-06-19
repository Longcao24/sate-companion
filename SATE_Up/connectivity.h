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
const char *connMac();               // "AA:BB:CC:DD:EE:FF" Wi-Fi STA MAC
bool        connProvisioned();
uint32_t    connPendingTotal();      // unsynced sessions across all patients
// Byte progress of the session uploading right now. true while in flight;
// fills sent/total so the UI animates smoothly for a single small session.
bool        connUploadProgress(uint32_t *sent, uint32_t *total);
// Which patient/session is uploading right now (to mark the exact list row).
bool        connUploadingSession(char *pidOut, size_t pidLen, uint32_t *numOut);
// Percent (0-100) of the in-flight upload, or -1 when idle.
int         connUploadPercent();
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
// unprovisioned (back to first-time setup). Now triggered ONLY by the server
// (the SLP removed the device from their account -> heartbeat { unclaimed:true });
// holding BOOT no longer calls this on a claimed device.
void        connFactoryReset();

// Enter "Change Wi-Fi" mode WITHOUT unclaiming: keep the account/server/device
// key and re-open BLE so the companion app can push new Wi-Fi credentials. This
// is what holding BOOT does on a provisioned recorder, and what the remote
// `wifi_change` command does to a device that is currently online.
void        connEnterWifiChange();
bool        connWifiChangeMode();    // true while parked in BLE awaiting new creds

// UI hooks implemented by the .ino — invoked from loop() context only.
extern void sateHookPatientsUpdated(); // /sate/patients.json was rewritten
extern void sateHookConnChanged();     // mode or pending count changed
extern void sateHookRecord();          // app/server asked for a remote recording
// Service the GUI for one tick. Called from inside long blocking connectivity
// work (e.g. streaming a big upload) so the screen stays responsive.
extern void sateHookGuiPump();

// Upload progress UI: shown while a session streams to the server, updated per
// ~1 MB slice with the percent complete.
extern void sateHookUploadBegin();
extern void sateHookUploadProgress(int pct);
extern void sateHookUploadEnd();
// The patient the SLP typed in the app for the next remote recording. Staged by
// the .ino and applied (selected/added to the roster) before the record runs.
extern void sateHookSetActivePatient(const char *id, const char *name,
                                     const char *age, const char *sessionType,
                                     const char *clinician);
