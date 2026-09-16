#!/usr/bin/env python3
"""Generate doc/13-system-test.md from SATE_Complete_English_Test_Cases.xlsx.

The workbook is the source of truth for WHAT is tested — IDs, titles, steps, priorities
and pass criteria come through verbatim so the two never drift. What this adds is the
half the workbook could not know: how to actually verify each case against THIS
implementation. Its "Expected Backend / Data Result" column says things like "exactly one
session record is created"; the server notes below say which table, which column, which
status value, and which known bug will bite you.

Re-run after editing the workbook:
    python3 doc/gen-system-test.py
"""

import json
import re
import textwrap
from pathlib import Path

CASES = json.loads((Path(__file__).parent / 'testdata' / 'cases.json').read_text())
SCOPE_DEF = json.loads((Path(__file__).parent / 'testdata' / 'test-scope.json').read_text())
SCOPE = SCOPE_DEF['scope']
REDUCED, RUNNOTE, DEFNOTE = SCOPE_DEF['reduced_note'], SCOPE_DEF['run_note'], SCOPE_DEF['deferral_note']
scope_of = lambda t: SCOPE.get(t, 'In scope')
running = lambda t: not scope_of(t).startswith('Deferred')
scope_note = lambda t: REDUCED.get(t) or RUNNOTE.get(t) or DEFNOTE.get(t) or ''

SIDE_DEF = json.loads((Path(__file__).parent / 'testdata' / 'test-side.json').read_text())
SIDE, ACCESS = SIDE_DEF['side'], SIDE_DEF['access']
RUN_BY, EXTRA, USER_ACTION = SIDE_DEF['run_by'], SIDE_DEF['extra_access'], SIDE_DEF['user_action']

def access_for(tid):
    base = ACCESS[SIDE[tid]]
    return f'{base} · {EXTRA[tid]}' if tid in EXTRA else base
OUT = Path(__file__).parent / '13-system-test.md'

# ---------------------------------------------------------------------------
# Server-side notes, keyed by TC ID.
#
# Written against the real system: table and column names from the Supabase schema,
# route names and versions from device-api, and the constants that actually govern
# behaviour (MAX_ATTEMPTS, STUCK_MINUTES, MIN_AUDIO_SEC). Where a case will collide with
# a known defect, that is stated rather than left for the tester to discover.
# ---------------------------------------------------------------------------
SERVER = {
# ---- End-to-end ------------------------------------------------------------
'SATE-E2E-001': """
Watch one row move through the state machine and stop:
`select id, status, attempts, processed, recording_id, bytes, storage_path, process_error
from sate_device_sessions where device_serial = '<serial>' order by created_at desc limit 5;`
Status must go `queued → processing → done` and settle. `recording_id` must be non-null and
resolve to exactly one `recordings` row. Confirm the storage object really exists — a row
alone is not proof (the 413 bug once left ghost rows with no object).
Then confirm the audio the recorder freed matches: `GET /api/sessions/verify?...` must answer
`stored:true` for that session number and byte count. `sate pipeline` shows this live.
""",
'SATE-E2E-002': """
A take under `MIN_AUDIO_SEC` (env, default **0.4 s**) never reaches the AI at all — the
container finalizes it `no_text` up front, because the AI service answers HTTP 500 on a
near-empty WAV and a 5xx reads as transient, which used to retry-loop into a stuck error
(hit real on session 35). So a 10–15 s take is well above that floor and must transcribe
normally. There is no other minimum enforced server-side — RQ-07 is still unsettled, so
record what actually happens rather than asserting a threshold.
""",
'SATE-E2E-003': """
Silence is a *result*, not a failure. `cf-processor` calls `finalize({no_text:true})`, the
edge marks the session `done`, and **no `recordings` row is created**. Verify
`select status, no_text, recording_id from sate_device_sessions where id='<id>'` gives
`done / true / null`. A session sitting in `processing` here is the real bug — check the
container logs before blaming the AI.
""",
'SATE-E2E-004': """
Nothing special server-side: one `sate_device_sessions` row, one `recordings` row. Check
`recordings.transcript` parses as JSON and `recordings.analysis` has the computed metrics
(`ntw`, `ndw`, `mluw`, `mlum`, `errorCounts`). Diarization quality is not a pass criterion —
pipeline integrity is.
""",
'SATE-E2E-005': """
Canonical timestamps are stored UTC (ISO-8601). Compare `sate_device_sessions.created_at`,
`recordings.created_at`, and what the web app renders; a mismatch is a display-layer bug,
not a storage one. Device association is `sate_devices.id` → `sate_device_sessions.user_id`;
it must not change on refresh.
""",
'SATE-E2E-006': """
This is the idempotency case. `storeSessionRecord` probes for an existing row by
**(user, serial, patient, session_number, bytes) + objectExists** and reuses it, which is
what stops a lost BLE `markSynced` ACK creating a second take.
⚠️ **There is still no database unique constraint behind that probe.** Under a genuine race
the probe can be passed twice. If you get two rows for one recording here, that is the known
gap, not a new defect — log it against RQ-03.
""",
# ---- Recorder --------------------------------------------------------------
'SATE-REC-001': """
Segments flush to SD roughly every 5 s, so at most ~5 s of tail is at risk. On boot
`maybeResumeRecording()` re-enters the same session — **every** take resumes, button-started
and server-started alike (fw ≥1.5.16). Serial should show `[CONN] resume … session N`.
The session number must not change: numbers are allocated monotonically and never renumbered
(fw ≥1.5.20). A hole in the numbering is legal; a *reused* number is a defect.
""",
'SATE-REC-002': """
Same resume path as REC-001, and the one that matters most. Two things to check on the
serial log: `[MEM] ready` (boot completed) and `[CONN] resume … session N`.
The resume runs from `loop()`, never `setup()` (fw ≥1.5.17) — if the device comes back and
is *unreachable* (no heartbeat, remote stop ignored), that regression is back and it is a
release blocker: the take runs to the ~62-minute ceiling with nobody able to stop it.
""",
'SATE-REC-003': """
Low-voltage cutoff uses the GPIO9 battery sense (`analogReadMilliVolts × 2` behind the
board's 0.5 divider). Confirm the partial take survived to SD and later uploads with its
real byte count. Battery telemetry lands in `sate_devices.battery_pct` / `battery_mv` via
the heartbeat.
""",
'SATE-REC-004': """
Nothing reaches the server. Confirm no orphan row in `sate_device_sessions` and no object in
the `device-sessions` bucket. A row with `storage_path` set but no object is the failure
signature to look for.
""",
'SATE-REC-005': """
The recorder must stop cleanly and keep what it captured. Server-side the take arrives as a
normal short session. Verify byte count matches `sessionAssembledBytes()` semantics: part0
keeps its 44-byte WAV header, later parts are stripped — the server's stored `bytes` must
equal that exactly, because `GET /sessions/verify` compares it before the device frees audio.
""",
'SATE-REC-006': """
The crash window is inside finalization. Either a complete take or a recoverable partial is
acceptable; a take marked synced with no server object is not. Check for the ghost signature:
a `.synced` marker on device with no matching row/object server-side.
""",
'SATE-REC-007': """
Nothing has been uploaded yet, so the server should show no row until connectivity returns.
Then exactly one row appears. This is the case that proves reclaim safety: the device must
NOT free the audio until `GET /api/sessions/verify` (device-api ≥v15) returns `stored:true`
— which checks the row **and** `objectExists`. Any doubt keeps the audio.
""",
# ---- Network ---------------------------------------------------------------
'SATE-NET-001': """
No server activity during the take. On reconnect, one row appears with the full byte count.
Confirm the recorder did not free SD audio in the meantime — verified trim only releases
audio for synced takes older than the newest `KEEP_AUDIO_SESSIONS` (=5) **and** only after
byte-exact `stored:true`.
""",
'SATE-NET-002': """
The take continues locally; Wi-Fi loss must not stop capture. Watch for the upload retrying
after association returns. If the device came up offline and the AP is down, the offline
fallback still starts the net task so heartbeat, remote stop and OTA health-confirm keep
working — verify the device is reachable during the take.
""",
'SATE-NET-003': """
Nothing on the server until connectivity returns, then one complete row. Check
`GET /sessions/upload-progress` (device-api ≥v16) reports zero in-flight bytes while offline.
""",
'SATE-NET-004': """
Chunked upload stores each slice as its own `_tmp/<patient>/s<n>/<offset>.part` object and
stitches once on the final slice (device-api ≥v12 — the earlier design rewrote the whole
temp blob per slice, was quadratic, and stalled long uploads). A resumed upload must not
duplicate parts. If the sizes disagree the edge rejects rather than storing a corrupt WAV.
Inspect leftover `_tmp/` objects after success — they should be gone.
""",
'SATE-NET-005': """
Server side just sees a later upload. The interesting check is that only ONE upload lands,
not one per foreground/background transition.
""",
'SATE-NET-006': """
Associated-but-no-internet must be classified as a transient failure, not a permanent one.
The session should stay `queued` (or return to it), never jump to `error`.
""",
'SATE-NET-007': """
Captive portal returns an HTTP 200 with HTML rather than the expected JSON. Confirm the
device treats an unparseable body as a failure and keeps the audio — a 2xx alone must never
be read as "durably stored". This is exactly the class that produced the 413 ghosts.
""",
'SATE-NET-008': """
Same as NET-004: the stitch must be resilient to the connection changing underneath it.
Check final `bytes` equals the device's assembled byte count.
""",
'SATE-NET-009': """
Expect repeated `attempts` increments. `requeue_session` applies backoff for transient
failures; the watchdog `requeue_stale_sessions(p_stuck_minutes=45, p_max_attempts=3)` reclaims
anything abandoned. The session must not exceed `MAX_ATTEMPTS` (3) and must settle.
""",
'SATE-NET-010': """
Concurrent retry prevention. The user Retry route is `POST /sessions/:id/retry`
(device-api ≥v14) and it **only accepts a session in `error`** — a `processing` row is
refused, which is what stops a manual tap racing the container. `claim_next_session` is
`SELECT … FOR UPDATE SKIP LOCKED`, so a double claim is impossible even if two workers ran.
Confirm `attempts` increments by one, not two.
""",
# ---- Queue -----------------------------------------------------------------
'SATE-QUE-001': """
Five rows, five distinct `session_number`s, five `recordings`. The container drains the queue
**serially** (`max_instances = 1`, GPU concurrency is 1 anyway), so expect sequential
completion, not parallel. Total time ≈ sum of individual processing times — that is by
design, not a stall.
""",
'SATE-QUE-002': """
A new take must not disturb an in-flight upload. Note the delete/upload interaction rule: a
delete defers-and-drops the uploader **only if it is latched on that exact session**
(`upDropReq`); any other session's upload is untouched.
""",
'SATE-QUE-003': """
Five queued rows appear on reconnect. Order is by `created_at`; the claim query is
`status='queued' order by created_at`. Session numbers must be distinct and none reused.
""",
'SATE-QUE-004': """
Per-item fault isolation. One row going to `error` must not block the others — verify the
remaining four reach `done`. `pg_cron` pings the Worker `/tick` every minute to keep the
container warm; if everything stalls together, check the container is awake before blaming
the queue.
""",
'SATE-QUE-005': """
Queue state lives in Supabase, not in the app or the container — a restart of either must
resume from the database. The container has no state to lose.
""",
'SATE-QUE-006': """
**The highest-risk case in the book.** Two paths can deliver one recording: the recorder's
device-key `POST /sessions` and the phone's user-authed `POST /sessions` (used for Plaud and
BLE-bridged takes, which have no device key).
Dedup relies on `storeSessionRecord`'s probe by (user, serial, patient, session_number, bytes)
+ `objectExists`. ⚠️ **No unique constraint backs it.** If both paths run for one recording,
expect this to be where a duplicate canonical session appears — a release blocker by the
workbook's own severity rules. Test it deliberately and record the outcome against RQ-21.
""",
# ---- Long ------------------------------------------------------------------
'SATE-LONG-001': """
A 30-minute 16 kHz mono take is ~57 MB. Confirm it lands whole.
""",
'SATE-LONG-002': """
~86 MB. Watch the Storage limit: **the project-wide file size limit overrides the bucket's**
and defaults to 50 MB. It is set to 500 MB now, but if long sessions land as rows with
`process_error: "download failed: Object not found"`, check that setting first — a swallowed
413 plus a `.synced` written on a false 2xx destroyed a 62-minute recording once.
`storeSessionRecord` now throws on upload failure rather than swallowing it.
""",
'SATE-LONG-003': """
The firmware ceiling is ~62 minutes (~118 MB). Beyond the storage limit above, note the
timeout tension: `AI_READ_TIMEOUT_S` is 3600 s (60 min) while `STUCK_MINUTES` is 45 — a
single legitimate AI read can outlive the stale cutoff. The watchdog only fires *between*
jobs (the loop is blocked inside `process()`), so this is safe in practice, but a job that
does get reclaimed mid-run on a maximum-length take is the signature to watch for.
""",
'SATE-LONG-004': """
Chunked resume as NET-004, at maximum size. Verify no leftover `_tmp/` parts and a byte-exact
final object.
""",
'SATE-LONG-005': """
Recorder-side this is unaffected by the phone. If the take is BLE-bridged, the phone must keep
streaming — check for truncation at the moment of lock.
""",
'SATE-LONG-006': """
Observation only. Useful server-side numbers: `processing_started_at` → `processed_at` gives
true processing time; `attempts` shows retry churn. `sate infra` probes every tier (auth, DB,
device-api + the v15 verify route, Storage, CF worker, AI-queue state, device heartbeat).
""",
# ---- BLE -------------------------------------------------------------------
'SATE-BLE-001': """
Pairing is app-side. Server-side, confirm the device row exists and is bound to the right
account: `select id, serial, user_id, fw, online, last_seen from sate_devices`.
""",
'SATE-BLE-002': """
No server involvement. Known pendants persist in AsyncStorage and reconnect by BLE id.
Note: a notification gap while connected is **normal** — the pendant sleeps in silence (nap
mode) — and must not be reported as a disconnect.
""",
'SATE-BLE-003': """
Wrong-device selection must not re-bind anything. For a **Plaud** device this is critical:
if `bindingOwner(sn)` is set and differs from this account, the app must REFUSE to connect.
A mis-bound Plaud is permanently locked, unlike a recoverable SATE recorder.
""",
'SATE-BLE-004': """
Scan with **no service filter** and match on `name` OR `localName` OR the advertised audio
service — the pendant's name is only in the scan response, so iOS surfaces it as `localName`
and `name` may be a stale cached GAP name from older firmware.
""",
'SATE-BLE-005': """
Only one central may hold the link. Expect a clean refusal, not a re-bind.
""",
'SATE-BLE-006': """
Permission loss must be reported, not silently retried. Note SATE and Pendant **share one
`BleManager`**; a screen taking the radio must `stopScan()` only and never destroy it.
Destroying and recreating leaves the iOS BLE stack returning zero devices with no error.
""",
'SATE-BLE-007': """
A BLE drop during a bridged take is a truncation risk. Server-side, compare stored `bytes`
against the expected duration — a short object with a `done` status is the failure.
""",
'SATE-BLE-008': """
Same truncation check. Confirm whatever was captured is preserved rather than discarded.
""",
# ---- App -------------------------------------------------------------------
'SATE-APP-001': """
No server involvement for a recorder-driven take. For BLE-bridged capture, check for a gap
at the moment of backgrounding.
""",
'SATE-APP-002': """
The recorder is the source of truth; a force-closed app must not lose the take. Verify the
session still arrives.
""",
'SATE-APP-003': """
Interrupted upload → chunked resume. Check for orphan `_tmp/` parts left behind.
""",
'SATE-APP-004': """
Same as APP-003 with a longer gap. The row should either not exist yet or be complete —
never a row with `storage_path` pointing at nothing.
""",
'SATE-APP-005': """
⚠️ **Read this before testing.** `device-api` and `mint-plaud-token` are deployed
`verify_jwt:false` and validate the token themselves. If this case fails with
"Setup link expired" or a blanket 401, first confirm nobody redeployed them with the
MCP/CLI default `verify_jwt:true` — that breaks registration and token minting system-wide
and looks exactly like an auth-expiry bug.
The recorder path uses a device key (`Bearer key-…`), not a JWT, so it is unaffected by user
token expiry — a session already on the device will still upload.
""",
'SATE-APP-006': """
Pending local sessions belong to the account that recorded them (RQ-22, unsettled). Verify
nothing uploads under the new session's identity.
""",
'SATE-APP-007': """
The isolation case. After the switch, a pending take must not land under User B's `user_id`.
Check `sate_device_sessions.user_id` on whatever eventually uploads.
""",
'SATE-APP-008': """
Reinstall loses AsyncStorage but **not** the iOS Keychain — Plaud bindings live in
`plaud.bind.<sn>` with `AfterFirstUnlock` specifically so they survive uninstall. Reinstall
must reconnect, never re-bind.
""",
# ---- Backend ---------------------------------------------------------------
'SATE-BE-001': """
The reference case for the state machine. `queued → processing → done`, with
`processing_started_at`, `worker_id`, `heartbeat_at` stamped on claim. New rows default to
`queued` (a column default, so `device-api` needs no change to enqueue).
""",
'SATE-BE-002': """
A 5xx is classified transient → `requeue_session` with backoff → `attempts` becomes 2 → next
claim succeeds → `done`. Confirm exactly one `recordings` row, not two.
""",
'SATE-BE-003': """
`MAX_ATTEMPTS` is 3. After the third the session settles `error` with `process_error` set. It
must NOT loop. The status worker (`sate-status`, 5-minute cron) emails the operator **once**
for a settled error, since it cannot auto-clear; only active conditions re-remind, at most
every 24 h.
""",
'SATE-BE-004': """
4xx is permanent → `fail_session` immediately, no retry. `attempts` should not climb.
""",
'SATE-BE-005': """
Timeout is transient. Note `AI_READ_TIMEOUT_S` = 3600 s — the container holds a long call
rather than timing out early; it will not hang forever on an up-but-dead AI.
""",
'SATE-BE-006': """
Non-JSON body → `Permanent("AI returned a non-JSON body")`. No retry, no partial
`recordings` row.
""",
'SATE-BE-007': """
Missing `segments` → `Permanent("AI returned no segments")`. Partial-field handling is RQ-14
and still unsettled — record what the pipeline does rather than asserting.
""",
'SATE-BE-008': """
⚠️ **The dangerous one.** `process-device-session` must be a **200 no-op** in production;
`device-api` still fire-and-forgets to it, but if it actually processes, it races the
container and duplicates recordings.
**The copy checked into this repo is NOT the no-op** — it still downloads the WAV, awaits the
AI, and inserts `recordings`, filtering on `processed=false` while the container claims on
`status`, so both would process the same session. Production is deployed as the no-op.
**Do not deploy the repo file as-is.** If you see duplicate recordings in this case, check
what is actually deployed before filing anything.
""",
'SATE-BE-009': """
Late/out-of-order updates. The container heartbeats during a long job so the watchdog cannot
steal work still running; `requeue_stale_sessions` only reclaims rows whose
`heartbeat_at`/`started_at` is older than `STUCK_MINUTES` (45). A late response arriving for
an already-requeued session must not resurrect it.
""",
'SATE-BE-010': """
Edge/Worker unavailability must be transient. Reminder for whoever fixes this: the AI call
**must never** move back into an edge function or a plain Worker — Supabase edge has a hard
~150 s wall-clock and a Worker a ~100 s origin timeout, and both kill the request mid-fetch
*before* any catch block, so `process_error` is never written and the session hangs in
`processing` forever. A 32-minute take once showed 70 minutes stuck.
""",
'SATE-BE-011': """
Upload succeeded, DB update failed — the exact shape that produced ghost rows. There must be
no session marked synced without a matching object. `GET /api/sessions/verify` is the guard:
it answers `stored:true` only when the row exists AND `objectExists`. It must stay read-only;
never make it mutate.
""",
'SATE-BE-012': """
`POST /sessions/:id/retry` (device-api ≥v14) re-queues an `error` session. It accepts **only**
`error` — to re-run anything else (an orphaned `processing` row, say) an owner must PATCH the
row to `queued` via PostgREST. Note a new container image does not instantly swap the running
singleton: an in-flight claim is killed and orphaned in `processing` until the 45-minute
watchdog.
""",
# ---- Web -------------------------------------------------------------------
'SATE-WEB-001': """
The web report reads `recordings.transcript` and `recordings.analysis`. Flag markers
(`recordings.flags`) render as seek-bar ticks — one shared pipeline for the recorder's
physical flag button and Plaud's device tap. Don't fork a parallel path.
""",
'SATE-WEB-002': """
UI must distinguish `processing`, retryable `error` (attempts < 3), and settled `error`.
The status column to read is `sate_device_sessions.status` plus `attempts` — the UI shows
real progress from these rather than inferring from `processed` (device-api ≥v14).
""",
'SATE-WEB-003': """No server involvement. Client-state only.""",
'SATE-WEB-004': """
Audio is served from the `recordings` bucket via `GET /sessions/:id/audio`. Confirm the clip
matches the transcript — cross-session contamination is a release blocker.
""",
'SATE-WEB-005': """
Editing writes back to `recordings.transcript` and sets `segments_edited`. Versioning policy
is RQ-15 and unsettled — record current behaviour.
""",
'SATE-WEB-006': """
Concurrent edit handling is undefined (RQ-15). Expect last-write-wins unless told otherwise;
document what you observe.
""",
'SATE-WEB-007': """
Special characters travel as JSON in `recordings.transcript`. Check for mojibake at the
storage boundary, not just on screen.
""",
# ---- PDF -------------------------------------------------------------------
'SATE-PDF-001': """Export reads the same `recordings` row. Confirm the PDF's session matches the row's `id`.""",
'SATE-PDF-002': """Pagination is client-side; no server check beyond the source row.""",
'SATE-PDF-003': """Font coverage is a rendering concern — confirm the stored JSON is correct first, so a glyph problem is not mistaken for data loss.""",
'SATE-PDF-004': """Re-export must pick up edited text (`segments_edited = true`). Cache invalidation is RQ-16.""",
'SATE-PDF-005': """Export of a non-terminal session should be refused or clearly marked partial. RQ-16, unsettled.""",
'SATE-PDF-006': """Naming/metadata/authorization rules are RQ-16. Record behaviour.""",
# ---- Security --------------------------------------------------------------
'SATE-SEC-001': """
Isolation is enforced by Supabase RLS on `recordings` / `sate_device_sessions` keyed on
`user_id`. Verify with a direct PostgREST call using User A's token against User B's row —
the UI hiding it is not proof.
""",
'SATE-SEC-002': """
Same as SEC-001, at the API rather than the UI. A 200 here is a release blocker.
""",
'SATE-SEC-003': """Token invalidation is Supabase Auth. Confirm an old token is rejected by `device-api`, not just by the web app.""",
'SATE-SEC-004': """Pending local sessions must not become visible to the new account. Pairs with APP-006/007.""",
'SATE-SEC-005': """
Admin is gated on the `sate_admins` table, by email; `/admin` manages ALL devices and firmware
system-wide.
⚠️ **Known gap:** `POST /firmware` (publishFirmware) is routed **above** the `/admin` gate, so
any authenticated user can push fleet-wide OTA. It validates the image (semver, `0xE9` magic,
size cap) but has no `isAdmin()` check. Same in the Cloudflare port. Test it — it should fail,
and it is a known open item, not a new finding.
""",
'SATE-SEC-006': """Signed URLs come from Supabase Storage. Confirm expiry is actually enforced by requesting after it lapses.""",
'SATE-SEC-007': """
Deletion/retention is RQ-18, unsettled. Note the device side is already decided: full deletion
is **user-only** (`deleteSessionFiles()`, the Delete button); automatic reclaim frees audio only
after server verification and keeps a `.synced` tombstone so the slot stays numbered.
Check logs for leaked device keys or tokens.
""",
# ---- Compatibility ---------------------------------------------------------
'SATE-COMP-001': """Record OS/app versions in the evidence. No server-side check.""",
'SATE-COMP-002': """Browser matrix only.""",
'SATE-COMP-003': """
Older firmware against current backend. `device-api` is versioned in-comment (currently v18) and
routes are additive — `/sessions/verify` (v15) and `/sessions/upload-progress` (v16) simply do
not exist for older firmware, which must degrade rather than fail. A recorder below fw 1.5.13
does not use verified trim at all.
""",
'SATE-COMP-004': """Canonical timestamps are UTC; only display converts. A DST shift must not move a stored value.""",
'SATE-COMP-005': """Observation only.""",
}

# Cases whose outcome depends on a requirement nobody has settled yet.
UNSETTLED = {
    'RQ-05', 'RQ-06', 'RQ-07', 'RQ-09', 'RQ-11', 'RQ-12', 'RQ-13',
    'RQ-15', 'RQ-20', 'RQ-21',
}

CATEGORY_ORDER = [
    'End-to-End Recording and Sync',
    'Recorder Interruption and Local Persistence',
    'Network, Offline, and Upload Recovery',
    'Queue, Batch, and Concurrency',
    'Long Session and Performance',
    'BLE and Device Connectivity',
    'Mobile App Lifecycle and Authentication',
    'Backend, Retry, and AI Processing',
    'Web Transcript Review',
    'PDF Export',
    'Security, Privacy, and Data Isolation',
    'Compatibility and Deployment',
]

SLUG = {
    'End-to-End Recording and Sync': 'E2E',
    'Recorder Interruption and Local Persistence': 'REC',
    'Network, Offline, and Upload Recovery': 'NET',
    'Queue, Batch, and Concurrency': 'QUE',
    'Long Session and Performance': 'LONG',
    'BLE and Device Connectivity': 'BLE',
    'Mobile App Lifecycle and Authentication': 'APP',
    'Backend, Retry, and AI Processing': 'BE',
    'Web Transcript Review': 'WEB',
    'PDF Export': 'PDF',
    'Security, Privacy, and Data Isolation': 'SEC',
    'Compatibility and Deployment': 'COMP',
}


def steps(raw):
    """The workbook stores steps as a numbered block in one cell. Keep the wording."""
    out = []
    for line in (raw or '').split('\n'):
        line = line.strip()
        if not line:
            continue
        out.append(re.sub(r'^\d+\.\s*', '', line))
    return out


def clean(s):
    return re.sub(r'\s+', ' ', (s or '').strip())


def wrap(text, width=94, indent=''):
    return '\n'.join(textwrap.wrap(text, width, initial_indent=indent, subsequent_indent=indent)) or indent


lines = []
A = lines.append

A('# 13 — System test (user-side)')
A('')
A('Generated from `SATE_Complete_English_Test_Cases.xlsx` — 88 cases, 65 of them P0. The')
A('workbook stays the source of truth for **what** is tested; this document is how a person')
A('actually runs it, and what an engineer checks on the server for each case.')
A('')
A('The workbook lives at `doc/testdata/`. After editing it, re-extract to `cases.json` and run')
A('`python3 doc/gen-system-test.py`, so the two never drift.')
A('')
A('Related: [10-manual-testing.md](10-manual-testing.md) is the engineer-facing pass against a')
A('real board, and [11-user-testing.md](11-user-testing.md) is the short plain-language script')
A('for a non-technical tester. This is the exhaustive one — the release gate.')
A('')
A('> Every case has two halves. **The user half** you can run with a recorder, a phone and a')
A('> browser — no database access, no shell. **The server note** is a quoted block underneath,')
A('> for whoever has Supabase and Cloudflare access; it names the actual table, column, route')
A('> and constant to look at, and flags the known defects that will make specific cases fail.')
A('')

# ---- how to run ------------------------------------------------------------
A('## Scope of this run')
A('')
A('**The mobile app and the pendant are not being tested.** The recorder, the backend and AI')
A('pipeline, the web app, PDF export and security are.')
A('')
_run = [c for c in CASES if running(c['TC ID'])]
_def = [c for c in CASES if not running(c['TC ID'])]
_rp0 = sum(1 for c in _run if c['Priority'] == 'P0')
A('| | Cases | P0 |')
A('|---|---|---|')
A(f'| **Running this pass** | **{len(_run)}** | **{_rp0}** |')
A(f'| Deferred — mobile app | {sum(1 for c in _def if "mobile app" in scope_of(c["TC ID"]))} | '
  f'{sum(1 for c in _def if "mobile app" in scope_of(c["TC ID"]) and c["Priority"] == "P0")} |')
A(f'| Deferred — pendant / BLE | {sum(1 for c in _def if "pendant" in scope_of(c["TC ID"]))} | '
  f'{sum(1 for c in _def if "pendant" in scope_of(c["TC ID"]) and c["Priority"] == "P0")} |')
A('')
A('Scope was assigned from each case\'s **Components** field, not by category name — the')
A('categories cut across surfaces. `SATE-SEC-003` sits under Security but its components are')
A('"SATE Web App; Mobile App", so the web half stays in and the app half drops out. Eight cases')
A('run in **reduced** form like that; each says exactly what to skip.')
A('')
A('### ⚠️ What deferring costs you')
A('')
for g in SCOPE_DEF['coverage_impact']['requirements_losing_all_coverage']:
    A(f'**`{g["id"]}` — {g["topic"]}** is marked *{g["definition_status"]}* and now has **zero test')
    A(f'coverage**. Every case covering it ({", ".join("`" + x + "`" for x in g["covered_only_by"])}) is a')
    A('mobile-app case. ' + g['note'].split('. ', 1)[-1])
    A('')
A('`SATE-QUE-006` is also deferred, and it is the case written to prove the two delivery paths')
A('deduplicate. With the app out of scope there is only one path in use, so the duplicate-session')
A('risk cannot materialise — but the underlying gap (no database unique constraint behind the')
A('dedup probe) stays unproven. **Run it before the app ships.**')
A('')
A('The deferred cases are parked, not deleted. To bring them back, set their entries in')
A('`doc/testdata/test-scope.json` to `"In scope"` and regenerate.')
A('')
A('## How to run this')
A('')
A('1. **Settle the blocking requirements first.** Ten of the 22 requirements are still')
A('   "Needs confirmation" or "Partially defined". A case whose expected result depends on an')
A('   undecided rule cannot pass or fail — it can only be *recorded*. They are listed below.')
A('2. **Run P0 before P1/P2.** 65 cases are P0. A failed P0 is a release blocker by default.')
A('3. **Use a fresh session label per run.** Say it aloud at the start and end of every')
A('   recording: *"Session &lt;ID&gt; begins now"* … *"Session &lt;ID&gt; ends now."* It is the only way to')
A('   prove a transcript belongs to the audio you think it does.')
A('4. **Capture evidence as you go**, not afterwards. For every P0: session ID, account, device')
A('   ID, app/firmware version, timestamps, screenshots or video, local vs server duration and')
A('   size, request IDs, and a transcript screenshot.')
A('5. **Stop and preserve state on a P0 failure.** Do not retry, reboot, or delete — the state')
A('   at the moment of failure is the evidence.')
A('')
A('### What counts as a release blocker')
A('')
A('Any of: data loss, corruption, cross-user exposure, wrong patient/session association, an')
A('unrecoverable P0 workflow, a duplicate canonical session, or a **false Completed status**.')
A('')
A('### Before you touch a device')
A('')
A('Run `sate infra` (in `hwtest/`) to confirm every tier is up — auth, database, `device-api`')
A('including the v15 verify route, Storage, the Cloudflare worker, the AI queue, and device')
A('heartbeat. Half of a failed test run is usually a service that was already down.')
A('`sate pipeline` gives a live animated view of a session moving through the pipeline, which')
A('is the fastest way to see *where* something stopped.')
A('')

# ---- environment -----------------------------------------------------------
A('## What you need')
A('')
A('| | |')
A('|---|---|')
A('| **Accounts** | User A and User B, both clinician/editor, each owning their own sessions. A viewer and an admin account if those roles exist. |')
A('| **Recorders** | R1 and R2. Record serial, firmware version, assigned account, battery health, storage capacity. |')
A('| **BLE devices** | Two clearly labelled physical devices with known IDs. Test alone and in a crowded room. |')
A('| **Phones** | Oldest supported iPhone, current iPhone, low-end supported Android, current Android flagship. |')
A('| **Browsers** | Chrome, Edge, Safari — record exact versions and OS. |')
A('| **Networks** | Stable Wi-Fi · fully offline · Wi-Fi with no internet · captive portal · weak/flapping · switching networks mid-upload. |')
A('| **Audio** | 15 s minimum-boundary · 2–5 min standard · silent (room tone) · noisy multi-speaker · 30/45/60 min with markers every 10 min · special-character/Unicode script. |')
A('')

# ---- blocking requirements -------------------------------------------------
A('## Settle these first')
A('')
A('These ten requirements are undecided. Cases that depend on them can be executed, but record')
A('the observed behaviour rather than marking pass/fail.')
A('')
A('| ID | Topic | What has to be decided |')
A('|---|---|---|')
BLOCKERS = [
    ('RQ-05', 'Audio integrity tolerance', 'Checksum method and acceptable duration difference between local and server audio.'),
    ('RQ-06', 'Interrupted recording policy', 'Recommended: preserve captured audio as an Interrupted session — never silently discard, never mark Completed.'),
    ('RQ-07', 'Minimum and maximum duration', 'Minimum accepted length, maximum supported duration, warning timing, behaviour at the limit.'),
    ('RQ-09', 'Upload resume strategy', 'Resumable/chunked vs full restart, incomplete-object cleanup, backoff, concurrent-retry prevention.'),
    ('RQ-11', '5xx/timeout retry policy', 'Three attempts is implemented; confirm attempt counting, timeout classification, backoff, jitter, late responses.'),
    ('RQ-12', '4xx handling', 'Which 4xx classes are retryable, and what the user is told to do.'),
    ('RQ-13', 'Manual retry/reprocess', 'Who may retry, when, whether audio is re-uploaded, how attempts are versioned.'),
    ('RQ-15', 'Transcript editing and versioning', 'Is the web app read-only or editable? Original AI result retention, conflict handling, audit trail.'),
    ('RQ-20', 'Performance and reliability SLA', 'Acceptable upload/processing/PDF times, resource use, retry limits, maximum stuck-state duration.'),
    ('RQ-21', 'Direct Wi-Fi vs mobile path', 'Which recordings use each path, whether both may run for one recording, and the dedup rule.'),
]
for rid, topic, what in BLOCKERS:
    A(f'| `{rid}` | {topic} | {what} |')
A('')
A('> **RQ-21 is the one to settle before testing `SATE-QUE-006`.** Two delivery paths exist')
A('> today and deduplication rests on a probe with no database constraint behind it. See that')
A('> case\'s server note.')
A('')

# ---- index -----------------------------------------------------------------
A('## Index')
A('')
A('| Category | Cases | P0 |')
A('|---|---|---|')
by_cat = {c: [x for x in CASES if x['Category'] == c] for c in CATEGORY_ORDER}
for cat in CATEGORY_ORDER:
    cs = [x for x in by_cat[cat] if running(x['TC ID'])]
    p0 = sum(1 for x in cs if x['Priority'] == 'P0')
    dfr = len(by_cat[cat]) - len(cs)
    anchor = cat.lower().replace(',', '').replace(' ', '-')
    label = f'| [{cat}](#{anchor}) | {len(cs)} | {p0} |'
    if dfr:
        label = label[:-1] + f' *(+{dfr} deferred)* |'
    A(label)
A(f'| **Total running** | **{len(_run)}** | **{_rp0}** |')
A('')
A('## Who runs what')
A('')
A('Every case is classified by **who can execute it and decide the outcome** — not by which')
A('components the code touches. That distinction matters for scheduling: a "Both" case needs')
A('two people in the room, or one person holding both kinds of access.')
A('')
A('| | Cases | P0 | Meaning |')
A('|---|---|---|---|')
_sc = {k: sum(1 for c in CASES if SIDE[c['TC ID']] == k) for k in ('End User', 'Both', 'Server Side')}
_p0 = {k: sum(1 for c in CASES if SIDE[c['TC ID']] == k and c['Priority'] == 'P0')
       for k in ('End User', 'Both', 'Server Side')}
A(f'| 🧑 **End-user** | {_sc["End User"]} | {_p0["End User"]} | A tester with a recorder, a phone and a browser runs it and decides pass/fail unaided. No database, no logs, no shell. |')
A(f'| 🧑🖥 **Both** | {_sc["Both"]} | {_p0["Both"]} | The user performs the action, but the pass criteria cannot be confirmed without a server check. |')
A(f'| 🖥 **Server-side** | {_sc["Server Side"]} | {_p0["Server Side"]} | Cannot be run or judged from the UI. Needs fault injection, queue inspection, or direct API calls. |')
A('')
A('So a tester working alone can execute **' + str(_sc['End User'] + _sc['Both']) + ' cases** but can only')
A('*close out* ' + str(_sc['End User']) + ' of them. The other ' + str(_sc['Both']) + ' wait on an engineer.')
A('')
A('### The end-user set')
A('')
for _cat in CATEGORY_ORDER:
    _ids = [c['TC ID'] for c in CASES if c['Category'] == _cat and SIDE[c['TC ID']] == 'End User']
    if _ids:
        A(f'- **{_cat}** — ' + ', '.join(f'`{i}`' for i in _ids))
A('')
A('### The server-side set')
A('')
for _cat in CATEGORY_ORDER:
    _ids = [c['TC ID'] for c in CASES if c['Category'] == _cat and SIDE[c['TC ID']] == 'Server Side']
    if _ids:
        A(f'- **{_cat}** — ' + ', '.join(f'`{i}`' for i in _ids))
A('')
A('Everything not listed above is **Both**.')
A('')

# ---- the cases -------------------------------------------------------------
for cat in CATEGORY_ORDER:
    A('---')
    A('')
    A(f'## {cat}')
    A('')
    for c in by_cat[cat]:
        tid = c['TC ID']
        A(f'### {tid} · {c["Test Case Title"]}')
        A('')
        reqs = ', '.join(f'`{r.strip()}`' for r in c['Requirement IDs'].split(',') if r.strip())
        unsettled = [r.strip() for r in c['Requirement IDs'].split(',') if r.strip() in UNSETTLED]
        if not running(tid):
            A(f'> ⏸ **Deferred — {scope_of(tid).replace("Deferred - ", "")} is not in scope for this run.**')
            A('>')
            A('> ' + (scope_note(tid) or 'Not part of the current pass. Parked, not deleted.'))
            A('')
        elif scope_of(tid) == 'In scope (reduced)':
            A(f'> ✂️ **Reduced scope.** {scope_note(tid)}')
            A('')
        elif scope_note(tid):
            A(f'> ▶ {scope_note(tid)}')
            A('')
        badge = {'End User': '🧑 **End-user test**', 'Server Side': '🖥 **Server-side test**',
                 'Both': '🧑🖥 **End-user + server-side**'}[SIDE[tid]]
        A(f'{badge} · run by **{RUN_BY[SIDE[tid]]}** · {c["Priority"]} · {c["Test Type"]} · {reqs}')
        A('')
        A(f'*Needs:* {access_for(tid)}')
        A('')
        if SIDE[tid] == 'Server Side':
            A(f'*What the end user does:* {USER_ACTION.get(tid, "Nothing — this runs entirely from the backend.")}')
            A('')
        A(f'**Goal.** {clean(c["Objective"])}')
        A('')
        if clean(c['Preconditions']):
            A(f'**Before you start.** {clean(c["Preconditions"])}')
            A('')
        if clean(c['Test Data / Environment']):
            A(f'**Use.** {clean(c["Test Data / Environment"])}')
            A('')
        A('**Do this**')
        A('')
        for i, s in enumerate(steps(c['Test Steps']), 1):
            A(f'{i}. {s}')
        A('')
        A('**You should see**')
        A('')
        A(wrap(clean(c['Expected Device / App / Web Result'])))
        A('')
        A('**Check before you call it passed**')
        A('')
        A(wrap(clean(c['Data Integrity / Validation'])))
        A('')
        A(f'**Passed if.** {clean(c["Pass Criteria"])}')
        A('')
        if unsettled:
            A(f'> ⚠️ Depends on undecided requirement(s) {", ".join(f"`{r}`" for r in unsettled)} —')
            A('> record the observed behaviour instead of pass/fail until they are settled.')
            A('')
        note = SERVER.get(tid, '').strip()
        if note:
            A('> **Server side.**')
            for para in note.split('\n\n'):
                body = ' '.join(l.strip() for l in para.strip().split('\n') if l.strip())
                if not body:
                    continue
                A('>')
                for l in textwrap.wrap(body, 92):
                    A(f'> {l}')
        else:
            A('> **Server side.** ' + clean(c['Expected Backend / Data Result']))
        A('')
        A(f'| Result | | Evidence |')
        A(f'|---|---|---|')
        A(f'| ☐ Pass ☐ Fail ☐ Blocked | Defect: __________ | Session ID: __________ |')
        A('')

# ---- known defects ---------------------------------------------------------
A('---')
A('')
A('## Known defects that will affect this run')
A('')
A('Found in the 2026-07-22 audit and still open. If a case fails on one of these, it is a known')
A('item — reference it rather than filing a duplicate.')
A('')
A('| Affects | What | Severity |')
A('|---|---|---|')
A('| `SATE-SEC-005` | `POST /firmware` (publishFirmware) is routed **above** the `/admin` gate, so any authenticated user can push fleet-wide OTA. Image validation exists (semver, `0xE9` magic, size cap) but no `isAdmin()` check. Same in the Cloudflare port. | Fix before GA |')
A('| `SATE-BE-008` | The `process-device-session` copy **in this repo** is not the no-op that production runs — it still downloads the WAV, awaits the AI and inserts `recordings`, so deploying it would duplicate every recording and re-introduce the 150 s edge-kill hang. | Do not deploy repo file |')
A('| `SATE-E2E-006`, `SATE-QUE-006` | Upload deduplication relies on a probe by (user, serial, patient, session_number, bytes) + `objectExists`, with **no database unique constraint** behind it. | Add constraint |')
A('| `SATE-LONG-002/003` | Storage\'s project-wide file size limit overrides the bucket\'s and defaults to 50 MB; a full-length take is ~118 MB. Currently set to 500 MB — verify before long-session runs. | Config check |')
A('')

# ---- server appendix -------------------------------------------------------
A('---')
A('')
A('## Appendix — server-side quick reference')
A('')
A('### The state machine')
A('')
A('```')
A('sate_device_sessions.status:  queued → processing → done | error')
A('')
A('  queued        new rows default here (column default — device-api needs no change to enqueue)')
A('  processing    claim_next_session(p_worker) — atomic, FOR UPDATE SKIP LOCKED')
A('                stamps processing_started_at, worker_id, heartbeat_at')
A('  done          finalize-session wrote the recordings row (or no_text with none)')
A('  error         permanent failure, or transient past MAX_ATTEMPTS')
A('```')
A('')
A('| Constant | Value | Where |')
A('|---|---|---|')
A('| `MAX_ATTEMPTS` | 3 | cf-processor |')
A('| `STUCK_MINUTES` | 45 | watchdog reclaim cutoff |')
A('| `POLL_INTERVAL` | 10 s | empty-queue poll |')
A('| `AI_READ_TIMEOUT_S` | 3600 s | longer than the stale cutoff — see `SATE-LONG-003` |')
A('| `MIN_AUDIO_SEC` | 0.4 s | below this → `no_text`, AI never called |')
A('| `KEEP_AUDIO_SESSIONS` | 5 | newest N takes keep their SD audio |')
A('')
A('### Routes worth knowing during a test run')
A('')
A('| Route | Auth | Notes |')
A('|---|---|---|')
A('| `POST /api/sessions` · `/chunk` · `/raw` | device key | Chunked slices land as `_tmp/<patient>/s<n>/<offset>.part`, stitched on final |')
A('| `GET /api/sessions/verify` | device key | ≥v15. `stored:true` only when row **and** object exist. Read-only — never make it mutate |')
A('| `GET /api/sessions/upload-progress` | user JWT | ≥v16. Live bytes of an in-flight upload |')
A('| `POST /api/sessions/:id/retry` | user JWT | ≥v14. Accepts **only** a session in `error` |')
A('| `GET /api/devices/:id/commands` | device key | Heartbeat + command poll |')
A('| `GET /api/health/alerts` | shared secret | Error digest the 5-minute status worker emails from |')
A('')
A('### Three rules that must not be broken while fixing anything found here')
A('')
A('1. **Never move the AI call into an edge function or a Worker.** Supabase edge has a hard')
A('   ~150 s wall-clock; a plain Worker has a ~100 s origin timeout. Both kill the request')
A('   *mid-fetch, before any catch block*, so no error is ever recorded and the session hangs in')
A('   `processing` forever. The long call must stay in the container.')
A('2. **`device-api` and `mint-plaud-token` must deploy `verify_jwt:false`.** They validate')
A('   tokens themselves. The CLI/MCP default of `true` breaks recorder registration and Plaud')
A('   token minting, and presents as an auth bug.')
A('3. **Never free device audio on a `.synced` marker alone.** A marker means "a POST returned')
A('   2xx", not "the audio is durably stored" — that gap is what the 413 ghosts exploited. The')
A('   verify gate (row + `objectExists`) is what makes reclaim safe.')
A('')

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text('\n'.join(lines) + '\n')
print(f'wrote {OUT} — {len(lines)} lines, {len(CASES)} cases')
