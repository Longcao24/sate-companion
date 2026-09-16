# 13 — System test (user-side)

Generated from `SATE_Complete_English_Test_Cases.xlsx` — 88 cases, 65 of them P0. The
workbook stays the source of truth for **what** is tested; this document is how a person
actually runs it, and what an engineer checks on the server for each case.

The workbook lives at `doc/testdata/`. After editing it, re-extract to `cases.json` and run
`python3 doc/gen-system-test.py`, so the two never drift.

Related: [10-manual-testing.md](10-manual-testing.md) is the engineer-facing pass against a
real board, and [11-user-testing.md](11-user-testing.md) is the short plain-language script
for a non-technical tester. This is the exhaustive one — the release gate.

> Every case has two halves. **The user half** you can run with a recorder, a phone and a
> browser — no database access, no shell. **The server note** is a quoted block underneath,
> for whoever has Supabase and Cloudflare access; it names the actual table, column, route
> and constant to look at, and flags the known defects that will make specific cases fail.

## Scope of this run

**The mobile app and the pendant are not being tested.** The recorder, the backend and AI
pipeline, the web app, PDF export and security are.

| | Cases | P0 |
|---|---|---|
| **Running this pass** | **67** | **51** |
| Deferred — mobile app | 13 | 10 |
| Deferred — pendant / BLE | 8 | 4 |

Scope was assigned from each case's **Components** field, not by category name — the
categories cut across surfaces. `SATE-SEC-003` sits under Security but its components are
"SATE Web App; Mobile App", so the web half stays in and the app half drops out. Eight cases
run in **reduced** form like that; each says exactly what to skip.

### ⚠️ What deferring costs you

**`RQ-22` — Pending data during logout/account switch** is marked *Required* and now has **zero test
coverage**. Every case covering it (`SATE-APP-006`, `SATE-APP-007`, `SATE-APP-008`, `SATE-SEC-004`) is a
mobile-app case. Deferring the app leaves a REQUIRED requirement with zero test coverage. Acceptable only while the app is not shipping.

`SATE-QUE-006` is also deferred, and it is the case written to prove the two delivery paths
deduplicate. With the app out of scope there is only one path in use, so the duplicate-session
risk cannot materialise — but the underlying gap (no database unique constraint behind the
dedup probe) stays unproven. **Run it before the app ships.**

The deferred cases are parked, not deleted. To bring them back, set their entries in
`doc/testdata/test-scope.json` to `"In scope"` and regenerate.

## How to run this

1. **Settle the blocking requirements first.** Ten of the 22 requirements are still
   "Needs confirmation" or "Partially defined". A case whose expected result depends on an
   undecided rule cannot pass or fail — it can only be *recorded*. They are listed below.
2. **Run P0 before P1/P2.** 65 cases are P0. A failed P0 is a release blocker by default.
3. **Use a fresh session label per run.** Say it aloud at the start and end of every
   recording: *"Session &lt;ID&gt; begins now"* … *"Session &lt;ID&gt; ends now."* It is the only way to
   prove a transcript belongs to the audio you think it does.
4. **Capture evidence as you go**, not afterwards. For every P0: session ID, account, device
   ID, app/firmware version, timestamps, screenshots or video, local vs server duration and
   size, request IDs, and a transcript screenshot.
5. **Stop and preserve state on a P0 failure.** Do not retry, reboot, or delete — the state
   at the moment of failure is the evidence.

### What counts as a release blocker

Any of: data loss, corruption, cross-user exposure, wrong patient/session association, an
unrecoverable P0 workflow, a duplicate canonical session, or a **false Completed status**.

### Before you touch a device

Run `sate infra` (in `hwtest/`) to confirm every tier is up — auth, database, `device-api`
including the v15 verify route, Storage, the Cloudflare worker, the AI queue, and device
heartbeat. Half of a failed test run is usually a service that was already down.
`sate pipeline` gives a live animated view of a session moving through the pipeline, which
is the fastest way to see *where* something stopped.

## What you need

| | |
|---|---|
| **Accounts** | User A and User B, both clinician/editor, each owning their own sessions. A viewer and an admin account if those roles exist. |
| **Recorders** | R1 and R2. Record serial, firmware version, assigned account, battery health, storage capacity. |
| **BLE devices** | Two clearly labelled physical devices with known IDs. Test alone and in a crowded room. |
| **Phones** | Oldest supported iPhone, current iPhone, low-end supported Android, current Android flagship. |
| **Browsers** | Chrome, Edge, Safari — record exact versions and OS. |
| **Networks** | Stable Wi-Fi · fully offline · Wi-Fi with no internet · captive portal · weak/flapping · switching networks mid-upload. |
| **Audio** | 15 s minimum-boundary · 2–5 min standard · silent (room tone) · noisy multi-speaker · 30/45/60 min with markers every 10 min · special-character/Unicode script. |

## Settle these first

These ten requirements are undecided. Cases that depend on them can be executed, but record
the observed behaviour rather than marking pass/fail.

| ID | Topic | What has to be decided |
|---|---|---|
| `RQ-05` | Audio integrity tolerance | Checksum method and acceptable duration difference between local and server audio. |
| `RQ-06` | Interrupted recording policy | Recommended: preserve captured audio as an Interrupted session — never silently discard, never mark Completed. |
| `RQ-07` | Minimum and maximum duration | Minimum accepted length, maximum supported duration, warning timing, behaviour at the limit. |
| `RQ-09` | Upload resume strategy | Resumable/chunked vs full restart, incomplete-object cleanup, backoff, concurrent-retry prevention. |
| `RQ-11` | 5xx/timeout retry policy | Three attempts is implemented; confirm attempt counting, timeout classification, backoff, jitter, late responses. |
| `RQ-12` | 4xx handling | Which 4xx classes are retryable, and what the user is told to do. |
| `RQ-13` | Manual retry/reprocess | Who may retry, when, whether audio is re-uploaded, how attempts are versioned. |
| `RQ-15` | Transcript editing and versioning | Is the web app read-only or editable? Original AI result retention, conflict handling, audit trail. |
| `RQ-20` | Performance and reliability SLA | Acceptable upload/processing/PDF times, resource use, retry limits, maximum stuck-state duration. |
| `RQ-21` | Direct Wi-Fi vs mobile path | Which recordings use each path, whether both may run for one recording, and the dedup rule. |

> **RQ-21 is the one to settle before testing `SATE-QUE-006`.** Two delivery paths exist
> today and deduplication rests on a probe with no database constraint behind it. See that
> case's server note.

## Index

| Category | Cases | P0 |
|---|---|---|
| [End-to-End Recording and Sync](#end-to-end-recording-and-sync) | 6 | 3 |
| [Recorder Interruption and Local Persistence](#recorder-interruption-and-local-persistence) | 7 | 7 |
| [Network, Offline, and Upload Recovery](#network-offline-and-upload-recovery) | 10 | 6 |
| [Queue, Batch, and Concurrency](#queue-batch-and-concurrency) | 5 | 5  *(+1 deferred)* |
| [Long Session and Performance](#long-session-and-performance) | 5 | 4  *(+1 deferred)* |
| [BLE and Device Connectivity](#ble-and-device-connectivity) | 0 | 0  *(+8 deferred)* |
| [Mobile App Lifecycle and Authentication](#mobile-app-lifecycle-and-authentication) | 0 | 0  *(+8 deferred)* |
| [Backend, Retry, and AI Processing](#backend-retry-and-ai-processing) | 12 | 12 |
| [Web Transcript Review](#web-transcript-review) | 7 | 5 |
| [PDF Export](#pdf-export) | 6 | 3 |
| [Security, Privacy, and Data Isolation](#security-privacy-and-data-isolation) | 6 | 6  *(+1 deferred)* |
| [Compatibility and Deployment](#compatibility-and-deployment) | 3 | 0  *(+2 deferred)* |
| **Total running** | **67** | **51** |

## Who runs what

Every case is classified by **who can execute it and decide the outcome** — not by which
components the code touches. That distinction matters for scheduling: a "Both" case needs
two people in the room, or one person holding both kinds of access.

| | Cases | P0 | Meaning |
|---|---|---|---|
| 🧑 **End-user** | 24 | 11 | A tester with a recorder, a phone and a browser runs it and decides pass/fail unaided. No database, no logs, no shell. |
| 🧑🖥 **Both** | 51 | 41 | The user performs the action, but the pass criteria cannot be confirmed without a server check. |
| 🖥 **Server-side** | 13 | 13 | Cannot be run or judged from the UI. Needs fault injection, queue inspection, or direct API calls. |

So a tester working alone can execute **75 cases** but can only
*close out* 24 of them. The other 51 wait on an engineer.

### The end-user set

- **BLE and Device Connectivity** — `SATE-BLE-001`, `SATE-BLE-002`, `SATE-BLE-003`, `SATE-BLE-004`, `SATE-BLE-005`, `SATE-BLE-006`
- **Mobile App Lifecycle and Authentication** — `SATE-APP-001`, `SATE-APP-002`, `SATE-APP-008`
- **Web Transcript Review** — `SATE-WEB-001`, `SATE-WEB-002`, `SATE-WEB-003`, `SATE-WEB-004`, `SATE-WEB-007`
- **PDF Export** — `SATE-PDF-001`, `SATE-PDF-002`, `SATE-PDF-003`, `SATE-PDF-004`, `SATE-PDF-005`, `SATE-PDF-006`
- **Security, Privacy, and Data Isolation** — `SATE-SEC-001`
- **Compatibility and Deployment** — `SATE-COMP-001`, `SATE-COMP-002`, `SATE-COMP-005`

### The server-side set

- **Backend, Retry, and AI Processing** — `SATE-BE-001`, `SATE-BE-002`, `SATE-BE-003`, `SATE-BE-004`, `SATE-BE-005`, `SATE-BE-006`, `SATE-BE-007`, `SATE-BE-008`, `SATE-BE-009`, `SATE-BE-010`, `SATE-BE-011`, `SATE-BE-012`
- **Security, Privacy, and Data Isolation** — `SATE-SEC-007`

Everything not listed above is **Both**.

---

## End-to-End Recording and Sync

### SATE-E2E-001 · Standard online recording, upload, processing, review, and PDF export

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Functional / End-to-End · `RQ-01`, `RQ-02`, `RQ-03`, `RQ-04`, `RQ-16`, `RQ-20`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify the complete production workflow for a normal session.

**Before you start.** Test user is active; recorder is assigned to the user; stable Internet is available; backend services are healthy; no existing test session uses the planned test label.

**Use.** 5-minute normal speech recording; stable Wi-Fi; supported browser.

**Do this**

1. Start a new recording.
2. Speak the unique session label at the beginning and end.
3. Stop and save the recording.
4. Wait for upload and processing to complete.
5. Open the session in the Web App.
6. Review transcript and annotations.
7. Export the SATE report as PDF.

**You should see**

Recorder shows clear Recording, Saved, Uploading, Processing, and Completed states. The Web
App shows the correct session, audio, transcript, annotations, and report controls. PDF opens
successfully.

**Check before you call it passed**

Confirm session ID, user ID, device ID, timestamps, duration, audio beginning/end markers,
transcript-session match, valid annotation JSON, and PDF-session match.

**Passed if.** All steps complete without manual recovery; no data loss, duplication, mis-association, or unhandled error occurs.

> ⚠️ Depends on undecided requirement(s) `RQ-20` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Watch one row move through the state machine and stop: `select id, status, attempts,
> processed, recording_id, bytes, storage_path, process_error from sate_device_sessions where
> device_serial = '<serial>' order by created_at desc limit 5;` Status must go `queued →
> processing → done` and settle. `recording_id` must be non-null and resolve to exactly one
> `recordings` row. Confirm the storage object really exists — a row alone is not proof (the
> 413 bug once left ghost rows with no object). Then confirm the audio the recorder freed
> matches: `GET /api/sessions/verify?...` must answer `stored:true` for that session number
> and byte count. `sate pipeline` shows this live.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-E2E-002 · Very short recording near the minimum supported duration

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P1 · Boundary / Functional · `RQ-01`, `RQ-07`, `RQ-14`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify expected handling of a valid recording near the minimum duration.

**Before you start.** Minimum supported duration is documented or a provisional threshold is agreed for testing.

**Use.** 10-15 second recording containing one clearly spoken sentence.

**Do this**

1. Start recording.
2. Record for the minimum supported duration.
3. Stop and sync.
4. Open the result in the Web App.
5. Attempt PDF export if the session completes.

**You should see**

The recorder either accepts the session or shows a documented minimum-duration message. The
Web App does not display an unexplained blank result.

**Check before you call it passed**

Check actual duration, session status, transcript presence, and absence of orphan records.

**Passed if.** Behavior matches the documented minimum-duration requirement and leaves the system in a consistent state.

> ⚠️ Depends on undecided requirement(s) `RQ-07` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> A take under `MIN_AUDIO_SEC` (env, default **0.4 s**) never reaches the AI at all — the
> container finalizes it `no_text` up front, because the AI service answers HTTP 500 on a
> near-empty WAV and a 5xx reads as transient, which used to retry-loop into a stuck error
> (hit real on session 35). So a 10–15 s take is well above that floor and must transcribe
> normally. There is no other minimum enforced server-side — RQ-07 is still unsettled, so
> record what actually happens rather than asserting a threshold.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-E2E-003 · Silent or near-silent recording

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P1 · Negative / Functional · `RQ-14`, `RQ-20`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify that absence of speech is distinguished from pipeline failure.

**Before you start.** Backend services are healthy.

**Use.** 2-minute recording with room tone and no intentional speech.

**Do this**

1. Record two minutes of silence or near-silence.
2. Stop and sync.
3. Wait for processing.
4. Open the session in the Web App.
5. Review status, transcript, and annotations.

**You should see**

The session displays a clear outcome such as No Detectable Speech, Low Confidence, or an empty
transcript with explanation. It must not remain indefinitely in Processing.

**Check before you call it passed**

Verify audio is playable and complete; transcript is not copied from another session; result
JSON is valid.

**Passed if.** The system distinguishes valid silent audio from upload/processing failure and provides an actionable status.

> ⚠️ Depends on undecided requirement(s) `RQ-20` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Silence is a *result*, not a failure. `cf-processor` calls `finalize({no_text:true})`, the
> edge marks the session `done`, and **no `recordings` row is created**. Verify `select
> status, no_text, recording_id from sate_device_sessions where id='<id>'` gives `done / true
> / null`. A session sitting in `processing` here is the real bug — check the container logs
> before blaming the AI.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-E2E-004 · Noisy recording with multiple speakers and interruptions

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P1 · Robustness / Functional · `RQ-14`, `RQ-20`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify that difficult audio degrades recognition quality gracefully without breaking the pipeline.

**Before you start.** Normal end-to-end environment is available.

**Use.** 5-minute recording with background noise, two speakers, pauses, overlapping speech, and brief interruptions.

**Do this**

1. Record the prepared noisy scenario.
2. Stop and sync.
3. Review transcript, speaker-related output if supported, annotations, warnings, and PDF.

**You should see**

The session completes or shows a defined low-quality warning. The UI remains responsive and
does not mislabel the result as an upload failure.

**Check before you call it passed**

Check that output belongs to this audio, JSON fields are parseable, and no unrelated
transcript appears.

**Passed if.** The session reaches a defined terminal state with no crash, malformed data, or cross-session contamination.

> ⚠️ Depends on undecided requirement(s) `RQ-20` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Nothing special server-side: one `sate_device_sessions` row, one `recordings` row. Check
> `recordings.transcript` parses as JSON and `recordings.analysis` has the computed metrics
> (`ntw`, `ndw`, `mluw`, `mlum`, `errorCounts`). Diarization quality is not a pass criterion —
> pipeline integrity is.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-E2E-005 · Session metadata, timestamp, time-zone, and device association

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Data Integrity · `RQ-01`, `RQ-02`, `RQ-19`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify that metadata remains correct across recorder, backend, Web App, and exported report.

**Before you start.** Recorder and phone clocks are set correctly; test account and device assignment are known.

**Use.** One 2-minute session created near a known clock time; record local time zone.

**Do this**

1. Note user, recorder ID, local start time, and end time.
2. Record and sync a session.
3. Compare metadata in device UI, database, Web App, and PDF.
4. Refresh and reopen the session.

**You should see**

User name/ID, device, date, time, duration, and session label are consistent and displayed in
the intended time zone.

**Check before you call it passed**

Compare session ID, user ID, device ID, start/end timestamps, time zone, and calculated
duration across all components.

**Passed if.** No incorrect user/device association, unexplained time shift, or material duration discrepancy is present.

> **Server side.**
>
> Canonical timestamps are stored UTC (ISO-8601). Compare `sate_device_sessions.created_at`,
> `recordings.created_at`, and what the web app renders; a mismatch is a display-layer bug,
> not a storage one. Device association is `sate_devices.id` → `sate_device_sessions.user_id`;
> it must not change on refresh.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-E2E-006 · Repeated Stop, Save, Upload, or Submit actions

> ✂️ **Reduced scope.** Repeat Stop / Save / Upload on the recorder only. Skip the app's Submit control.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Reliability / Idempotency · `RQ-03`, `RQ-21`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify that rapid repeated user actions do not create duplicate sessions or jobs.

**Before you start.** Normal recording is in progress; tester can tap controls rapidly.

**Use.** 2-minute recording; stable network.

**Do this**

1. End the recording.
2. Rapidly tap Stop/Save several times.
3. If an Upload or Retry control appears, tap it repeatedly.
4. Wait for completion.
5. Inspect session list and backend records.

**You should see**

Controls become disabled or requests are safely deduplicated. The user sees only one session.

**Check before you call it passed**

Count session records, storage objects, processing attempts, transcripts, and reports linked
to the source recording.

**Passed if.** Repeated actions never create duplicate user-visible sessions, duplicate reports, or conflicting final states.

> ⚠️ Depends on undecided requirement(s) `RQ-21` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> This is the idempotency case. `storeSessionRecord` probes for an existing row by **(user,
> serial, patient, session_number, bytes) + objectExists** and reuses it, which is what stops
> a lost BLE `markSynced` ACK creating a second take. ⚠️ **There is still no database unique
> constraint behind that probe.** Under a genuine race the probe can be passed twice. If you
> get two rows for one recording here, that is the known gap, not a new defect — log it
> against RQ-03.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

---

## Recorder Interruption and Local Persistence

### SATE-REC-001 · Graceful recorder restart during an active recording

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Recovery · `RQ-06`, `RQ-03`, `RQ-04`

*Needs:* Recorder · phone · browser + Supabase read access · Serial console on the recorder

**Goal.** Verify that a normal restart during recording does not silently lose captured audio.

**Before you start.** Recorder battery and storage are sufficient; a session is actively recording.

**Use.** 5-minute intended recording; restart after approximately 2 minutes.

**Do this**

1. Start recording and speak a beginning marker.
2. After two minutes, perform a normal device restart.
3. Restart the recorder.
4. Inspect recovered/pending sessions.
5. Sync any recovered partial session.

**You should see**

The recorder clearly identifies the interrupted session. Recommended behavior: preserve the
recorded portion and label it Interrupted; do not silently discard it.

**Check before you call it passed**

Play the recovered audio; verify beginning marker, duration, file readability, status, and
absence of duplication.

**Passed if.** Captured audio is preserved or intentionally rejected according to a documented rule, and the user receives an explicit status.

> ⚠️ Depends on undecided requirement(s) `RQ-06` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Segments flush to SD roughly every 5 s, so at most ~5 s of tail is at risk. On boot
> `maybeResumeRecording()` re-enters the same session — **every** take resumes, button-started
> and server-started alike (fw ≥1.5.16). Serial should show `[CONN] resume … session N`. The
> session number must not change: numbers are allocated monotonically and never renumbered (fw
> ≥1.5.20). A hole in the numbering is legal; a *reused* number is a defect.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-REC-002 · Forced power loss during an active recording

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Recovery / Fault Injection · `RQ-04`, `RQ-06`

*Needs:* Recorder · phone · browser + Supabase read access · Serial console on the recorder

**Goal.** Verify crash-safe local audio persistence when shutdown cannot complete cleanly.

**Before you start.** Recorder is actively recording; tester can disconnect power or force shutdown safely.

**Use.** 5-minute intended recording; forced shutdown after approximately 2 minutes.

**Do this**

1. Start recording and speak a beginning marker.
2. Force power loss without using the normal stop control.
3. Restore power.
4. Inspect recovered data and device messages.
5. Sync any recoverable session.

**You should see**

The recorder reports an interrupted or recovered session rather than showing a completed
recording. It must not claim success if the audio is corrupted.

**Check before you call it passed**

Verify file readability, duration, beginning marker, session count, error logs, and local
cleanup behavior.

**Passed if.** No silent data loss, false Completed state, or duplicate session occurs.

> ⚠️ Depends on undecided requirement(s) `RQ-06` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Same resume path as REC-001, and the one that matters most. Two things to check on the
> serial log: `[MEM] ready` (boot completed) and `[CONN] resume … session N`. The resume runs
> from `loop()`, never `setup()` (fw ≥1.5.17) — if the device comes back and is *unreachable*
> (no heartbeat, remote stop ignored), that regression is back and it is a release blocker:
> the take runs to the ~62-minute ceiling with nobody able to stop it.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-REC-003 · Low-battery shutdown during recording

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Recovery / Hardware · `RQ-06`, `RQ-20`

*Needs:* Recorder · phone · browser + Supabase read access · Serial console · bench power supply or drained cell

**Goal.** Verify low-battery warnings and safe session preservation.

**Before you start.** Recorder battery can be reduced to the low-battery threshold.

**Use.** Recording continues until low-battery warning and shutdown.

**Do this**

1. Begin a recording with low remaining battery.
2. Continue until warning appears.
3. Observe whether recording stops automatically or the device shuts down.
4. Recharge and restart.
5. Inspect and sync the session.

**You should see**

A warning appears early enough for action. Recommended behavior: safely stop and save before
shutdown when possible.

**Check before you call it passed**

Check duration, file readability, battery-related event log, status, and upload result.

**Passed if.** Audio captured before shutdown is handled according to the documented low-battery rule with no false success.

> ⚠️ Depends on undecided requirement(s) `RQ-06`, `RQ-20` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Low-voltage cutoff uses the GPIO9 battery sense (`analogReadMilliVolts × 2` behind the
> board's 0.5 divider). Confirm the partial take survived to SD and later uploads with its
> real byte count. Battery telemetry lands in `sate_devices.battery_pct` / `battery_mv` via
> the heartbeat.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-REC-004 · Insufficient local storage before recording starts

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Negative / Boundary · `RQ-04`, `RQ-07`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify that the recorder prevents a session that cannot be stored safely.

**Before you start.** Local storage is below the defined minimum free-space threshold.

**Use.** Recorder with intentionally reduced free storage.

**Do this**

1. Attempt to start a recording.
2. Observe the message and controls.
3. Free sufficient storage.
4. Retry recording.

**You should see**

The recorder blocks recording or clearly warns the user before capture begins. After space is
freed, normal recording is available.

**Check before you call it passed**

Verify free-space check, absence of zero-byte files, absence of orphan session records, and
successful retry after cleanup.

**Passed if.** The user cannot unknowingly begin a recording that the device cannot preserve.

> ⚠️ Depends on undecided requirement(s) `RQ-07` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Nothing reaches the server. Confirm no orphan row in `sate_device_sessions` and no object in
> the `device-sessions` bucket. A row with `storage_path` set but no object is the failure
> signature to look for.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-REC-005 · Local storage becomes full during recording

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Recovery / Boundary · `RQ-04`, `RQ-06`

*Needs:* Recorder · phone · browser + Supabase read access · SD card able to be filled to capacity

**Goal.** Verify safe termination when storage is exhausted during capture.

**Before you start.** Recorder starts with enough space for a short recording but not for the planned duration.

**Use.** Continue recording until storage is exhausted.

**Do this**

1. Start recording.
2. Continue until the storage-full condition occurs.
3. Observe device behavior.
4. Restart if required.
5. Inspect and sync recoverable audio.

**You should see**

The recorder stops safely and shows a specific storage error. It must not continue displaying
Recording after writes have failed.

**Check before you call it passed**

Check final playable duration, file size, error status, session count, and cleanup of
temporary files.

**Passed if.** The condition is detected, communicated, and handled without silent corruption or false completion.

> ⚠️ Depends on undecided requirement(s) `RQ-06` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> The recorder must stop cleanly and keep what it captured. Server-side the take arrives as a
> normal short session. Verify byte count matches `sessionAssembledBytes()` semantics: part0
> keeps its 44-byte WAV header, later parts are stripped — the server's stored `bytes` must
> equal that exactly, because `GET /sessions/verify` compares it before the device frees
> audio.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-REC-006 · Restart during the local save/finalization step

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Recovery · `RQ-03`, `RQ-04`, `RQ-06`

*Needs:* Recorder · phone · browser + Supabase read access · Serial console · ability to cut power at a chosen moment

**Goal.** Verify crash safety while the recorder finalizes audio and creates the upload queue item.

**Before you start.** A recording is ready to stop; tester can restart immediately after Stop.

**Use.** 5-minute recording.

**Do this**

1. Record five minutes.
2. Press Stop.
3. Restart the recorder while Save/Finalizing is displayed.
4. Restart and inspect session/queue state.
5. Allow synchronization.

**You should see**

After restart, the session is either safely recovered and queued once or clearly marked
failed. The UI must not show two copies.

**Check before you call it passed**

Compare local files, queue entries, backend records, audio duration, and processing jobs.

**Passed if.** No duplicate session, orphan temporary file affecting storage, or silent loss occurs.

> ⚠️ Depends on undecided requirement(s) `RQ-06` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> The crash window is inside finalization. Either a complete take or a recoverable partial is
> acceptable; a take marked synced with no server object is not. Check for the ghost
> signature: a `.synced` marker on device with no matching row/object server-side.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-REC-007 · Restart after recording stops but before upload begins

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Recovery · `RQ-03`, `RQ-08`, `RQ-10`

*Needs:* Recorder · phone · browser + Supabase read access · Serial console on the recorder

**Goal.** Verify persistence of a locally saved, not-yet-uploaded session.

**Before you start.** Recording has stopped and is locally saved; network upload has not begun.

**Use.** 3-minute recording.

**Do this**

1. Record and stop the session.
2. Restart immediately before upload starts.
3. Reconnect to network.
4. Observe queue recovery and final result.

**You should see**

The pending session reappears after restart and uploads automatically or through the
documented resume action.

**Check before you call it passed**

Verify local-to-server session identity, queue persistence, audio completeness, and final
status.

**Passed if.** The pending session survives restart and completes without user re-recording.

> **Server side.**
>
> Nothing has been uploaded yet, so the server should show no row until connectivity returns.
> Then exactly one row appears. This is the case that proves reclaim safety: the device must
> NOT free the audio until `GET /api/sessions/verify` (device-api ≥v15) returns `stored:true`
> — which checks the row **and** `objectExists`. Any doubt keeps the audio.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

---

## Network, Offline, and Upload Recovery

### SATE-NET-001 · Recording starts and ends while fully offline

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Offline / Recovery · `RQ-04`, `RQ-08`, `RQ-10`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify offline recording and automatic upload when connectivity returns.

**Before you start.** Wi-Fi is disabled or unavailable before the session starts.

**Use.** 5-minute recording; restore Internet after the session is saved.

**Do this**

1. Disable connectivity.
2. Record and stop a session.
3. Confirm local Pending Upload status.
4. Restore Internet.
5. Wait without manually creating a second session.
6. Review the session on the Web App.

**You should see**

Recording works offline. The session is visibly queued. When Internet returns, upload starts
automatically or at the documented trigger.

**Check before you call it passed**

Verify local persistence, same session ID before/after upload, complete audio, queue removal
only after server acknowledgement, and no duplicate.

**Passed if.** Offline recording is preserved and completes automatically after connectivity returns.

> **Server side.**
>
> No server activity during the take. On reconnect, one row appears with the full byte count.
> Confirm the recorder did not free SD audio in the meantime — verified trim only releases
> audio for synced takes older than the newest `KEEP_AUDIO_SESSIONS` (=5) **and** only after
> byte-exact `stored:true`.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-NET-002 · Internet connection is lost during recording

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Offline / Functional · `RQ-04`, `RQ-10`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify that recording is independent of Internet availability.

**Before you start.** Recording begins online.

**Use.** 5-minute session; disable Internet after 1 minute and restore after Stop.

**Do this**

1. Start online recording.
2. Disable Internet during capture.
3. Continue recording.
4. Stop the session while offline.
5. Restore Internet and wait for completion.

**You should see**

Recording continues without interruption. The device shows offline/pending status after Stop
and later uploads normally.

**Check before you call it passed**

Check audio for gaps at the disconnect point, duration, queue state, and final transcript
match.

**Passed if.** No capture gap, crash, duplicate session, or misleading completion status occurs.

> **Server side.**
>
> The take continues locally; Wi-Fi loss must not stop capture. Watch for the upload retrying
> after association returns. If the device came up offline and the AP is down, the offline
> fallback still starts the net task so heartbeat, remote stop and OTA health-confirm keep
> working — verify the device is reachable during the take.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-NET-003 · Internet is lost after Stop but before upload starts

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Recovery · `RQ-08`, `RQ-10`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify correct queuing when a saved session cannot begin uploading.

**Before you start.** Recording is complete; upload has not yet started.

**Use.** 3-minute recording.

**Do this**

1. Stop the recording.
2. Immediately disable Internet.
3. Confirm Pending Upload status.
4. Restore Internet.
5. Observe automatic upload and processing.

**You should see**

The session remains visible and queued. No repeated user action is required unless explicitly
designed.

**Check before you call it passed**

Verify one session, one audio object, correct status transitions, and no loss of local file
before acknowledgement.

**Passed if.** The saved session survives the outage and completes once connectivity returns.

> **Server side.**
>
> Nothing on the server until connectivity returns, then one complete row. Check `GET
> /sessions/upload-progress` (device-api ≥v16) reports zero in-flight bytes while offline.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-NET-004 · Internet drops during an active upload

> ▶ Run the recorder's direct Wi-Fi upload path.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Recovery / Data Integrity · `RQ-03`, `RQ-09`, `RQ-10`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify upload retry or resume without duplication or file corruption.

**Before you start.** An upload large enough to interrupt is in progress.

**Use.** 10-minute or larger session; disable Internet at approximately 40% upload.

**Do this**

1. Start upload.
2. Disable Internet mid-transfer.
3. Wait for failure detection.
4. Restore Internet.
5. Allow automatic retry/resume.
6. Inspect backend and Web App.

**You should see**

The session changes to a retryable/pending state and later completes. The UI does not remain
permanently stuck at Uploading.

**Check before you call it passed**

Compare local/server file size, duration, checksum if available, beginning/end markers, object
count, and processing job count.

**Passed if.** The final server audio is complete and playable, with exactly one user-visible session and no orphan file that affects later processing.

> ⚠️ Depends on undecided requirement(s) `RQ-09` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Chunked upload stores each slice as its own `_tmp/<patient>/s<n>/<offset>.part` object and
> stitches once on the final slice (device-api ≥v12 — the earlier design rewrote the whole
> temp blob per slice, was quadratic, and stalled long uploads). A resumed upload must not
> duplicate parts. If the sizes disagree the edge rejects rather than storing a corrupt WAV.
> Inspect leftover `_tmp/` objects after success — they should be gone.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-NET-005 · Connectivity returns while app/device is in background or screen is locked

> ✂️ **Reduced scope.** Recorder idle or asleep when connectivity returns. Skip phone background / screen-lock.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Recovery / Mobile Lifecycle · `RQ-10`, `RQ-19`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify the documented background upload behavior.

**Before you start.** A session is pending offline; mobile app is backgrounded or phone is locked before Internet returns.

**Use.** Pending 5-minute session; supported phone OS.

**Do this**

1. Create an offline pending session.
2. Background the app or lock the phone.
3. Restore Internet.
4. Wait for the documented background window.
5. Unlock/open the app if necessary.
6. Check completion.

**You should see**

Upload either starts in the background as designed or begins immediately when the app is
reopened. The pending session is not lost.

**Check before you call it passed**

Verify OS logs if available, queue persistence, session count, and final audio completeness.

**Passed if.** Behavior matches the supported background policy and no session remains permanently stranded.

> **Server side.**
>
> Server side just sees a later upload. The interesting check is that only ONE upload lands,
> not one per foreground/background transition.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-NET-006 · Wi-Fi is connected but Internet access is unavailable

> ✂️ **Reduced scope.** Recorder's own network detection only. Skip the app's detection.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P1 · Negative / Recovery · `RQ-10`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify that the system checks real Internet/backend reachability rather than Wi-Fi association only.

**Before you start.** Connect to a router with no Internet access.

**Use.** 3-minute session.

**Do this**

1. Connect to Wi-Fi without Internet.
2. Record and stop a session.
3. Observe upload status.
4. Restore Internet without changing Wi-Fi if possible.
5. Wait for upload.

**You should see**

The UI indicates Offline, Cannot Reach Service, or Pending Upload rather than claiming
successful upload.

**Check before you call it passed**

Verify local file remains, backend has no incomplete Completed record, and final upload
creates one session.

**Passed if.** The system does not confuse Wi-Fi connection with successful synchronization.

> **Server side.**
>
> Associated-but-no-internet must be classified as a transient failure, not a permanent one.
> The session should stay `queued` (or return to it), never jump to `error`.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-NET-007 · Captive portal or authentication-required Wi-Fi

> ✂️ **Reduced scope.** Recorder behind the captive portal only. Skip the app.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P2 · Negative / Compatibility · `RQ-10`, `RQ-19`

*Needs:* Recorder · phone · browser + Supabase read access · A captive-portal access point

**Goal.** Verify safe behavior on a network that requires browser sign-in.

**Before you start.** Connect to a captive-portal network without completing sign-in.

**Use.** 3-minute pending session.

**Do this**

1. Connect to captive-portal Wi-Fi.
2. Attempt sync.
3. Complete portal sign-in.
4. Observe retry and completion.

**You should see**

The system shows a network error/pending state until Internet is usable, then retries without
creating a second session.

**Check before you call it passed**

Verify queue durability, one final session, and correct error recovery.

**Passed if.** The session remains safe until the network becomes usable and then completes normally.

> **Server side.**
>
> Captive portal returns an HTTP 200 with HTML rather than the expected JSON. Confirm the
> device treats an unparseable body as a failure and keeps the audio — a 2xx alone must never
> be read as "durably stored". This is exactly the class that produced the 413 ghosts.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-NET-008 · Switch from one Wi-Fi network to another or to a hotspot during upload

> ▶ Run the recorder's direct Wi-Fi upload path.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P1 · Recovery / Compatibility · `RQ-09`, `RQ-10`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify transfer recovery after IP/network changes.

**Before you start.** Upload is in progress and a second valid network is available.

**Use.** 10-minute recording.

**Do this**

1. Start upload on Network A.
2. Disconnect from Network A mid-upload.
3. Connect to Network B or hotspot.
4. Wait for retry/resume.
5. Inspect final session.

**You should see**

The upload recovers without requiring a new recording. Status updates remain understandable.

**Check before you call it passed**

Check object/session counts, file completeness, processing job count, and final transcript.

**Passed if.** Network switching does not produce corruption, duplication, or permanent Uploading state.

> ⚠️ Depends on undecided requirement(s) `RQ-09` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Same as NET-004: the stitch must be resilient to the connection changing underneath it.
> Check final `bytes` equals the device's assembled byte count.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-NET-009 · Rapidly flapping or weak network

> ▶ Run the recorder's direct Wi-Fi upload path.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P1 · Stress / Reliability · `RQ-09`, `RQ-10`, `RQ-20`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify bounded retry behavior under unstable connectivity.

**Before you start.** Network can be toggled or throttled.

**Use.** 10-minute session; alternate online/offline several times.

**Do this**

1. Start upload.
2. Alternate online and offline states several times.
3. End with a stable connection.
4. Wait for completion.
5. Review retry count and final records.

**You should see**

The UI does not spam duplicate sessions or become unresponsive. It eventually completes or
reaches a clear retryable state.

**Check before you call it passed**

Review attempt count, backoff timing, session/object counts, final file integrity, and queue
cleanup.

**Passed if.** The system recovers when stability returns and never creates conflicting final states.

> ⚠️ Depends on undecided requirement(s) `RQ-09`, `RQ-20` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Expect repeated `attempts` increments. `requeue_session` applies backoff for transient
> failures; the watchdog `requeue_stale_sessions(p_stuck_minutes=90, p_max_attempts=3)`
> reclaims anything abandoned. The session must not exceed `MAX_ATTEMPTS` (3) and must settle.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-NET-010 · User taps manual Retry while automatic retry is already running

> ▶ Use the recorder's retry, or the web app's Retry control.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Concurrency / Idempotency · `RQ-03`, `RQ-09`, `RQ-13`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify that manual and automatic retry paths cannot duplicate the upload.

**Before you start.** A retryable upload failure is present and automatic retry is scheduled or active.

**Use.** 5-minute failed/pending session.

**Do this**

1. Trigger an upload failure.
2. Restore connectivity.
3. Tap Retry repeatedly while automatic retry begins.
4. Wait for final completion.
5. Inspect backend attempts and records.

**You should see**

Only one active upload is presented to the user. Extra taps are disabled, ignored, or safely
deduplicated.

**Check before you call it passed**

Count upload requests, storage objects, sessions, processing jobs, and user-visible entries.

**Passed if.** Manual/automatic retry concurrency never creates a duplicate or corrupt final session.

> ⚠️ Depends on undecided requirement(s) `RQ-09`, `RQ-13` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Concurrent retry prevention. The user Retry route is `POST /sessions/:id/retry` (device-api
> ≥v14) and it **only accepts a session in `error`** — a `processing` row is refused, which is
> what stops a manual tap racing the container. `claim_next_session` is `SELECT … FOR UPDATE
> SKIP LOCKED`, so a double claim is impossible even if two workers ran. Confirm `attempts`
> increments by one, not two.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

---

## Queue, Batch, and Concurrency

### SATE-QUE-001 · Five recordings made consecutively while online

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Functional / Batch · `RQ-03`, `RQ-08`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify unique session creation and correct ordering for normal back-to-back use.

**Before you start.** Stable network; no pending sessions.

**Use.** Recordings of 30 sec, 1 min, 2 min, 3 min, and 5 min, each with a unique spoken label.

**Do this**

1. Create five recordings with less than 20 seconds between sessions.
2. Allow uploads to occur.
3. Review the queue and Web App.
4. Open each transcript.

**You should see**

All five sessions appear once with correct order, labels, dates, and durations. Starting the
next session does not overwrite the previous one.

**Check before you call it passed**

Match each audio beginning/end marker to its transcript; compare timestamps, duration, and
session IDs.

**Passed if.** All five sessions complete without overwrite, merging, omission, or cross-session transcript assignment.

> **Server side.**
>
> Five rows, five distinct `session_number`s, five `recordings`. The container drains the
> queue **serially** (`max_instances = 1`, GPU concurrency is 1 anyway), so expect sequential
> completion, not parallel. Total time ≈ sum of individual processing times — that is by
> design, not a stall.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-QUE-002 · Start a new recording while the previous session is uploading

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Concurrency / Functional · `RQ-03`, `RQ-08`, `RQ-10`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify simultaneous recording and background upload, or correct prevention if unsupported.

**Before you start.** Session A is uploading; recorder is ready for another action.

**Use.** Session A: 10 minutes; Session B: 2 minutes.

**Do this**

1. Start uploading Session A.
2. Attempt to start Session B.
3. Complete Session B.
4. Wait for both sessions to finish.
5. Review results.

**You should see**

The UI follows the documented rule: either allows Session B safely or clearly blocks it. If
allowed, statuses remain distinct.

**Check before you call it passed**

Verify no audio mixing, file overwrite, shared session ID, or status crossover.

**Passed if.** Both sessions are handled correctly according to the documented concurrency requirement.

> **Server side.**
>
> A new take must not disturb an in-flight upload. Note the delete/upload interaction rule: a
> delete defers-and-drops the uploader **only if it is latched on that exact session**
> (`upDropReq`); any other session's upload is untouched.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-QUE-003 · Five offline recordings queued and uploaded later

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Offline / Batch · `RQ-04`, `RQ-08`, `RQ-10`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify durable multi-session queueing.

**Before you start.** Device is offline and has sufficient storage.

**Use.** Five recordings with unique labels and varying lengths.

**Do this**

1. Disable Internet.
2. Record five sessions.
3. Restart the recorder/app once while still offline.
4. Confirm all five remain queued.
5. Restore Internet.
6. Wait for all sessions to complete.

**You should see**

All five queued sessions remain visible after restart and later upload. Progress/status is
shown per session.

**Check before you call it passed**

Check queue persistence, upload order, session count, audio/transcript mapping, and no
duplicates.

**Passed if.** No queued session is lost, merged, duplicated, or indefinitely blocked.

> **Server side.**
>
> Five queued rows appear on reconnect. Order is by `created_at`; the claim query is
> `status='queued' order by created_at`. Session numbers must be distinct and none reused.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-QUE-004 · One queued session fails while later sessions continue

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Reliability / Fault Isolation · `RQ-08`, `RQ-11`, `RQ-13`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify that a single bad item does not block the entire queue.

**Before you start.** At least three sessions are queued; a fault can be injected for Session 2.

**Use.** Three queued sessions; cause Session 2 upload or processing to fail.

**Do this**

1. Queue Sessions 1-3.
2. Inject a failure for Session 2.
3. Restore normal service.
4. Observe Sessions 1 and 3.
5. Retry Session 2.

**You should see**

Each session shows its own status. Failure of Session 2 does not hide or freeze Sessions 1 and
3.

**Check before you call it passed**

Verify per-session attempt counts, queue progression, final session count, and audio mapping.

**Passed if.** Queue processing is fault-isolated and recoverable.

> ⚠️ Depends on undecided requirement(s) `RQ-11`, `RQ-13` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Per-item fault isolation. One row going to `error` must not block the others — verify the
> remaining four reach `done`. `pg_cron` pings the Worker `/tick` every minute to keep the
> container warm; if everything stalls together, check the container is awake before blaming
> the queue.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-QUE-005 · Queue order and status persist across app/recorder restart

> ▶ Restart the recorder, not the app.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Recovery / Batch · `RQ-08`, `RQ-10`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify durable queue state and deterministic resumption.

**Before you start.** Several sessions are Pending, Uploading, and Failed/Retryable.

**Use.** Three or more sessions in different queue states.

**Do this**

1. Create mixed queue states.
2. Restart the recorder/app.
3. Inspect order and statuses.
4. Restore connectivity/service.
5. Observe resumption.

**You should see**

All queue entries reappear with correct identities and understandable statuses.

**Check before you call it passed**

Compare queue entries before/after restart, session IDs, attempt counts, and final records.

**Passed if.** Restart does not alter session identity, lose queue entries, or create duplicate uploads.

> **Server side.**
>
> Queue state lives in Supabase, not in the app or the container — a restart of either must
> resume from the database. The container has no state to lose.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-QUE-006 · Same recording reaches backend through direct Wi-Fi and mobile-app paths

> ⏸ **Deferred — mobile app is not in scope for this run.**
>
> This case exists to prove the two delivery paths deduplicate. With the mobile app out of scope there is only one path in use, so the duplicate-session risk cannot materialise — but the gap it was written to catch (no database unique constraint behind the dedup probe) stays unproven. Run it before the app ships.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Architecture / Idempotency · `RQ-03`, `RQ-21`

*Needs:* Recorder · phone · browser + Supabase read access · Ability to force both the direct Wi-Fi and phone-bridged upload paths

**Goal.** Verify deduplication when both supported data paths attempt to sync the same source recording.

**Before you start.** Direct Wi-Fi and BLE/mobile paths are both enabled for the same test recording, or the condition can be simulated.

**Use.** One uniquely labeled 5-minute recording.

**Do this**

1. Create one recording.
2. Trigger/allow both direct Wi-Fi and mobile-app sync paths.
3. Wait for all requests to finish.
4. Inspect backend and Web App.

**You should see**

The user sees one session only. Any duplicate-path message is clear and non-blocking.

**Check before you call it passed**

Compare source recording ID, idempotency key, session/object/job counts, and final transcript.

**Passed if.** Dual-path delivery never creates duplicate sessions, conflicting metadata, or double processing.

> ⚠️ Depends on undecided requirement(s) `RQ-21` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> **The highest-risk case in the book.** Two paths can deliver one recording: the recorder's
> device-key `POST /sessions` and the phone's user-authed `POST /sessions` (used for Plaud and
> BLE-bridged takes, which have no device key). Dedup relies on `storeSessionRecord`'s probe
> by (user, serial, patient, session_number, bytes) + `objectExists`. ⚠️ **No unique
> constraint backs it.** If both paths run for one recording, expect this to be where a
> duplicate canonical session appears — a release blocker by the workbook's own severity
> rules. Test it deliberately and record the outcome against RQ-21.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

---

## Long Session and Performance

### SATE-LONG-001 · Recording at the 30-minute boundary

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Boundary / Performance · `RQ-07`, `RQ-20`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify behavior at the stated long-session threshold.

**Before you start.** Device is fully charged with sufficient storage and stable network.

**Use.** Exactly 30-minute session with beginning, midpoint, and end markers.

**Do this**

1. Record exactly 30 minutes.
2. Stop and sync.
3. Wait for processing.
4. Review audio, transcript, annotations, and PDF.

**You should see**

No timeout, crash, or unexplained warning occurs at the boundary. Progress remains responsive.

**Check before you call it passed**

Check complete duration, all spoken markers, file size, memory/error logs, transcript
coverage, and PDF pagination.

**Passed if.** The complete 30-minute session is preserved, processed, reviewed, and exported successfully.

> ⚠️ Depends on undecided requirement(s) `RQ-07`, `RQ-20` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> A 30-minute 16 kHz mono take is ~57 MB. Confirm it lands whole.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-LONG-002 · Forty-five-minute recording

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Performance / End-to-End · `RQ-07`, `RQ-20`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify a realistic extended clinical session.

**Before you start.** Battery, storage, and network are sufficient.

**Use.** 45-minute recording with markers every 10 minutes.

**Do this**

1. Record 45 minutes.
2. Stop and sync.
3. Monitor upload and processing time.
4. Review all markers in audio/transcript.
5. Export PDF.

**You should see**

Device/app remains responsive. The Web App can load and navigate the long transcript.

**Check before you call it passed**

Validate duration, all interval markers, file integrity, transcript continuity, processing
time, and PDF pagination.

**Passed if.** All content is complete and usable with no resource-related failure.

> ⚠️ Depends on undecided requirement(s) `RQ-07`, `RQ-20` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> ~86 MB. Watch the Storage limits — there are **two**, and the **smaller** wins: the project-wide
> one and the bucket's own `file_size_limit`. The bucket's is the one that has actually bitten
> (uploads died at 200 MiB while the project sat at 500 MB). Both are **5 GB** now. If long sessions
> land as rows with `process_error: "download failed: Object not found"`, check both — a swallowed
> 413 plus a `.synced` written on a false 2xx destroyed a 62-minute recording once.
> `storeSessionRecord` now throws on upload failure rather than swallowing it.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-LONG-003 · Maximum supported recording duration

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Boundary / Performance · `RQ-07`, `RQ-20`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify the documented maximum duration and user warning behavior.

**Before you start.** Maximum duration is confirmed by product/engineering.

**Use.** Session at the maximum duration and, if safe, an attempt to exceed it.

**Do this**

1. Record until the maximum duration.
2. Observe warning or automatic stop behavior.
3. Attempt to continue if allowed.
4. Sync and review.

**You should see**

The recorder warns before the limit and safely stops or blocks additional recording according
to requirement.

**Check before you call it passed**

Check final duration, end marker, file readability, status, and absence of a second unintended
session.

**Passed if.** Maximum-duration behavior is predictable, safe, and fully documented.

> ⚠️ Depends on undecided requirement(s) `RQ-07`, `RQ-20` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> The firmware ceiling is ~62 minutes (~118 MB). Beyond the storage limit above, note the
> former timeout tension, now closed: `AI_READ_TIMEOUT_S` is 3600 s (60 min) and `STUCK_MINUTES`
> used to be 45, so a single legitimate AI read could outlive the stale cutoff. **This analysis
> was right that it was safe in practice** — `loop()` is strictly sequential
> (`requeue_stale()` → `claim_next()` → `process()`), so while a worker is inside `process()`
> nothing calls the watchdog, and there is only one worker. `STUCK_MINUTES` is now **90**
> anyway: the invariant "the watchdog outlasts the longest legitimate job" should hold by
> construction rather than by an accident of single-threading, and this file itself contemplates
> adding concurrency — at which point 45 becomes a live bug. The cost is that a genuinely dead
> job now takes 90 min to reclaim instead of 45.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-LONG-004 · Long-session upload interrupted and resumed

> ▶ Run the recorder's direct Wi-Fi upload path.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Recovery / Performance · `RQ-09`, `RQ-10`, `RQ-20`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify recovery for a large upload.

**Before you start.** A 45-60 minute session is saved and upload begins.

**Use.** 45-60 minute recording; interrupt transfer around 50%.

**Do this**

1. Start upload.
2. Disable connectivity mid-transfer.
3. Keep offline for several minutes.
4. Restore connectivity.
5. Wait for completion and processing.

**You should see**

Progress recovers or restarts according to the documented strategy. The user does not need to
re-record.

**Check before you call it passed**

Compare local/server size, checksum if available, duration, beginning/end markers, object
count, and processing count.

**Passed if.** The large file completes without corruption, duplication, or permanent Uploading state.

> ⚠️ Depends on undecided requirement(s) `RQ-09`, `RQ-20` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Chunked resume as NET-004, at maximum size. Verify no leftover `_tmp/` parts and a byte-
> exact final object.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-LONG-005 · Phone locks or mobile app remains in background during a long recording

> ⏸ **Deferred — mobile app is not in scope for this run.**
>
> Phone lock and app backgrounding during a long recording. The recorder records standalone over Wi-Fi, so nothing here applies to the in-scope path.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Mobile Lifecycle / Performance · `RQ-10`, `RQ-19`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify supported long-running behavior under normal phone use.

**Before you start.** Mobile-app/BLЕ recording path is active; OS permissions are granted.

**Use.** 45-minute session; lock phone for at least 20 minutes.

**Do this**

1. Start recording through the mobile/BLE workflow.
2. Lock phone or background app.
3. Continue the session.
4. Unlock/open app.
5. Stop, sync, and review.

**You should see**

Recording/status tracking continues according to the supported design. The app clearly reports
any disconnect and recovery.

**Check before you call it passed**

Check BLE logs, audio markers before/during/after lock, duration, session count, and upload
result.

**Passed if.** No silent gap, overwrite, crash, or false Completed state occurs.

> **Server side.**
>
> Recorder-side this is unaffected by the phone. If the take is BLE-bridged, the phone must
> keep streaming — check for truncation at the moment of lock.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-LONG-006 · Battery, temperature, memory, storage, and processing-time observation

> ✂️ **Reduced scope.** Recorder battery, temperature, storage and backend processing time. Skip phone metrics.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P1 · Performance / Reliability · `RQ-20`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Establish operational resource use for extended sessions.

**Before you start.** Monitoring tools/logs are available; devices begin at known battery levels.

**Use.** 45-60 minute recording plus upload and processing.

**Do this**

1. Record baseline battery, free storage, memory, and temperature.
2. Run a long session.
3. Record metrics during capture, upload, and processing.
4. Note crashes, throttling, or UI lag.

**You should see**

Device/app remains usable and provides warnings before resource exhaustion.

**Check before you call it passed**

Record battery drain, temperature, memory, storage growth, upload time, processing time, and
error logs.

**Passed if.** Measured resource use stays within approved limits; no crash, unsafe heating, or unbounded job execution occurs.

> ⚠️ Depends on undecided requirement(s) `RQ-20` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Observation only. Useful server-side numbers: `processing_started_at` → `processed_at` gives
> true processing time; `attempts` shows retry churn. `sate infra` probes every tier (auth,
> DB, device-api + the v15 verify route, Storage, CF worker, AI-queue state, device
> heartbeat).

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

---

## BLE and Device Connectivity

### SATE-BLE-001 · First-time BLE pairing and device assignment

> ⏸ **Deferred — pendant / BLE is not in scope for this run.**
>
> Not part of the current pass. Parked, not deleted.

🧑 **End-user test** · run by **Tester** · P0 · Functional / Compatibility · `RQ-17`, `RQ-19`

*Needs:* Recorder · phone · browser

**Goal.** Verify secure and understandable initial pairing.

**Before you start.** Bluetooth is enabled; app permissions are granted; accessory is unpaired and discoverable.

**Use.** One target BLE device and one test user.

**Do this**

1. Open device setup.
2. Scan for devices.
3. Select the target device.
4. Complete pairing.
5. Confirm device identity and run a short recording/sync.

**You should see**

Only relevant devices are shown with distinguishable identifiers. Successful pairing and
assigned user/device are clearly displayed.

**Check before you call it passed**

Compare displayed identifier, physical device identifier, account assignment, and session
metadata.

**Passed if.** Correct device pairs to the correct account and can complete a session without manual database correction.

> **Server side.**
>
> Pairing is app-side. Server-side, confirm the device row exists and is bound to the right
> account: `select id, serial, user_id, fw, online, last_seen from sate_devices`.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-BLE-002 · Automatic reconnect after mobile app restart

> ⏸ **Deferred — pendant / BLE is not in scope for this run.**
>
> Not part of the current pass. Parked, not deleted.

🧑 **End-user test** · run by **Tester** · P1 · Recovery · `RQ-19`

*Needs:* Recorder · phone · browser

**Goal.** Verify reconnection without unnecessary re-pairing.

**Before you start.** Accessory was previously paired and is powered on nearby.

**Use.** Previously paired device.

**Do this**

1. Connect to the BLE device.
2. Close and restart the app.
3. Observe reconnection.
4. Run a short session.

**You should see**

The app reconnects automatically or provides a clear one-tap reconnect. It does not pair to a
different nearby device.

**Check before you call it passed**

Verify device ID before/after restart and session metadata.

**Passed if.** Reconnection is reliable and preserves device identity.

> **Server side.**
>
> No server involvement. Known pendants persist in AsyncStorage and reconnect by BLE id. Note:
> a notification gap while connected is **normal** — the pendant sleeps in silence (nap mode)
> — and must not be reported as a disconnect.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-BLE-003 · User selects the wrong BLE device

> ⏸ **Deferred — pendant / BLE is not in scope for this run.**
>
> Not part of the current pass. Parked, not deleted.

🧑 **End-user test** · run by **Tester** · P1 · Negative / Usability · `RQ-17`, `RQ-19`

*Needs:* Recorder · phone · browser

**Goal.** Verify device identification and correction when multiple devices are present.

**Before you start.** Two discoverable devices are nearby and clearly labeled for testing.

**Use.** BLE Device A assigned to User A; BLE Device B assigned to User B.

**Do this**

1. Scan for devices.
2. Intentionally select the wrong device.
3. Observe warnings/identity display.
4. Cancel or correct the selection.
5. Pair the correct device.

**You should see**

The app shows enough identifying information to avoid confusion and allows correction. If
assignment rules prohibit the wrong device, pairing is blocked.

**Check before you call it passed**

Check device-user mapping and absence of unintended records.

**Passed if.** The wrong device cannot be silently associated with the user.

> **Server side.**
>
> Wrong-device selection must not re-bind anything. For a **Plaud** device this is critical:
> if `bindingOwner(sn)` is set and differs from this account, the app must REFUSE to connect.
> A mis-bound Plaud is permanently locked, unlike a recoverable SATE recorder.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-BLE-004 · Multiple nearby BLE devices during discovery and reconnect

> ⏸ **Deferred — pendant / BLE is not in scope for this run.**
>
> Not part of the current pass. Parked, not deleted.

🧑 **End-user test** · run by **Tester** · P1 · Compatibility / Reliability · `RQ-19`

*Needs:* Recorder · phone · browser

**Goal.** Verify stable discovery, selection, and reconnect in a crowded environment.

**Before you start.** At least three discoverable BLE devices are nearby.

**Use.** Multiple accessories with unique identifiers.

**Do this**

1. Scan repeatedly.
2. Move devices in/out of range.
3. Select the intended device.
4. Restart app and verify reconnect.

**You should see**

Device list remains usable, identifiers do not swap, and the intended device reconnects.

**Check before you call it passed**

Compare scan list, selected ID, connected ID, and session metadata.

**Passed if.** No unintended device switch or duplicate device record occurs.

> **Server side.**
>
> Scan with **no service filter** and match on `name` OR `localName` OR the advertised audio
> service — the pendant's name is only in the scan response, so iOS surfaces it as `localName`
> and `name` may be a stale cached GAP name from older firmware.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-BLE-005 · BLE device is already connected to another phone

> ⏸ **Deferred — pendant / BLE is not in scope for this run.**
>
> Not part of the current pass. Parked, not deleted.

🧑 **End-user test** · run by **Tester** · P1 · Negative / Recovery · `RQ-19`

*Needs:* Recorder · phone · browser

**Goal.** Verify clear handling of exclusive BLE connection conflicts.

**Before you start.** Target device is connected to Phone A; tester uses Phone B.

**Use.** Two supported phones and one BLE accessory.

**Do this**

1. Connect device to Phone A.
2. Attempt connection from Phone B.
3. Disconnect Phone A.
4. Retry from Phone B.

**You should see**

Phone B receives a clear unavailable/in-use message and later connects successfully after
release.

**Check before you call it passed**

Verify connection logs, device mapping, and successful later session.

**Passed if.** Connection conflict is understandable and recoverable without reset or data corruption.

> **Server side.**
>
> Only one central may hold the link. Expect a clean refusal, not a re-bind.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-BLE-006 · Bluetooth disabled or permission revoked

> ⏸ **Deferred — pendant / BLE is not in scope for this run.**
>
> Not part of the current pass. Parked, not deleted.

🧑 **End-user test** · run by **Tester** · P0 · Negative / Permissions · `RQ-19`

*Needs:* Recorder · phone · browser

**Goal.** Verify actionable handling of unavailable Bluetooth access.

**Before you start.** App is installed; tester can disable Bluetooth and revoke permissions.

**Use.** Supported Android and iOS devices.

**Do this**

1. Disable Bluetooth and open the workflow.
2. Observe message.
3. Enable Bluetooth but revoke app permission.
4. Retry.
5. Restore permission and connect.

**You should see**

The app identifies the exact issue and directs the user to restore access. It must not show a
false connected state.

**Check before you call it passed**

Check app state, device state, pending queue, and later successful connection.

**Passed if.** Bluetooth and permission failures are explicit, safe, and recoverable.

> **Server side.**
>
> Permission loss must be reported, not silently retried. Note SATE and Pendant **share one
> `BleManager`**; a screen taking the radio must `stopScan()` only and never destroy it.
> Destroying and recreating leaves the iOS BLE stack returning zero devices with no error.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-BLE-007 · BLE disconnects during recording and later reconnects

> ⏸ **Deferred — pendant / BLE is not in scope for this run.**
>
> Not part of the current pass. Parked, not deleted.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Recovery / Data Integrity · `RQ-04`, `RQ-06`, `RQ-19`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify recording continuity or explicit interruption when BLE is lost.

**Before you start.** BLE recording workflow is active.

**Use.** 10-minute session; move accessory out of range for one minute.

**Do this**

1. Start recording.
2. Break BLE connection.
3. Continue waiting for one minute.
4. Return device to range.
5. Observe reconnect.
6. Stop and sync.

**You should see**

The app shows disconnect/reconnect status. It does not silently display continuous Recording
if capture stopped.

**Check before you call it passed**

Inspect audio around disconnect, BLE event log, duration, session count, and transcript
continuity.

**Passed if.** Connection loss is detected and the final session accurately represents whether data were continuous or interrupted.

> ⚠️ Depends on undecided requirement(s) `RQ-06` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> A BLE drop during a bridged take is a truncation risk. Server-side, compare stored `bytes`
> against the expected duration — a short object with a `done` status is the failure.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-BLE-008 · BLE accessory battery is depleted during recording

> ⏸ **Deferred — pendant / BLE is not in scope for this run.**
>
> Not part of the current pass. Parked, not deleted.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Recovery / Hardware · `RQ-06`, `RQ-20`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify low-battery warning and safe session handling.

**Before you start.** Accessory begins near low-battery threshold.

**Use.** Record until device powers down.

**Do this**

1. Start recording.
2. Observe battery indicator/warning.
3. Continue until disconnect/power loss.
4. Recharge and reconnect.
5. Inspect and sync the session.

**You should see**

Low-battery warning appears when supported. Disconnect is explicit and recovery guidance is
shown.

**Check before you call it passed**

Check audio/event boundary, device battery log, duration, session status, and duplicate count.

**Passed if.** Battery depletion does not silently lose or misrepresent the session.

> ⚠️ Depends on undecided requirement(s) `RQ-06`, `RQ-20` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Same truncation check. Confirm whatever was captured is preserved rather than discarded.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

---

## Mobile App Lifecycle and Authentication

### SATE-APP-001 · App moves to background during an active recording

> ⏸ **Deferred — mobile app is not in scope for this run.**
>
> Not part of the current pass. Parked, not deleted.

🧑 **End-user test** · run by **Tester** · P0 · Mobile Lifecycle · `RQ-10`, `RQ-19`

*Needs:* Recorder · phone · browser

**Goal.** Verify supported background behavior during capture.

**Before you start.** Recording is active and background permissions are configured.

**Use.** 5-minute BLE/mobile session.

**Do this**

1. Start recording.
2. Send app to background for two minutes.
3. Use another app.
4. Return to SATE.
5. Stop and sync.

**You should see**

Recording/status remains correct or the app clearly reports interruption. UI state is restored
accurately.

**Check before you call it passed**

Check audio continuity, app lifecycle logs, duration, and session count.

**Passed if.** No silent interruption, duplicate recording, or false status occurs.

> **Server side.**
>
> No server involvement for a recorder-driven take. For BLE-bridged capture, check for a gap
> at the moment of backgrounding.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-APP-002 · App is force-closed during recording

> ⏸ **Deferred — mobile app is not in scope for this run.**
>
> Not part of the current pass. Parked, not deleted.

🧑 **End-user test** · run by **Tester** · P0 · Recovery / Fault Injection · `RQ-04`, `RQ-06`

*Needs:* Recorder · phone · browser

**Goal.** Verify crash recovery and accurate interrupted-session handling.

**Before you start.** Recording is active.

**Use.** 5-minute session; force-close after two minutes.

**Do this**

1. Start recording.
2. Force-close the app.
3. Reopen the app.
4. Inspect recovered session/status.
5. Sync any recoverable data.

**You should see**

The app reports interruption/recovery and does not pretend the session completed normally.

**Check before you call it passed**

Check local files, audio duration, session ID, error log, and backend count.

**Passed if.** Captured data are handled according to the documented recovery rule with no silent loss or false completion.

> ⚠️ Depends on undecided requirement(s) `RQ-06` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> The recorder is the source of truth; a force-closed app must not lose the take. Verify the
> session still arrives.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-APP-003 · App is force-closed during upload

> ⏸ **Deferred — mobile app is not in scope for this run.**
>
> Not part of the current pass. Parked, not deleted.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Recovery · `RQ-08`, `RQ-09`, `RQ-10`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify pending upload persistence after process termination.

**Before you start.** Session upload is in progress.

**Use.** 10-minute session.

**Do this**

1. Start upload.
2. Force-close the app mid-transfer.
3. Reopen the app.
4. Observe queue recovery.
5. Wait for completion.

**You should see**

Pending session reappears and resumes/retries. It does not remain permanently Uploading.

**Check before you call it passed**

Check queue persistence, file completeness, session/object/job counts, and final status.

**Passed if.** Upload recovers without duplication, corruption, or user re-recording.

> ⚠️ Depends on undecided requirement(s) `RQ-09` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Interrupted upload → chunked resume. Check for orphan `_tmp/` parts left behind.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-APP-004 · Phone restarts during upload

> ⏸ **Deferred — mobile app is not in scope for this run.**
>
> Not part of the current pass. Parked, not deleted.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Recovery · `RQ-08`, `RQ-10`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify durable queue state across full phone reboot.

**Before you start.** Upload is active; phone can be restarted.

**Use.** 10-minute session.

**Do this**

1. Start upload.
2. Restart the phone.
3. Unlock and reopen SATE.
4. Restore network if needed.
5. Observe completion.

**You should see**

The pending session is restored and clearly shown.

**Check before you call it passed**

Compare session ID and queue state before/after reboot; validate file and final record counts.

**Passed if.** Phone reboot does not lose, duplicate, or mis-associate the session.

> **Server side.**
>
> Same as APP-003 with a longer gap. The row should either not exist yet or be complete —
> never a row with `storage_path` pointing at nothing.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-APP-005 · Authentication token expires during upload or processing

> ⏸ **Deferred — mobile app is not in scope for this run.**
>
> Not part of the current pass. Parked, not deleted.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Security / Recovery · `RQ-10`, `RQ-17`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify safe token refresh or reauthentication without losing the session.

**Before you start.** Use a short-lived token or simulate expiration.

**Use.** 5-minute session.

**Do this**

1. Start upload.
2. Expire/revoke the access token.
3. Observe app behavior.
4. Reauthenticate if prompted.
5. Confirm final completion.

**You should see**

The app prompts appropriately or refreshes the token securely. It does not assign data to a
different account.

**Check before you call it passed**

Check auth logs, user ID, session ID, request count, and final data ownership.

**Passed if.** Token expiry causes no data loss, unauthorized access, duplicate session, or account mis-association.

> **Server side.**
>
> ⚠️ **Read this before testing.** `device-api` and `mint-plaud-token` are deployed
> `verify_jwt:false` and validate the token themselves. If this case fails with "Setup link
> expired" or a blanket 401, first confirm nobody redeployed them with the MCP/CLI default
> `verify_jwt:true` — that breaks registration and token minting system-wide and looks exactly
> like an auth-expiry bug. The recorder path uses a device key (`Bearer key-…`), not a JWT, so
> it is unaffected by user token expiry — a session already on the device will still upload.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-APP-006 · User logs out while sessions are pending upload

> ⏸ **Deferred — mobile app is not in scope for this run.**
>
> Not part of the current pass. Parked, not deleted.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Security / Product Rule · `RQ-17`, `RQ-22`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify the documented logout policy for unsynced clinical data.

**Before you start.** At least one local pending session exists.

**Use.** One pending session for User A.

**Do this**

1. Attempt logout.
2. Observe warning/blocking behavior.
3. Follow the provided option: cancel, sync first, or secure local retention.
4. Log back in as User A and verify the session.

**You should see**

The app clearly warns about pending data and follows the approved policy. It must not silently
discard the session.

**Check before you call it passed**

Check queue ownership, local retention, later upload, and absence of cross-account records.

**Passed if.** Logout cannot cause silent loss or cross-user upload of pending data.

> **Server side.**
>
> Pending local sessions belong to the account that recorded them (RQ-22, unsettled). Verify
> nothing uploads under the new session's identity.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-APP-007 · Different user logs in while prior user's session remains pending

> ⏸ **Deferred — mobile app is not in scope for this run.**
>
> Not part of the current pass. Parked, not deleted.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Security / Data Isolation · `RQ-17`, `RQ-22`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify strict ownership of locally queued sessions.

**Before you start.** User A has a pending local session; User A logs out according to allowed workflow.

**Use.** User A and User B test accounts.

**Do this**

1. Create pending session as User A.
2. Log out.
3. Log in as User B.
4. Inspect queue/session list.
5. Restore User A and complete upload.

**You should see**

User B cannot view, play, edit, export, or upload User A's pending session.

**Check before you call it passed**

Check local access controls, user IDs, session ownership, and final upload ownership.

**Passed if.** No cross-user visibility or upload occurs.

> **Server side.**
>
> The isolation case. After the switch, a pending take must not land under User B's `user_id`.
> Check `sate_device_sessions.user_id` on whatever eventually uploads.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-APP-008 · App update or reinstall when unsynced sessions exist

> ⏸ **Deferred — mobile app is not in scope for this run.**
>
> Not part of the current pass. Parked, not deleted.

🧑 **End-user test** · run by **Tester** · P1 · Recovery / Compatibility · `RQ-04`, `RQ-19`, `RQ-22`

*Needs:* Recorder · phone · browser

**Goal.** Verify upgrade behavior and documented reinstall limitations.

**Before you start.** Pending local sessions exist; an update build is available.

**Use.** Two pending sessions.

**Do this**

1. Create pending sessions.
2. Upgrade the app without uninstalling.
3. Verify queue and upload.
4. Separately test uninstall/reinstall according to approved procedure.
5. Verify warnings and retained/lost data behavior.

**You should see**

Normal app update preserves sessions. Before uninstall, the app/system provides an appropriate
warning if local data will be removed.

**Check before you call it passed**

Compare queue/session IDs before and after update; document reinstall behavior and final
backend records.

**Passed if.** Supported updates preserve data; unsupported destructive actions are clearly warned and do not create false sync states.

> **Server side.**
>
> Reinstall loses AsyncStorage but **not** the iOS Keychain — Plaud bindings live in
> `plaud.bind.<sn>` with `AfterFirstUnlock` specifically so they survive uninstall. Reinstall
> must reconnect, never re-bind.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

---

## Backend, Retry, and AI Processing

### SATE-BE-001 · Standard backend status progression and result persistence

🖥 **Server-side test** · run by **Engineer** · P0 · Integration / Functional · `RQ-01`, `RQ-02`, `RQ-20`

*Needs:* Supabase SQL + Storage · cf-processor logs

*What the end user does:* Supply one normal recording; the rest is queue observation.

**Goal.** Verify normal service-to-service orchestration.

**Before you start.** A valid uploaded audio session exists; all services are healthy.

**Use.** One 5-minute audio session.

**Do this**

1. Submit the session for processing.
2. Trace status and request IDs across services.
3. Wait for result.
4. Refresh Web App.

**You should see**

Web App progresses through Processing to Completed and shows the result once.

**Check before you call it passed**

Check timestamps, request IDs, attempt count, status history, JSON schema, and session-result
linkage.

**Passed if.** One complete result is stored and exposed with no missing, duplicate, or out-of-order terminal state.

> ⚠️ Depends on undecided requirement(s) `RQ-20` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> The reference case for the state machine. `queued → processing → done`, with
> `processing_started_at`, `worker_id`, `heartbeat_at` stamped on claim. New rows default to
> `queued` (a column default, so `device-api` needs no change to enqueue).

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-BE-002 · AI service returns 500 once, then succeeds

🖥 **Server-side test** · run by **Engineer** · P0 · Retry / Integration · `RQ-11`

*Needs:* Supabase SQL + Storage · cf-processor logs · AI fault injection — force a single 500

*What the end user does:* Supply one normal recording.

**Goal.** Verify retry on a transient 5xx error.

**Before you start.** Fault injection can return 500 on the first AI attempt and success on the second.

**Use.** Valid audio session.

**Do this**

1. Submit processing.
2. Return 500 on attempt 1.
3. Return a valid result on attempt 2.
4. Inspect attempt logs and final session.

**You should see**

Web App may remain Processing or show a non-terminal retry message, then reaches Completed.

**Check before you call it passed**

Verify retry count, backoff timing, request/session IDs, single final result, and no duplicate
report.

**Passed if.** Transient 5xx is retried according to policy and the session completes once.

> ⚠️ Depends on undecided requirement(s) `RQ-11` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> A 5xx is classified transient → `requeue_session` with backoff → `attempts` becomes 2 → next
> claim succeeds → `done`. Confirm exactly one `recordings` row, not two.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-BE-003 · AI service returns 5xx on all three allowed attempts

🖥 **Server-side test** · run by **Engineer** · P0 · Retry / Negative · `RQ-11`, `RQ-13`

*Needs:* Supabase SQL + Storage · cf-processor logs · AI fault injection — force 5xx on every attempt

*What the end user does:* Supply one normal recording.

**Goal.** Verify maximum retry count and final failure handling.

**Before you start.** Fault injection returns 5xx for every attempt.

**Use.** Valid audio session.

**Do this**

1. Submit processing.
2. Return 5xx three times.
3. Observe retry timing.
4. Inspect final status.
5. Use manual reprocess if supported.

**You should see**

After the allowed attempts, the session shows a clear Failed/Retry Available state rather than
indefinite Processing.

**Check before you call it passed**

Verify exactly three automatic attempts, terminal status, retained audio, no result
duplication, and manual retry behavior if enabled.

**Passed if.** Retry limit is enforced and the session remains recoverable without data loss.

> ⚠️ Depends on undecided requirement(s) `RQ-11`, `RQ-13` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> `MAX_ATTEMPTS` is 3. After the third the session settles `error` with `process_error` set.
> It must NOT loop. The status worker (`sate-status`, 5-minute cron) emails the operator
> **once** for a settled error, since it cannot auto-clear; only active conditions re-remind,
> at most every 24 h.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-BE-004 · AI service returns a non-retryable 4xx error

🖥 **Server-side test** · run by **Engineer** · P0 · Negative / Retry Policy · `RQ-12`, `RQ-13`

*Needs:* Supabase SQL + Storage · cf-processor logs · AI fault injection — force a 4xx

*What the end user does:* Supply one normal recording.

**Goal.** Verify that client/data errors are not blindly retried as transient failures.

**Before you start.** Fault injection can return a representative 4xx response.

**Use.** Valid or intentionally invalid request.

**Do this**

1. Submit processing.
2. Return the selected 4xx response.
3. Observe attempts and final status.
4. Correct the issue if possible and manually reprocess.

**You should see**

The UI shows a clear processing failure or action required.

**Check before you call it passed**

Verify attempt count, error classification, retained audio, and absence of duplicate jobs.

**Passed if.** Non-retryable errors are classified correctly and do not consume three unnecessary attempts.

> ⚠️ Depends on undecided requirement(s) `RQ-12`, `RQ-13` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> 4xx is permanent → `fail_session` immediately, no retry. `attempts` should not climb.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-BE-005 · AI request times out, then succeeds

🖥 **Server-side test** · run by **Engineer** · P0 · Timeout / Retry · `RQ-11`, `RQ-20`

*Needs:* Supabase SQL + Storage · cf-processor logs · AI fault injection — force a timeout

*What the end user does:* Supply one normal recording.

**Goal.** Verify timeout detection, retry, and idempotent completion.

**Before you start.** First AI attempt is delayed beyond the configured timeout; second returns normally.

**Use.** Valid audio session.

**Do this**

1. Submit processing.
2. Delay response past timeout.
3. Allow retry.
4. Return a valid result.
5. Inspect late response handling.

**You should see**

Session eventually reaches Completed without showing two results.

**Check before you call it passed**

Verify attempt count, timeout duration, late-response disposition, result count, and final
status.

**Passed if.** Timeout recovery yields one correct result and no duplicate or conflicting terminal state.

> ⚠️ Depends on undecided requirement(s) `RQ-11`, `RQ-20` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Timeout is transient. Note `AI_READ_TIMEOUT_S` = 3600 s — the container holds a long call
> rather than timing out early; it will not hang forever on an up-but-dead AI.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-BE-006 · AI returns malformed JSON

🖥 **Server-side test** · run by **Engineer** · P0 · Schema Validation / Negative · `RQ-14`

*Needs:* Supabase SQL + Storage · cf-processor logs · AI fault injection — return malformed JSON

*What the end user does:* Supply one normal recording.

**Goal.** Verify validation before storing or displaying AI output.

**Before you start.** AI response can be replaced with invalid JSON.

**Use.** Valid audio session.

**Do this**

1. Submit processing.
2. Return malformed JSON.
3. Observe backend and Web App.
4. Inspect stored data and logs.

**You should see**

Web App shows a controlled processing error, not a broken page or raw stack trace.

**Check before you call it passed**

Verify JSON parsing failure, terminal/retryable status, retained audio, safe logs, and absence
of partial corrupt data.

**Passed if.** Invalid JSON cannot create a Completed session or break the Web App.

> **Server side.**
>
> Non-JSON body → `Permanent("AI returned a non-JSON body")`. No retry, no partial
> `recordings` row.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-BE-007 · AI returns valid JSON with missing or partial required fields

🖥 **Server-side test** · run by **Engineer** · P0 · Schema Validation / Partial Result · `RQ-14`

*Needs:* Supabase SQL + Storage · cf-processor logs · AI fault injection — return JSON missing required fields

*What the end user does:* Supply one normal recording.

**Goal.** Verify documented handling of partial AI output.

**Before you start.** AI response can omit transcript, annotation, confidence, or metadata fields.

**Use.** Several controlled partial-response variants.

**Do this**

1. Submit each variant.
2. Review validation and status.
3. Open the session in Web App.
4. Attempt report export.

**You should see**

UI shows available data and an explicit Partial/Failed state according to requirement. Missing
fields do not crash the page.

**Check before you call it passed**

Check schema, status, report behavior, field defaults, and absence of fabricated values.

**Passed if.** Partial output is handled consistently and never misrepresented as a complete valid report.

> **Server side.**
>
> Missing `segments` → `Permanent("AI returned no segments")`. Partial-field handling is RQ-14
> and still unsettled — record what the pipeline does rather than asserting.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-BE-008 · Duplicate AI callback or duplicate result submission

🖥 **Server-side test** · run by **Engineer** · P0 · Idempotency / Integration · `RQ-03`, `RQ-14`

*Needs:* Supabase SQL + Storage · cf-processor logs · Ability to replay a result callback

*What the end user does:* Supply one normal recording.

**Goal.** Verify safe handling of repeated identical results.

**Before you start.** A valid AI result can be submitted twice for the same attempt/session.

**Use.** One completed processing result delivered twice.

**Do this**

1. Process a session normally.
2. Replay the same callback/result.
3. Refresh the Web App and inspect database.

**You should see**

The user still sees one result and one report version unless versioning explicitly records
duplicates as audit events.

**Check before you call it passed**

Count result rows, annotations, report records, status history, and visible sessions.

**Passed if.** Duplicate callbacks do not duplicate user-visible data or overwrite a newer valid result.

> **Server side.**
>
> ⚠️ **The dangerous one.** `process-device-session` must be a **200 no-op** in production;
> `device-api` still fire-and-forgets to it, but if it actually processes, it races the
> container and duplicates recordings. **The copy checked into this repo is NOT the no-op** —
> it still downloads the WAV, awaits the AI, and inserts `recordings`, filtering on
> `processed=false` while the container claims on `status`, so both would process the same
> session. Production is deployed as the no-op. **Do not deploy the repo file as-is.** If you
> see duplicate recordings in this case, check what is actually deployed before filing
> anything.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-BE-009 · Out-of-order status updates or late responses

🖥 **Server-side test** · run by **Engineer** · P0 · Concurrency / State Machine · `RQ-01`, `RQ-02`

*Needs:* Supabase SQL + Storage · cf-processor logs

*What the end user does:* Supply one normal recording.

**Goal.** Verify that stale events cannot regress a completed session.

**Before you start.** Test harness can deliver Processing, Failed, and Completed events out of order.

**Use.** One session with controlled event ordering.

**Do this**

1. Send Completed result.
2. Send a delayed Processing or Failed event from an older attempt.
3. Refresh Web App.
4. Inspect status history.

**You should see**

Completed session remains Completed unless a newer authorized operation changes it.

**Check before you call it passed**

Verify final status, event order, attempt IDs, version numbers, and unchanged result.

**Passed if.** Older events cannot overwrite or regress a newer valid terminal state.

> **Server side.**
>
> Late/out-of-order updates. The container heartbeats during a long job so the watchdog cannot
> steal work still running; `requeue_stale_sessions` only reclaims rows whose
> `heartbeat_at`/`started_at` is older than `STUCK_MINUTES` (90). A late response arriving for
> an already-requeued session must not resurrect it.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-BE-010 · Cloudflare or Edge Function is temporarily unavailable

🖥 **Server-side test** · run by **Engineer** · P0 · Service Outage / Recovery · `RQ-11`, `RQ-13`, `RQ-20`

*Needs:* Supabase SQL + Storage · cf-processor logs · Ability to stop/start the Worker or edge function

*What the end user does:* Supply one normal recording, then confirm the app/web behaviour during the outage.

**Goal.** Verify durable processing requests during an intermediary outage.

**Before you start.** Audio is uploaded; Cloudflare or Edge Function can be made unavailable.

**Use.** Valid session; temporary outage followed by recovery.

**Do this**

1. Start processing.
2. Make the intermediary unavailable.
3. Observe status/retries.
4. Restore service.
5. Verify completion.

**You should see**

Web App shows Processing/Retrying/Failed with clear recovery path, not a blank result.

**Check before you call it passed**

Check request attempts, retained audio, status transitions, result count, and recovery time.

**Passed if.** Temporary service outage does not lose audio, duplicate sessions, or leave an unrecoverable state.

> ⚠️ Depends on undecided requirement(s) `RQ-11`, `RQ-13`, `RQ-20` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Edge/Worker unavailability must be transient. Reminder for whoever fixes this: the AI call
> **must never** move back into an edge function or a plain Worker — Supabase edge has a hard
> ~150 s wall-clock and a Worker a ~100 s origin timeout, and both kill the request mid-fetch
> *before* any catch block, so `process_error` is never written and the session hangs in
> `processing` forever. A 32-minute take once showed 70 minutes stuck.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-BE-011 · Audio upload succeeds but database/session update fails

🖥 **Server-side test** · run by **Engineer** · P0 · Consistency / Recovery · `RQ-02`, `RQ-03`, `RQ-04`

*Needs:* Supabase SQL + Storage · cf-processor logs · Ability to fail the database write after a successful upload

*What the end user does:* Supply one normal recording.

**Goal.** Verify reconciliation of storage and database partial success.

**Before you start.** Fault injection allows object upload but fails the subsequent database write.

**Use.** One 5-minute audio upload.

**Do this**

1. Upload the audio object.
2. Fail the session/status database write.
3. Restore database service.
4. Run automatic reconciliation or retry.
5. Inspect storage and DB.

**You should see**

User sees a retryable sync state and does not see an unusable ghost session.

**Check before you call it passed**

Check storage object count/path, DB rows, session ID, reconciliation logs, and final result.

**Passed if.** Partial success is repaired without orphaned clinical data, duplicate object, or wrong session linkage.

> **Server side.**
>
> Upload succeeded, DB update failed — the exact shape that produced ghost rows. There must be
> no session marked synced without a matching object. `GET /api/sessions/verify` is the guard:
> it answers `stored:true` only when the row exists AND `objectExists`. It must stay read-
> only; never make it mutate.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-BE-012 · Manual reprocess after final processing failure

🖥 **Server-side test** · run by **Engineer** · P0 · Recovery / Functional · `RQ-13`

*Needs:* Supabase SQL + Storage · cf-processor logs

*What the end user does:* Confirm the retry control appears and works in the UI after the engineer forces the failure.

**Goal.** Verify authorized reprocessing uses the original audio and session.

**Before you start.** A session is in Failed Final state with retained valid audio.

**Use.** One failed session; authorized user.

**Do this**

1. Open failed session.
2. Select Reprocess/Retry.
3. Confirm action if required.
4. Allow successful AI response.
5. Review result and audit history.

**You should see**

User sees one session transition back to Processing and then Completed. Previous failure
remains traceable.

**Check before you call it passed**

Verify session ID unchanged, attempt incremented, audio object unchanged, result
version/audit, and no duplicate session.

**Passed if.** Manual reprocess successfully recovers the session without re-uploading or duplicating it.

> ⚠️ Depends on undecided requirement(s) `RQ-13` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> `POST /sessions/:id/retry` (device-api ≥v14) re-queues an `error` session. It accepts
> **only** `error` — to re-run anything else (an orphaned `processing` row, say) an owner must
> PATCH the row to `queued` via PostgREST. Note a new container image does not instantly swap
> the running singleton: an in-flight claim is killed and orphaned in `processing` until the
> 90-minute watchdog.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

---

## Web Transcript Review

### SATE-WEB-001 · Open and review a completed transcript

🧑 **End-user test** · run by **Tester** · P0 · Functional · `RQ-15`, `RQ-17`

*Needs:* Recorder · phone · browser

**Goal.** Verify normal transcript review and session metadata display.

**Before you start.** A completed session exists and the user has access.

**Use.** Standard 5-minute completed session.

**Do this**

1. Log in.
2. Open session list.
3. Select the session.
4. Review metadata, audio, transcript, and annotations.
5. Refresh the page.

**You should see**

Content loads completely; labels are understandable; refresh retains the same session and
data.

**Check before you call it passed**

Compare displayed user, session ID, date, duration, transcript, annotations, and audio.

**Passed if.** The correct complete session is reviewable without missing, stale, or mismatched content.

> ⚠️ Depends on undecided requirement(s) `RQ-15` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> The web report reads `recordings.transcript` and `recordings.analysis`. Flag markers
> (`recordings.flags`) render as seek-bar ticks — one shared pipeline for the recorder's
> physical flag button and Plaud's device tap. Don't fork a parallel path.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-WEB-002 · Display of Processing, Retryable Failure, and Final Failure states

🧑 **End-user test** · run by **Tester** · P0 · State Handling / Usability · `RQ-01`, `RQ-13`, `RQ-14`

*Needs:* Recorder · phone · browser

**Goal.** Verify clear non-completed session states.

**Before you start.** Create sessions in Processing, Retryable Failure, and Final Failure.

**Use.** Three controlled sessions.

**Do this**

1. Open each session.
2. Observe messages and available actions.
3. Refresh after status changes.

**You should see**

Each state has a distinct explanation and only appropriate actions. No page appears empty or
permanently loading without context.

**Check before you call it passed**

Compare UI status to DB status, attempt count, and available retry permissions.

**Passed if.** Users can distinguish processing from failure and know whether to wait or retry.

> ⚠️ Depends on undecided requirement(s) `RQ-13` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> UI must distinguish `processing`, retryable `error` (attempts < 3), and settled `error`. The
> status column to read is `sate_device_sessions.status` plus `attempts` — the UI shows real
> progress from these rather than inferring from `processed` (device-api ≥v14).

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-WEB-003 · Refresh, browser Back/Forward, and multiple tabs

🧑 **End-user test** · run by **Tester** · P1 · Reliability / Navigation · `RQ-15`

*Needs:* Recorder · phone · browser

**Goal.** Verify session context is not mixed across navigation actions.

**Before you start.** Two completed sessions A and B exist.

**Use.** Open A and B in separate tabs.

**Do this**

1. Open Session A.
2. Open Session B in another tab.
3. Refresh both.
4. Use Back and Forward.
5. Compare displayed content.

**You should see**

Each tab retains its own session. Navigation never shows Session A metadata with Session B
transcript/audio.

**Check before you call it passed**

Compare URL/session ID, metadata, transcript marker, audio marker, and report link in each
tab.

**Passed if.** No cross-session content mixing or stale-cache substitution occurs.

> ⚠️ Depends on undecided requirement(s) `RQ-15` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> No server involvement. Client-state only.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-WEB-004 · Audio playback and transcript association

🧑 **End-user test** · run by **Tester** · P0 · Data Integrity / Functional · `RQ-04`, `RQ-15`

*Needs:* Recorder · phone · browser

**Goal.** Verify that the audio player is linked to the correct session and remains usable.

**Before you start.** Completed sessions A and B contain distinct spoken labels.

**Use.** Two completed sessions.

**Do this**

1. Open Session A and play beginning/end.
2. Open Session B and play beginning/end.
3. Seek, pause, resume, and reload.
4. Compare to transcripts.

**You should see**

Audio controls work and each session plays its own audio. Errors are explained.

**Check before you call it passed**

Match spoken label to transcript/session; verify duration and access controls.

**Passed if.** No wrong-audio association, broken seeking, or unauthorized cross-session playback occurs.

> ⚠️ Depends on undecided requirement(s) `RQ-15` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Audio is served from the `recordings` bucket via `GET /sessions/:id/audio`. Confirm the clip
> matches the transcript — cross-session contamination is a release blocker.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-WEB-005 · Edit and save transcript with versioning

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Functional / Data Integrity · `RQ-15`, `RQ-16`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify transcript correction, persistence, and report source.

**Before you start.** Transcript editing is enabled and user has edit permission.

**Use.** Completed session with known correction points.

**Do this**

1. Edit several transcript segments.
2. Save.
3. Refresh and reopen.
4. Export PDF.
5. Review audit/version information.

**You should see**

Edits persist and are visually distinguishable from unsaved changes. PDF uses the approved
latest version.

**Check before you call it passed**

Compare original and edited versions, last-saved timestamp, editor identity, and PDF content.

**Passed if.** Edits are durable, auditable, and cannot accidentally overwrite the wrong session.

> ⚠️ Depends on undecided requirement(s) `RQ-15` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Editing writes back to `recordings.transcript` and sets `segments_edited`. Versioning policy
> is RQ-15 and unsettled — record current behaviour.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-WEB-006 · Save failure and concurrent transcript editing

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Concurrency / Recovery · `RQ-15`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify no silent data loss during failed or conflicting edits.

**Before you start.** Two authorized browser sessions can open the same transcript; DB failure can be simulated.

**Use.** Session with editable transcript.

**Do this**

1. Open the transcript in two browsers.
2. Make different edits.
3. Save Browser A.
4. Save Browser B or inject save failure.
5. Refresh both.

**You should see**

Save failure is explicit and unsaved text is not falsely shown as saved. Concurrent conflict
follows the documented policy.

**Check before you call it passed**

Inspect versions, timestamps, editor IDs, final text, and error logs.

**Passed if.** No silent overwrite, wrong-session save, or false success occurs.

> ⚠️ Depends on undecided requirement(s) `RQ-15` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Concurrent edit handling is undefined (RQ-15). Expect last-write-wins unless told otherwise;
> document what you observe.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-WEB-007 · Long transcript and special characters

🧑 **End-user test** · run by **Tester** · P1 · Compatibility / Performance · `RQ-15`, `RQ-19`, `RQ-20`

*Needs:* Recorder · phone · browser

**Goal.** Verify rendering of long content, IPA, Unicode, punctuation, and long tokens.

**Before you start.** A long completed/edited transcript containing special characters exists.

**Use.** 45-minute transcript; apostrophes, hyphens, IPA symbols, accented characters, non-Latin Unicode, and long strings.

**Do this**

1. Open the transcript.
2. Search/scroll through the page.
3. Edit and save selected special characters if supported.
4. Refresh.
5. Export PDF.

**You should see**

Page remains responsive; characters render without replacement boxes or corruption; layout
does not overlap.

**Check before you call it passed**

Compare source text, displayed text, saved text, and PDF text for encoding changes.

**Passed if.** Long and multilingual/special-character content remains accurate and usable.

> ⚠️ Depends on undecided requirement(s) `RQ-15`, `RQ-20` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Special characters travel as JSON in `recordings.transcript`. Check for mojibake at the
> storage boundary, not just on screen.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

---

## PDF Export

### SATE-PDF-001 · Standard SATE report export

🧑 **End-user test** · run by **Tester** · P0 · Functional · `RQ-16`, `RQ-17`

*Needs:* Recorder · phone · browser

**Goal.** Verify a complete report can be generated from a completed session.

**Before you start.** Completed session exists and user has export permission.

**Use.** Standard 5-minute session.

**Do this**

1. Open the session.
2. Select Export PDF.
3. Open the file.
4. Compare report fields to the Web App.

**You should see**

Export succeeds once; file opens without warning; layout is readable.

**Check before you call it passed**

Compare user/session metadata, date, duration, transcript, annotations, page count, and file
name.

**Passed if.** PDF is complete, readable, correctly associated, and free of missing or stale content.

> **Server side.**
>
> Export reads the same `recordings` row. Confirm the PDF's session matches the row's `id`.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-PDF-002 · Long-session report pagination

🧑 **End-user test** · run by **Tester** · P0 · Performance / Layout · `RQ-16`, `RQ-20`

*Needs:* Recorder · phone · browser

**Goal.** Verify multi-page report formatting for long transcripts and annotation tables.

**Before you start.** A completed 45-60 minute session exists.

**Use.** Long transcript and large annotation set.

**Do this**

1. Export PDF.
2. Review every page.
3. Check page breaks, headers, footers, tables, and final page.
4. Search for known beginning/end markers.

**You should see**

No clipped text, overlapping elements, blank unintended pages, or missing final content
appears.

**Check before you call it passed**

Confirm all transcript markers, annotation rows, page numbering, metadata, and file size.

**Passed if.** Long report is complete and professionally paginated.

> ⚠️ Depends on undecided requirement(s) `RQ-20` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Pagination is client-side; no server check beyond the source row.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-PDF-003 · Special characters and Unicode in PDF

🧑 **End-user test** · run by **Tester** · P1 · Compatibility / Layout · `RQ-16`, `RQ-19`

*Needs:* Recorder · phone · browser

**Goal.** Verify correct PDF rendering for supported characters.

**Before you start.** Transcript contains the supported special-character test set.

**Use.** IPA, accented Latin, punctuation, speaker labels, symbols, and selected non-Latin text.

**Do this**

1. Export the report.
2. Compare each special-character sample with the Web App/source.
3. Copy text from PDF where applicable.

**You should see**

Characters render correctly without boxes, substitutions, or layout corruption.

**Check before you call it passed**

Compare source/display/PDF characters and text extraction where relevant.

**Passed if.** All supported characters remain legible and accurate.

> **Server side.**
>
> Font coverage is a rendering concern — confirm the stored JSON is correct first, so a glyph
> problem is not mistaken for data loss.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-PDF-004 · Re-export after transcript edits

🧑 **End-user test** · run by **Tester** · P0 · Data Integrity / Cache · `RQ-15`, `RQ-16`

*Needs:* Recorder · phone · browser

**Goal.** Verify that a new report uses the latest saved transcript rather than stale cached content.

**Before you start.** Transcript editing is enabled; a prior PDF has already been generated.

**Use.** One completed session with a known text correction.

**Do this**

1. Export the original PDF.
2. Edit and save transcript.
3. Export again.
4. Compare both files.

**You should see**

Second export contains the saved correction and is clearly the current report.

**Check before you call it passed**

Compare transcript version ID, report generation timestamp, file contents, and file
name/version.

**Passed if.** Re-export never returns a stale report after a successful saved edit.

> ⚠️ Depends on undecided requirement(s) `RQ-15` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Re-export must pick up edited text (`segments_edited = true`). Cache invalidation is RQ-16.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-PDF-005 · Export request for Processing, Partial, or Failed session

🧑 **End-user test** · run by **Tester** · P1 · Negative / State Handling · `RQ-13`, `RQ-14`, `RQ-16`

*Needs:* Recorder · phone · browser

**Goal.** Verify controlled behavior when a complete report is not available.

**Before you start.** Sessions exist in Processing, Partial, and Failed states.

**Use.** Three controlled sessions.

**Do this**

1. Open each session.
2. Attempt export.
3. Observe message and any permitted partial-report option.

**You should see**

Export is disabled or clearly labeled as partial according to requirement. No misleading
complete report is generated.

**Check before you call it passed**

Check state, generated file presence, report labeling, and absence of stale report from
another session.

**Passed if.** Incomplete sessions cannot produce an unlabeled or misleading complete report.

> ⚠️ Depends on undecided requirement(s) `RQ-13` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Export of a non-terminal session should be refused or clearly marked partial. RQ-16,
> unsettled.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-PDF-006 · PDF file name, metadata, time zone, repeated export, and access

🧑 **End-user test** · run by **Tester** · P1 · Functional / Security · `RQ-16`, `RQ-17`, `RQ-19`

*Needs:* Recorder · phone · browser

**Goal.** Verify report naming, metadata consistency, repeatability, and authorized access.

**Before you start.** Completed session exists; user has export access.

**Use.** Session with known local date/time and user ID.

**Do this**

1. Export twice.
2. Review file names and document metadata.
3. Compare report date/time to Web App.
4. Attempt access after logout or URL expiration.

**You should see**

File naming is deterministic and safe; repeat export does not create wrong content;
unauthorized access is denied.

**Check before you call it passed**

Check file name, report metadata, timestamps/time zone, version, access after logout, and
duplicate report records.

**Passed if.** Repeated export is consistent and only authorized users can access the report.

> **Server side.**
>
> Naming/metadata/authorization rules are RQ-16. Record behaviour.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

---

## Security, Privacy, and Data Isolation

### SATE-SEC-001 · User A cannot view User B's session through normal navigation

🧑 **End-user test** · run by **Tester** · P0 · Security / Authorization · `RQ-17`

*Needs:* Recorder · phone · browser

**Goal.** Verify tenant/user data isolation.

**Before you start.** User A and User B each have completed sessions.

**Use.** Two non-admin accounts with distinct data.

**Do this**

1. Log in as User A.
2. Review session list and search/filter.
3. Confirm User B's session is absent.
4. Repeat as User B.

**You should see**

Each user sees only authorized sessions.

**Check before you call it passed**

Review network responses, session IDs, audio/report URLs, and DB policy logs if available.

**Passed if.** No unauthorized metadata, transcript, annotation, audio, or report is exposed.

> **Server side.**
>
> Isolation is enforced by Supabase RLS on `recordings` / `sate_device_sessions` keyed on
> `user_id`. Verify with a direct PostgREST call using User A's token against User B's row —
> the UI hiding it is not proof.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-SEC-002 · Direct URL or session-ID manipulation

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Security / Authorization · `RQ-17`

*Needs:* Recorder · phone · browser + Supabase read access · An HTTP client for direct PostgREST / device-api calls

**Goal.** Verify that changing a URL or request ID cannot bypass access control.

**Before you start.** User A knows or is given User B's test session ID.

**Use.** Two user accounts and one unauthorized session ID.

**Do this**

1. Log in as User A.
2. Replace URL/API session ID with User B's ID.
3. Attempt transcript, audio, annotation, and PDF access.

**You should see**

UI returns an authorized Not Found/Access Denied response without revealing sensitive
metadata.

**Check before you call it passed**

Inspect HTTP status, response body, logs, and absence of leaked signed URLs or metadata.

**Passed if.** No protected content or existence-sensitive detail is disclosed.

> **Server side.**
>
> Same as SEC-001, at the API rather than the UI. A 200 here is a release blocker.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-SEC-003 · Logout and token invalidation

> ✂️ **Reduced scope.** Web app logout and token invalidation only. Skip mobile app logout.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Security · `RQ-17`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify that an ended session cannot continue accessing protected data.

**Before you start.** User is logged in with an open transcript and active API token.

**Use.** One authorized session.

**Do this**

1. Open transcript/audio.
2. Log out.
3. Use browser Back, refresh, saved API request, and prior audio/report URL.
4. Attempt access from another tab.

**You should see**

Protected pages redirect to login or deny access. Cached sensitive content is not newly
retrievable.

**Check before you call it passed**

Check API status, cache behavior, signed URL validity, and session cookies/tokens.

**Passed if.** Logout prevents further protected access according to policy.

> **Server side.**
>
> Token invalidation is Supabase Auth. Confirm an old token is rejected by `device-api`, not
> just by the web app.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-SEC-004 · Pending local session remains isolated during account switch

> ⏸ **Deferred — mobile app is not in scope for this run.**
>
> Pending-session isolation across an account switch is purely mobile-app local storage.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Security / Data Isolation · `RQ-17`, `RQ-22`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify local clinical data cannot cross user boundaries.

**Before you start.** User A has an unsynced session and account switching is permitted.

**Use.** User A and User B accounts.

**Do this**

1. Create pending session as User A.
2. Switch to User B according to allowed flow.
3. Inspect local sessions and attempt upload/playback.
4. Return to User A.

**You should see**

User B cannot see or interact with User A's pending data.

**Check before you call it passed**

Inspect local queue ownership, UI visibility, upload requests, and final backend owner.

**Passed if.** No cross-account access or upload occurs.

> **Server side.**
>
> Pending local sessions must not become visible to the new account. Pairs with APP-006/007.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-SEC-005 · Role-based access to review, edit, export, retry, and administration

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Security / Functional · `RQ-17`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify each role has only approved actions.

**Before you start.** Test accounts exist for Viewer, Clinician/Editor, and Admin or the actual SATE roles.

**Use.** One completed and one failed session.

**Do this**

1. Log in as each role.
2. Attempt view, audio playback, edit, export, retry/reprocess, and administrative actions.
3. Attempt direct API calls for hidden actions.

**You should see**

UI shows only permitted actions; forbidden actions are disabled or absent.

**Check before you call it passed**

Record action matrix, HTTP results, audit entries, and any exposed data.

**Passed if.** Every action matches the approved role matrix with no client-side-only security.

> **Server side.**
>
> Admin is gated on the `sate_admins` table, by email; `/admin` manages ALL devices and
> firmware system-wide. ⚠️ **Known gap:** `POST /firmware` (publishFirmware) is routed
> **above** the `/admin` gate, so any authenticated user can push fleet-wide OTA. It validates
> the image (semver, `0xE9` magic, size cap) but has no `isAdmin()` check. Same in the
> Cloudflare port. Test it — it should fail, and it is a known open item, not a new finding.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-SEC-006 · Signed audio/report URL expiry and sharing

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P0 · Security · `RQ-17`

*Needs:* Recorder · phone · browser + Supabase read access · Ability to read a signed URL and wait out its expiry

**Goal.** Verify temporary resource links cannot provide indefinite unauthorized access.

**Before you start.** System uses signed/temporary URLs or equivalent protected access.

**Use.** One audio URL and one PDF URL.

**Do this**

1. Obtain authorized URLs.
2. Test before expiry.
3. Test in a logged-out/private browser.
4. Test after expiry.
5. Request a new authorized URL.

**You should see**

Access follows policy; expired or unauthorized links fail cleanly.

**Check before you call it passed**

Record URL lifetime, HTTP results, referrer/cache behavior, and new-link generation.

**Passed if.** Protected media and reports are not indefinitely accessible through copied links.

> **Server side.**
>
> Signed URLs come from Supabase Storage. Confirm expiry is actually enforced by requesting
> after it lapses.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-SEC-007 · Deletion, retention, audit trail, and sensitive logging

🖥 **Server-side test** · run by **Engineer** · P0 · Security / Privacy / Data Lifecycle · `RQ-18`

*Needs:* Supabase SQL + Storage · cf-processor logs · Log access · database access for audit and retention checks

*What the end user does:* None — audit, retention and log inspection only.

**Goal.** Verify approved deletion/retention behavior and absence of unnecessary sensitive content in logs.

**Before you start.** Test session can be deleted or marked for deletion; log access is available to authorized tester.

**Use.** One completed session with transcript, annotations, audio, report, and edit/retry history.

**Do this**

1. Review audit records before deletion.
2. Delete according to the approved workflow.
3. Attempt access to session, audio, transcript, and PDF.
4. Inspect storage/DB/processing records and logs.
5. Verify retention exceptions if applicable.

**You should see**

User sees a clear deletion outcome and can no longer access deleted content unless policy
provides a recoverable period.

**Check before you call it passed**

Check session row, audio object, result rows, report, signed URLs, audit entries,
backups/retention markers, and log contents.

**Passed if.** Data lifecycle matches policy and logs do not expose unnecessary sensitive clinical content.

> **Server side.**
>
> Deletion/retention is RQ-18, unsettled. Note the device side is already decided: full
> deletion is **user-only** (`deleteSessionFiles()`, the Delete button); automatic reclaim
> frees audio only after server verification and keeps a `.synced` tombstone so the slot stays
> numbered. Check logs for leaked device keys or tokens.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

---

## Compatibility and Deployment

### SATE-COMP-001 · Supported iOS and Android versions and representative devices

> ⏸ **Deferred — mobile app is not in scope for this run.**
>
> iOS / Android version matrix.

🧑 **End-user test** · run by **Tester** · P1 · Compatibility · `RQ-19`

*Needs:* Recorder · phone · browser

**Goal.** Verify core workflows across the supported mobile matrix.

**Before you start.** Supported OS/device list is approved.

**Use.** At minimum: oldest supported iOS, current iOS, oldest supported Android, current Android, one low-end Android, one current flagship.

**Do this**

1. Install and log in on each device.
2. Pair BLE device.
3. Record, upload, review status, and recover from one brief network loss.
4. Compare behavior.

**You should see**

Core controls, permissions, background behavior, and status displays work consistently.

**Check before you call it passed**

Record OS, model, app version, device ID, session result, crash logs, and performance notes.

**Passed if.** All release-supported mobile configurations pass P0 workflows or have documented exceptions.

> **Server side.**
>
> Record OS/app versions in the evidence. No server-side check.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-COMP-002 · Supported desktop browsers for Web App and PDF

🧑 **End-user test** · run by **Tester** · P1 · Compatibility · `RQ-19`

*Needs:* Recorder · phone · browser

**Goal.** Verify review, editing, audio playback, and PDF export across supported browsers.

**Before you start.** Supported browser/version list is approved.

**Use.** Latest supported Chrome, Edge, and Safari; representative screen sizes.

**Do this**

1. Log in on each browser.
2. Open session list and transcript.
3. Play audio.
4. Edit/save if supported.
5. Export/open PDF.

**You should see**

Layout, controls, audio, editing, and PDF work without browser-specific corruption.

**Check before you call it passed**

Record browser/version, session ID, functional results, console errors, and screenshots.

**Passed if.** All supported browsers complete the approved workflow without data integrity defects.

> **Server side.**
>
> Browser matrix only.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-COMP-003 · Older app/firmware version against current backend

> ✂️ **Reduced scope.** Older recorder firmware against the current backend. Skip the older app build.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P1 · Backward Compatibility · `RQ-19`

*Needs:* Recorder · phone · browser + Supabase read access · An older app build and an older firmware image

**Goal.** Verify supported version compatibility and safe rejection of unsupported versions.

**Before you start.** One older supported build and one intentionally unsupported build are available.

**Use.** Older recorder firmware/mobile app test devices.

**Do this**

1. Connect the older supported version and run a session.
2. Attempt the same with an unsupported version.
3. Observe upgrade messaging and backend handling.

**You should see**

Supported older version works as documented. Unsupported version is blocked or warned before
data loss occurs.

**Check before you call it passed**

Check app/firmware version metadata, API response, session schema, and upgrade path.

**Passed if.** Version compatibility follows the release policy with no silent corruption.

> **Server side.**
>
> Older firmware against current backend. `device-api` is versioned in-comment (currently v18)
> and routes are additive — `/sessions/verify` (v15) and `/sessions/upload-progress` (v16)
> simply do not exist for older firmware, which must degrade rather than fail. A recorder
> below fw 1.5.13 does not use verified trim at all.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-COMP-004 · Time zone, daylight-saving transition, and device clock skew

> ✂️ **Reduced scope.** Recorder clock and stored timestamps. Skip phone clock skew.

🧑🖥 **End-user + server-side** · run by **Tester + Engineer** · P1 · Compatibility / Data Integrity · `RQ-19`

*Needs:* Recorder · phone · browser + Supabase read access

**Goal.** Verify canonical time storage and correct display under clock differences.

**Before you start.** Test environment can change time zone/clock or use simulated timestamps.

**Use.** Sessions across two time zones; one device clock intentionally skewed; DST boundary simulation if practical.

**Do this**

1. Record sessions in each time setting.
2. Sync and review Web App/PDF timestamps.
3. Correct device clock and repeat.
4. Compare ordering and duration.

**You should see**

Displayed local time follows product rules; warning appears for severe clock skew if
supported; duration remains correct.

**Check before you call it passed**

Compare UTC/local timestamps, time-zone field, duration, sort order, and PDF metadata.

**Passed if.** No unexplained one-hour/day shift, negative duration, or incorrect session ordering occurs.

> **Server side.**
>
> Canonical timestamps are UTC; only display converts. A DST shift must not move a stored
> value.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

### SATE-COMP-005 · Low-end device and degraded network performance

> ⏸ **Deferred — mobile app is not in scope for this run.**
>
> Low-end phone performance.

🧑 **End-user test** · run by **Tester** · P1 · Performance / Compatibility · `RQ-19`, `RQ-20`

*Needs:* Recorder · phone · browser

**Goal.** Verify minimum supported hardware remains usable under realistic constraints.

**Before you start.** Low-end supported phone and throttled/weak network are available.

**Use.** 10-minute recording; limited memory/storage; high latency and low bandwidth.

**Do this**

1. Pair device and record.
2. Background/foreground once.
3. Upload over degraded network.
4. Review transcript and export PDF.
5. Capture resource metrics and errors.

**You should see**

App remains responsive enough to complete the workflow and communicates delays clearly.

**Check before you call it passed**

Record memory, battery, upload time, crash/ANR logs, session/object counts, and final
integrity.

**Passed if.** Minimum supported hardware/network completes the workflow or fails safely within documented limits.

> ⚠️ Depends on undecided requirement(s) `RQ-20` —
> record the observed behaviour instead of pass/fail until they are settled.

> **Server side.**
>
> Observation only.

| Result | | Evidence |
|---|---|---|
| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |

---

## Known defects that will affect this run

Found in the 2026-07-22 audit and still open. If a case fails on one of these, it is a known
item — reference it rather than filing a duplicate.

| Affects | What | Severity |
|---|---|---|
| `SATE-SEC-005` | `POST /firmware` (publishFirmware) is routed **above** the `/admin` gate, so any authenticated user can push fleet-wide OTA. Image validation exists (semver, `0xE9` magic, size cap) but no `isAdmin()` check. Same in the Cloudflare port. | Fix before GA |
| `SATE-BE-008` | The `process-device-session` copy **in this repo** is not the no-op that production runs — it still downloads the WAV, awaits the AI and inserts `recordings`, so deploying it would duplicate every recording and re-introduce the 150 s edge-kill hang. | Do not deploy repo file |
| `SATE-E2E-006`, `SATE-QUE-006` | Upload deduplication relies on a probe by (user, serial, patient, session_number, bytes) + `objectExists`, with **no database unique constraint** behind it. | Add constraint |
| `SATE-LONG-002/003` | TWO Storage file-size limits, the smaller wins; the BUCKET's is the one that has bitten (200 MiB while the project sat at 500 MB). Both 5 GB now — verify before long-session runs. | Config check |

---

## Appendix — server-side quick reference

### The state machine

```
sate_device_sessions.status:  queued → processing → done | error

  queued        new rows default here (column default — device-api needs no change to enqueue)
  processing    claim_next_session(p_worker) — atomic, FOR UPDATE SKIP LOCKED
                stamps processing_started_at, worker_id, heartbeat_at
  done          finalize-session wrote the recordings row (or no_text with none)
  error         permanent failure, or transient past MAX_ATTEMPTS
```

| Constant | Value | Where |
|---|---|---|
| `MAX_ATTEMPTS` | 3 | cf-processor |
| `STUCK_MINUTES` | 90 | watchdog reclaim cutoff (must exceed `AI_READ_TIMEOUT_S`) |
| `POLL_INTERVAL` | 10 s | empty-queue poll |
| `AI_READ_TIMEOUT_S` | 3600 s | longer than the stale cutoff — see `SATE-LONG-003` |
| `MIN_AUDIO_SEC` | 0.4 s | below this → `no_text`, AI never called |
| `KEEP_AUDIO_SESSIONS` | 5 | newest N takes keep their SD audio |

### Routes worth knowing during a test run

| Route | Auth | Notes |
|---|---|---|
| `POST /api/sessions` · `/chunk` · `/raw` | device key | Chunked slices land as `_tmp/<patient>/s<n>/<offset>.part`, stitched on final |
| `GET /api/sessions/verify` | device key | ≥v15. `stored:true` only when row **and** object exist. Read-only — never make it mutate |
| `GET /api/sessions/upload-progress` | user JWT | ≥v16. Live bytes of an in-flight upload |
| `POST /api/sessions/:id/retry` | user JWT | ≥v14. Accepts **only** a session in `error` |
| `GET /api/devices/:id/commands` | device key | Heartbeat + command poll |
| `GET /api/health/alerts` | shared secret | Error digest the 5-minute status worker emails from |

### Three rules that must not be broken while fixing anything found here

1. **Never move the AI call into an edge function or a Worker.** Supabase edge has a hard
   ~150 s wall-clock; a plain Worker has a ~100 s origin timeout. Both kill the request
   *mid-fetch, before any catch block*, so no error is ever recorded and the session hangs in
   `processing` forever. The long call must stay in the container.
2. **`device-api` and `mint-plaud-token` must deploy `verify_jwt:false`.** They validate
   tokens themselves. The CLI/MCP default of `true` breaks recorder registration and Plaud
   token minting, and presents as an auth bug.
3. **Never free device audio on a `.synced` marker alone.** A marker means "a POST returned
   2xx", not "the audio is durably stored" — that gap is what the 413 ghosts exploited. The
   verify gate (row + `objectExists`) is what makes reclaim safe.

