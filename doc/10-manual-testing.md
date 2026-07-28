# 10 — Manual testing guide

Human, click-through QA for the whole SATE Companion system. This complements the
**automated** hardware harness (`sate ci` / `sate test`, see [07-runbook.md](07-runbook.md)):
the harness proves device audio-integrity on real silicon; this guide covers the
end-to-end and app flows a person has to eyeball — provisioning, the mobile/web apps,
the processing pipeline, and the clinician features.

## How to use this

Each test has a fixed shape:

- **Purpose** — what the test proves (why it exists).
- **Preconditions** — what must be true before you start.
- **Steps** — numbered actions to perform.
- **Expected** — the pass condition. Anything else is a fail; note what you saw.

Conventions:

- 🛑 **Never test against `SATE-D19EB8`** — that is a real in-use unit. Use a spare/test recorder.
- ⚠️ **Plaud tests are device-lock-sensitive** — a mis-bind can permanently brick a Plaud. Read
  [08-plaud.md](08-plaud.md) first and never tap **Unbind** unless the test says so.
- "Web app" = the clinician site (Vercel). "Mobile app" = the iOS companion app.
- Record Pass/Fail + the build/version under test (`sate version`, web git SHA) at the top of each run.

Priority key: **P0** = must pass every release · **P1** = important · **P2** = nice-to-have.

---

## 1. Recorder device (manual smoke)

The harness already covers boot/resume/byte-match/trim automatically. These are the human
checks the harness can't make — physical buttons, the screen, and the field workflow.

### T1.1 — Power on & Ready state · P0
- **Purpose:** the device boots to a usable state (catches the frozen-spinner brick class the harness's boot-health can miss when the UI is alive-but-frozen).
- **Preconditions:** charged test recorder; SD card inserted.
- **Steps:** 1) Hold power / plug in. 2) Watch the screen through boot.
- **Expected:** boot spinner animates (not frozen at frame 1), then the Home screen shows the patient/Standalone label, Wi-Fi + battery chips, and **READY**. No stuck spinner, no black screen.

### T1.2 — Record → stop with the buttons · P0
- **Purpose:** the physical RECORD button captures a take and STOP ends it cleanly.
- **Preconditions:** device READY.
- **Steps:** 1) Press RECORD. 2) Speak ~15 s. 3) Press STOP.
- **Expected:** screen shows a recording/elapsed state while capturing; on stop it returns to READY and the session count increments. A new session appears in the Sessions list.

### T1.3 — Flag marker · P1
- **Purpose:** the FLAG button drops a marker that survives to the web report seek-bar.
- **Steps:** 1) RECORD. 2) Press FLAG at a memorable moment. 3) STOP, sync, open the recording on the web app.
- **Expected:** a flag tick appears on the web report timeline at roughly the flagged offset.

### T1.4 — Wi-Fi sync & "all synced" · P0
- **Purpose:** completed takes upload over Wi-Fi and the device reports sync state honestly.
- **Preconditions:** device provisioned onto Wi-Fi with an unsynced take on the card.
- **Steps:** 1) Leave the device idle on Wi-Fi. 2) Watch the sync indicator.
- **Expected:** the take uploads; the screen shows "All sessions synced". The recording appears in the web app for the owning account.

### T1.5 — SD reclaim keeps the newest 5 · P1
- **Purpose:** old **synced+verified** audio is reclaimed while unsynced/unverified audio is never freed (data-safety).
- **Preconditions:** ≥ 6 synced takes on the device.
- **Steps:** 1) Let the device idle on Wi-Fi. 2) Check the on-device Sessions / a `DIAG` dump over serial.
- **Expected:** only the newest 5 audio-bearing takes keep their audio; older synced takes keep a tombstone (number) but free audio. No unsynced take is ever freed.

---

## 2. Provisioning & mobile app

### T2.1 — First-time claim / provision (BLE) · P0
- **Purpose:** a fresh recorder joins Wi-Fi and claims to the account over Bluetooth.
- **Preconditions:** unclaimed test recorder; phone with the app, signed in; Wi-Fi credentials.
- **Steps:** 1) App → add device → scan. 2) Select the recorder. 3) Choose the Wi-Fi network, enter the password. 4) Provision.
- **Expected:** provisioning progresses through its states (connect → confirm Wi-Fi → register) and ends **claimed**; the device shows the account and goes online; it appears in the app's device list.

### T2.2 — Change Wi-Fi without factory reset · P1
- **Purpose:** moving networks keeps the account binding (no re-claim).
- **Steps:** 1) App → device → change Wi-Fi. 2) Enter new network. 3) Confirm.
- **Expected:** device reconnects on the new network and stays claimed to the same account.

### T2.3 — Pendant pair, stream, stop, find-me · P1
- **Purpose:** the wearable streams audio to the phone and the controls work.
- **Steps:** 1) App → pendant → scan/connect. 2) Start capture, speak ~10 s, stop. 3) Trigger Find-me. 4) Check battery.
- **Expected:** audio streams near-live and assembles into a recording; stop ends it with no extra seconds tacked on; Find-me flashes the pendant LEDs; battery + charging read sanely. A brief silence gap while connected is normal (nap mode), not a disconnect.

### T2.4 — Offline BLE bridge sync · P1
- **Purpose:** when the recorder has no Wi-Fi, the app pulls takes over Bluetooth and only marks synced after the server confirms.
- **Preconditions:** a recorder with an unsynced take and no working Wi-Fi.
- **Steps:** 1) App → device → sync over Bluetooth. 2) Watch the transfer.
- **Expected:** each take transfers fully (size verified), uploads, and only then is marked synced on the device. A dropped/truncated transfer fails loudly and retries rather than uploading a short file.

### T2.5 — Plaud connect (⚠️ lock-safe) · P2
- **Purpose:** a Plaud recorder captures into the same pipeline without breaking its binding.
- **Preconditions:** read [08-plaud.md](08-plaud.md); a test Plaud already bound to THIS account.
- **Steps:** 1) App → Plaud → connect. 2) Capture, sync a take. **Do NOT tap Unbind.**
- **Expected:** connects to the existing binding (never re-binds), the take uploads as a normal recording. If it refuses because the binding belongs to another account, that is correct behavior.

---

## 3. Backend pipeline (end-to-end)

### T3.1 — A take reaches the web report · P0
- **Purpose:** the full async pipeline works: recorder → upload → queue → container → AI → done.
- **Preconditions:** provisioned device on Wi-Fi; signed-in web app.
- **Steps:** 1) Record ~20 s and stop. 2) Wait for upload. 3) Open the web app recordings list. (Optional: `sate e2e` prints per-stage timings.)
- **Expected:** the session moves queued → processing → done; a recording with a transcript appears in the web app within a few minutes.

### T3.2 — Empty / too-short take is handled, not stuck · P1
- **Purpose:** an accidental ~sub-0.4 s take is finalized as **no_text** without looping the AI into a stuck error (the session-35 class).
- **Steps:** 1) Tap RECORD then STOP almost immediately (or trigger a very short remote take). 2) Let it upload + process.
- **Expected:** the session finishes as **done / no_text** (web shows "No text in audio"), NOT stuck in `processing` and NOT a repeated error. No error-alert email fires for it.

### T3.3 — Retry a failed session · P2
- **Purpose:** a session that ended in `error` can be re-queued.
- **Preconditions:** a recording in `error` state.
- **Steps:** 1) Web app → the errored recording → Retry.
- **Expected:** it re-queues and, if the transient cause is gone, completes to done.

---

## 4. Web app — clinician

### T4.1 — Login · P0
- **Purpose:** authentication works (email/password and the mobile-link QR path).
- **Steps:** 1) Sign in with email/password. 2) (If testing QR) web shows a QR → scan with the phone → session established.
- **Expected:** lands on the dashboard with the account's recordings/patients.

### T4.2 — Open a recording & view transcript · P0
- **Purpose:** a processed recording opens with audio + transcript.
- **Steps:** 1) Recordings list → open one (`/report/:id`). 2) Play audio; scroll the transcript.
- **Expected:** audio plays; transcript segments render with speakers; flag ticks (if any) show on the seek bar.

### T4.3 — Edit transcript, save, undo/redo · P1
- **Purpose:** transcript edits persist and undo/redo behaves.
- **Steps:** 1) Enter Edit mode. 2) Change a word / speaker. 3) Undo, Redo. 4) Save. 5) Reload the page.
- **Expected:** undo/redo step correctly; after Save + reload the edit persists; canceling with unsaved changes warns.

### T4.4 — Export SALT · P1
- **Purpose:** the SALT transcript export is well-formed.
- **Steps:** 1) Analysis view → Export SALT. 2) Fill the header fields. 3) Download `.slt`.
- **Expected:** the file has the `$`/`+` header lines then coded utterances (`C The giraffe see/3s ...`, mazes in `( )`), each ending in `. ! ?`.

### T4.5 — Compare to norms (CORS + persistence) · P0
- **Purpose:** the CHILDES norms comparison **loads without "Failed to fetch"** (the CORS-proxy fix) and remembers its inputs **and** result.
- **Preconditions:** a processed recording open; Analysis tab.
- **Steps:**
  1. Open the **Analysis** tab → **Sample Details**.
  2. Enter **Year** (e.g. 6), optionally **Month** + **± Range**.
  3. Click **Compare to norms**.
  4. Close the tab / navigate away, then reopen the same recording's Analysis tab.
  5. Change Year and click **Compare to norms** again.
- **Expected:**
  - Step 3: **no "Failed to fetch"**; MLUm / MLUw bars render with μ, SD, n samples, corpora, and the age window.
  - Step 4: the **form values AND the comparison result** are still there without re-running.
  - Step 5: the result updates to the new query and the new values are remembered.
- **Note:** if you see "Failed to fetch", the norms upstream (ngrok) may be down — check/rotate the `CHILDES_API_URL` secret on the `childes-norms` edge function (see [05-backend-supabase.md](05-backend-supabase.md)).

### T4.6 — Generate SATE Report + export PDF/Word · P0
- **Purpose:** the single-sample clinical report generates and both exports produce openable files matching the on-screen layout.
- **Steps:**
  1. Open a recording → **SATE Report**.
  2. Verify the preview has all 5 sections (transcript, metrics with SD bars, assessment with colored status, limitations, summary).
  3. Set **Patient age** (e.g. `6;0`).
  4. Click **Export PDF** → in the print dialog, Save as PDF.
  5. Click **Export Word** → open `SATE_Report.doc` in Word.
  6. Close the report and reopen it for the same recording.
- **Expected:**
  - The preview matches the report layout.
  - The PDF preserves the bars, colors, and tables.
  - The Word doc opens with the tables + colored status cells (bars may be approximate in Word).
  - Step 6: the **Patient age is still filled in** (persisted).

### T4.7 — Patient management & progress chart · P1
- **Purpose:** patients, recording assignment, and the analytics/progress chart work.
- **Steps:** 1) Create a patient. 2) Assign a recording to them. 3) Open Patient Detail → Analytics.
- **Expected:** the patient saves; the recording links; the progress chart plots the metric over sessions and the trend badge reads sensibly (needs ≥ 2 sessions to draw a line).

### T4.8 — Admin: publish firmware (admin only) · P2
- **Purpose:** only admins can push fleet firmware; the publish flow works.
- **Preconditions:** an admin account and a non-admin account.
- **Steps:** 1) As non-admin, confirm no admin/publish UI. 2) As admin, `/admin` → Publish firmware → upload a test `.bin`.
- **Expected:** non-admin cannot reach publish; admin publish registers the version and it appears as the latest.

---

## 5. Alerting & monitoring

### T5.1 — Error alert email · P1
- **Purpose:** a real pipeline error emails the operator (once, not spammed).
- **Steps:** 1) Cause/observe a session error, OR hit the status worker `/check`. 2) Check `caothohoanglong2404@gmail.com`.
- **Expected:** one alert email for a new problem; a lingering settled error does **not** re-mail every 5 min (only active outages re-remind, ≤ 24 h); an "all clear" arrives when it resolves.

### T5.2 — Daily infrastructure report · P2
- **Purpose:** the once-a-day health report is delivered.
- **Steps:** 1) Hit `GET /check?daily=1` on the status worker (or wait for 08:00 America/New_York). 2) Check email.
- **Expected:** a "Daily infrastructure report" email listing each tier's status + latency and the pipeline digest (errors/stuck/offline).

### T5.3 — Status page · P2
- **Purpose:** the public status page renders uptime.
- **Steps:** open the status worker root URL.
- **Expected:** the 90-day uptime bars render per tier.

---

## 6. OTA / firmware release (operational)

### T6.1 — OTA update a device · P1
- **Purpose:** a published firmware installs over the air on a device with a clean heap.
- **Preconditions:** a test device on an older version; a newer version published.
- **Steps:** 1) If the device has a backlog, queue **reboot** first and wait for it to come back. 2) Queue **ota**. 3) Wait.
- **Expected:** the device downloads and installs, reboots onto the new version, and reports the new `fw`. (Queuing OTA on a backlogged device without rebooting first can fail `err-get-1` — that's expected; reboot then OTA.)

---

## Quick regression smoke (≈10 min)

Run this short list on every web release:

1. **T4.1** login → **T4.2** open a recording → transcript + audio play.
2. **T4.5** Compare to norms → renders, no "Failed to fetch", persists on reopen.
3. **T4.6** SATE Report → preview, set age, Export PDF, Export Word, reopen (age kept).
4. **T4.4** Export SALT downloads a well-formed file.
5. **T3.1** (if hardware available) record a short take → appears processed in the web app.

Record the web git SHA and `sate version` with the result.
