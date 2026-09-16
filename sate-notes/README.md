# SATE Notes — the consumer lane

A second backend for the **same recorder, the same firmware, the same image**. A device joins
this lane by being provisioned with `cfgServer` pointing here instead of at the clinical
backend. Nothing on the device says "notes"; nothing here knows what a patient is.

```
Recorder ──register / heartbeat / commands / sessions/chunk / sessions/verify──► Worker
                                                                                  │
                                          D1 (devices, notes, transcripts, summaries)
                                          R2 (audio + in-flight chunk parts)
                                          Workflow: chunk → Whisper → LLM → done
                                          Workers AI (ASR + summary)
```

Full Cloudflare. No Supabase, no ngrok, no self-hosted GPU, and **no shared AI capacity with
the clinic** — a consumer backlog can never make a clinician's recording wait.

## Why a Workflow and not a `fetch` handler

A long transcription cannot be awaited inside a serverless request: a Supabase edge function
dies at ~150 s and a plain Worker at the ~100 s origin timeout — mid-`fetch`, **before any
catch block runs** — so the job strands with no error ever written. The clinical lane learned
this expensively and solved it with a long-lived container. Workflows are the Cloudflare-native
answer: durable execution, per-step retries, no wall-clock ceiling. One `step.do` per audio
chunk, so a chunk that fails is retried alone and the ones that succeeded are never re-billed.

## Cost (Workers AI list prices, 2026-09)

| | per audio hour |
|---|---|
| `@cf/openai/whisper-large-v3-turbo` — $0.00051/min | **$0.031** (~96%) |
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` — ~12k in / 2k out | **$0.0013** (~4%) |
| total | **~$0.032** |

The transcript is the expensive artifact, so it is computed **once** and stored; summaries live
in their own table keyed by `(note, template, model)`, so "summarise this another way" is nearly
free and never re-transcribes. Upgrading the summary model costs less than the ASR it
rides on — never trade summary quality for money here.

**Cloudflare-hosted models only.** Not a preference, a constraint: no third-party inference
API, so there is no key to rotate, no second vendor to be down, and no audio or transcript
leaving the account. It is enforced in code (`assertCloudflareModel`), not just documented — a
model id is a config string and config drifts. Anything that is not `@cf/…` fails the job
loudly. Room to move within that:

| model | in / out per M tokens | ~cost per audio hour | note |
|---|---|---|---|
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | $0.045 / $0.384 | $0.0013 | current default |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | $0.29 / $2.25 | ~$0.008 | 24k context — enough for ~1.5 h of transcript |
| `@cf/openai/gpt-oss-120b`, `@cf/zai-org/glm-4.7-flash` | see the models page | — | reasoning / 131k context |

Even the 70B is a quarter of what Whisper costs for the same recording, so quality is the only
thing worth optimising here.

## Deploy

```bash
npx wrangler d1 create sate-notes              # paste the id into wrangler.toml
npx wrangler r2 bucket create sate-notes-audio
npx wrangler d1 execute sate-notes --remote --file=./schema.sql
npx wrangler secret put ADMIN_KEY
npx wrangler deploy
```

## Demo: point a recorder at this lane

```bash
BASE=https://sate-notes.<subdomain>.workers.dev
ADMIN='Authorization: Bearer <ADMIN_KEY>'

# 1. an account, and a one-shot claim code
UID=$(curl -s -X POST $BASE/admin/users -H "$ADMIN" -H 'Content-Type: application/json' \
      -d '{"email":"you@example.com","name":"You"}' | jq -r .id)
TOK=$(curl -s -X POST $BASE/admin/claim-tokens -H "$ADMIN" -H 'Content-Type: application/json' \
      -d "{\"user_id\":\"$UID\"}" | jq -r .token)

# 2. provision the recorder over BLE (from the repo root)
cd ../hwtest && ./sate provision --server $BASE --claim-token $TOK

# 3. name the folders the device shows on Home
curl -X PUT $BASE/admin/folders -H "$ADMIN" -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"$UID\",\"folders\":[{\"folder_id\":\"notes\",\"name\":\"Voice Notes\"}]}"

# 4. press record. Then:
curl -s "$BASE/api/notes?user_id=$UID" -H "$ADMIN" | jq
```

## How a recording becomes a note

A recorder speaks to exactly ONE server, so "this device is a notes device" cannot be a
property of the device. Rather than reroute the upload — the one path in this system that has
already destroyed a recording when it was got wrong — the note is made **on demand, from a
recording the clinical stack already stored**:

```
Devices tab → a Ready session → [Meeting note]
   └─ POST /api/notes/from-session { session_id }        (the user's own Supabase token)
        └─ Worker asks device-api for that session's audio, WITH THAT SAME TOKEN
             └─ stream into R2 → chunk → Whisper → LLM → note
```

Nothing about the original recording changes: same clinical pipeline, same `recordings` row,
same report. The note is an additional artifact made from a copy of the audio.

Three properties worth keeping:

- **No URL comes from the browser.** The Worker fetches the audio from device-api using the
  caller's own access token, so ownership is enforced by the system that owns the recording and
  this service never holds a credential that could reach the clinical bucket at large. (The
  machine route still accepts a pre-signed URL, pinned to the project's storage host, because
  there is no user token in that direction.)
- **The copy is streamed, and its length comes from the RESPONSE.** A full-length take is
  ~118 MB against a 128 MB Worker limit, and a byte count supplied by a browser would truncate
  or stall the copy.
- **Idempotent on the session id, checked before a byte moves.** A second click returns the
  existing note rather than re-copying 118 MB and starting a second AI run.

### "No text in audio" gets no button

The clinical pipeline already decides whether a recording contains speech. A session it marked
`no_text` is not offered a meeting note, because there is nothing to summarise and the model
will confabulate rather than say so — a 6-minute silent take came back as
*"The car is a good one"*, repeatedly, and then a tidy meeting summary built on top of it.

### Not padding a thin recording

An 11-second clip containing four half-sentences produced nine key points, three action items,
and chapters at **0:30 and 0:50** — markers past the end of the audio, which is the clearest
possible proof of fabrication. Three fixes, at three levels:

1. **The prompt asks for the wrong thing.** "3-8 bullets" forces padding when little was said.
   It now says fewer is correct, `[]` is a valid answer, and actions are only for something
   someone actually committed to.
2. **The model was not told how long the recording is.** It is now given the length and word
   count, and told a short fragment has no chapters.
3. **The output is checked against what we know.** `sanitise()` drops any chapter at or past
   the end of the audio, drops chapters entirely below 60 s or 60 words, and trims a fragment
   to at most two bullets. A prompt is guidance; this is the floor.

Same 11-second clip after: 2 bullets, both quoting what was actually said, 0 actions,
0 chapters, and a tl;dr that admits it is a short discussion.

## The note page layout

Shaped after Plaud, rendered in SATE's own language (gray-50 page, white rounded-2xl cards,
blue-600, the app's Button):

- **Player on top**, full-width scrubber over a centred transport — ±15 s, play, speed. Audio
  you read along with wants a wide thing to scrub and controls beneath it, not a player wedged
  between the title and the content.
- **Summary / Transcript as tabs.** Stacking them put the summary — the thing this feature
  exists to produce — below the fold on any recording past a minute.
- **Chapters near the top** of the summary: they are navigation, so they sit where you reach
  for them. Key points on the left, action items and highlights on the right; on a short
  recording that right column is simply absent rather than padded.
- **The transcript follows the audio**: the spoken line highlights and scrolls itself into
  view, and clicking any line seeks there.

⚠️ **The follow-along anchors to the last segment that has STARTED, not the segment containing
the playhead.** Matching "the segment containing t" looks correct and is not: a speaker drawing
breath leaves a sub-second hole between segments — this recording has seven of them — and for
that second nothing is highlighted at all. On a real recording it happens every few sentences
and reads as the feature being broken.

## The two pages

Both are served by the Worker itself — no second deploy, no CDN, no build step.

| | | |
|---|---|---|
| `/` | **Reader** | Ops-only twin of the in-app page. The product UI is `/notes` inside the SATE app. |
| `/console` | **Console** | The server side: devices, folders, recordings. |

### What the console can do

- **Devices** — online/offline, state, firmware, battery, last seen; queue `record`, `stop`,
  `sync_now`, `reboot`. Buttons disable themselves when a device is offline, because a queued
  command for an absent device just sits there.
- **Folders** — edit the roster the recorder shows on its Home screen and stamps on every take.
  Saving also pushes `reload_patients` to every device on the account: without that the card
  shows the new roster and the device still shows the old one until its next reboot.
- **Recordings** — status, errors, and three actions:
  - **Re-summarise** with a different template (`meeting` / `lecture` / `interview` / `idea`).
    Runs from the STORED transcript — one cheap LLM call, never re-transcribes. Verified: a
    second template left the note with 2 summary rows and still exactly 1 transcript row.
  - **Retry** — re-runs the whole pipeline including ASR. For a genuinely bad transcript.
  - **Delete** — row plus the audio in R2, behind a confirm.

### Management API (all `Authorization: Bearer <ADMIN_KEY>`)

```
POST   /admin/users                      {email,name}            → create an account
POST   /admin/claim-tokens               {user_id}               → one-shot device claim code
GET    /admin/devices                                            → fleet + telemetry
POST   /admin/devices/:id/commands       {op,payload?}           → record|stop|sync_now|reboot|ota…
GET    /admin/folders?user_id=
PUT    /admin/folders                    {user_id,folders[]}     → replace the roster
GET    /admin/models                                             → active models + templates
POST   /admin/notes/:id/summarize        {template,model?}       → re-summarise, no re-ASR
POST   /admin/notes/:id/retry                                    → full re-run
DELETE /admin/notes/:id
GET    /api/notes?user_id=  ·  GET /api/notes/:id                → what the reader reads
```

## The firmware change (done — fw 1.5.34)

`connectivity.cpp` decides **TLS by hostname substring**, not by scheme:

```c
// connectivity.cpp:118
static inline bool serverIsSupabase() { return strstr(cfgServer, "supabase.co") != nullptr; }
```

It is used for three different TLS decisions — the command poll (`:1202`), the chunk upload
(`:1282`) and registration (`:2143`) — so a device pointed at an `https://…workers.dev` host
builds plain-HTTP requests against port 443 and fails. (OTA at `:2538` is already scheme-based
and needs nothing.)

The one predicate is now two (fw **1.5.34**):

- `urlIsTls(url)` / `serverIsTls()` → `strncmp(url, "https", 5) == 0` — the three TLS decisions
- `serverIsSupabase()` → the substring check, used **only** to add the `apikey` header

Compiles clean (52% of the app slot, dual-OTA `default_8MB`). `sate ci` was run on real
hardware; see the gate note below. There is a second, unrelated `supabase.co` check in the mobile app
(`src/screens/ProvisionScreen.tsx:87`) which skips claim-token minting for a non-Supabase
server — irrelevant while provisioning from the `sate` CLI, which passes the token explicitly.

## Verified

Simulated a full recorder session against `wrangler dev` (real Workers AI), then drove the
reader in a real browser:

- register → heartbeat (the firmware's exact query string) → roster → 2-slice chunked upload
- the stored WAV is **byte-identical** to the uploaded one, header patched to the real total
- `GET /api/sessions/verify` answers `stored:true` only for the exact byte count
- a re-sent final slice (a lost ACK) returns `idempotent:true` instead of a duplicate note
- the Workflow ran Whisper then the LLM and wrote a structured summary; the flag-button
  offsets came through into `highlights`
- a 0.2 s take finishes `done` with **no transcript row** — the model is never called
- the audio route serves 200 / 206 / 416 correctly; a signed token for another note, or a
  tampered one, is refused with 401
- the reader lists, opens, and renders summary + transcript + flag ticks

### Bugs the simulation caught, all fixed here

1. **R2 refuses a stream of unknown length.** `env.BUCKET.put(key, readableStream)` fails with
   *"Provided readable stream must have a known length"*. The assembled WAV now goes through a
   `FixedLengthStream`, pumped concurrently with the `put`.
   **The clinical Cloudflare port had the same bug** — `cloudflare/src/functions/deviceApi.ts`
   passed a bare `ReadableStream` to `putObject`, so the final slice of every chunked upload
   would have failed there. Fixed in that file too (typecheck + its 21 policy tests pass).
2. **Workers AI `response` is not always a string.** Assuming it was threw
   `raw.replace is not a function`; the Workflow retried forever and the note sat in
   `summarizing` with no error to point at. `parseSummary` now takes `unknown`.
3. **An `<audio>` element cannot send an Authorization header.** The audio route was behind the
   same bearer gate as the JSON API, so the player could never load anything. It now takes a
   short-lived HMAC token, signed over `(note id, expiry)`, handed to the page in `audio_url` —
   the same shape as the signed URLs in `cloudflare/src/storage.ts`. Putting the admin key in
   the query string instead would have leaked a credential into history and logs.
4. **A re-signed URL restarted playback every poll.** `audio_url` carries a fresh token each
   fetch, so comparing URLs to decide whether to reload the media re-ran `load()` on every 4 s
   refresh: playback aborted, playhead back to 0:00, and `open()` threw before rendering —
   which looked like the note refusing to open. Compare the note id, not the URL.
5. **The list swallowed clicks while anything was processing.** It rebuilt itself with
   `replaceChildren()` on every 4 s poll, destroying the row under the cursor. Rows are now
   keyed by note id and updated in place.
6. **A 206 with no `Content-Length` stalls Chrome's media loader** (`fetch()` was perfectly
   happy with it). Set on every partial response.

### Two things to know when demoing

- **Whisper hallucinates on non-speech audio.** Handed a pure tone it returned "Thank you."
  with full confidence. That is why the short-take guard runs *before* the model — an
  empty-text check afterwards would not have caught it.
- **Playback cannot be verified from an automated browser.** Chrome defers media loading in a
  hidden tab (`document.visibilityState === "hidden"`), so `<audio>` never issues the request
  and sits at `readyState 0` with no error. The endpoint itself is verified by direct requests
  and by a page-side `fetch()`; the player needs a real, visible window to confirm.

## The CI gate: PASSED (7/7) on fw 1.5.34

`hwtest/ci-reports/fw-1.5.34_20260901-130539.json` — boot health, reboot-resume, byte-exact
upload, verified trim, idle reclaim, unconfirmed-keep, and standalone-default all pass on a
real recorder. OK to release.

Getting there took three runs and a control, and the detour is worth recording because none of
it was the firmware:

1. **First run, 3 failures.** All three were the network-dependent tests. A control run with
   this change reverted failed *exactly the same three*, which is what ruled the change out:

   | | boot | resume | byte_match | verified trim | unconfirmed-keep | reclaim | roster |
   |---|---|---|---|---|---|---|---|
   | 1.5.34 | PASS | FAIL | FAIL | PASS | PASS | FAIL | SKIP |
   | 1.5.33 (control) | PASS | FAIL | FAIL | PASS | PASS | FAIL | SKIP |

2. **`hwtest/config.toml` named the wrong board** — `SATE-4219B8` while the attached unit is
   `SATE-443EAC`, so every remote command 404'd and the suite fell back to serial resets and
   prompts. Corrected (original at `config.toml.bak`).
3. **The recorder could not see its AP** (`reason=201`, no `esc-router-2g` in range). A BLE
   `scan_wifi` from the device itself listed what it *could* see, and `change_wifi` moved it
   across — keeping the account, never a re-claim.
4. **The new network was MAC-gated, which looks exactly like success.** It handed out a DHCP
   lease and then dropped every packet: the log said `Online (Wi-Fi) - 10.84.251.164` and the
   server's `last_seen` sat two weeks stale. That is why the boot log now prints the STA MAC
   next to the serial (`connectivity.cpp`, `[CONN] serial=… mac=…`) — on a device-registration
   network that one line is the whole diagnosis.

Once the MAC was registered the device reached Supabase on the next poll and the suite went
7/7 with no code change.

## Not done yet

- **Auth is demo-grade.** `ADMIN_KEY` is a single shared secret with no per-user scoping. Every
  query already carries `user_id`, so swapping in a real session model is a change of gate, not
  a rewrite — but do not put anything private behind this key meanwhile. D1 has no RLS: that
  `user_id` in the `WHERE` clause is the only tenant boundary that exists.
- No reader UI yet (the read API and range-seekable audio are there).
- No OTA publishing. The `firmware` table is deliberately separate from the clinical
  `sate_firmware`, whose `getLatestFirmware` has no product filter — one shared table would
  push a notes build to every clinical recorder on its next update check.
- Wrangler is pinned at v3 here (Workflows work; v4 emits a config warning).
