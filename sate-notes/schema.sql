-- SATE Notes — D1 schema.
--
-- Vocabulary note: the WIRE protocol still says `patient_id`, because that is what the
-- firmware stamps on every take (SD path -> upload query -> verify query, four layers that
-- must agree byte-for-byte). Renaming it on the wire would mean a firmware change and would
-- break /api/sessions/verify. So the wire keeps `patient_id`; this schema calls the same
-- string a `folder_id`, and the mapping happens once, at the edge, in src/device.ts.
--
-- There is no RLS in D1. Every query in this service MUST be scoped by user_id in its WHERE
-- clause — that is the only tenant boundary that exists. See cloudflare/README.md §1.

-- ⚠️ THERE IS NO users TABLE HERE, AND THERE MUST NOT BE ONE.
--
-- Identity belongs to Supabase: a user signs into the SATE web app exactly as before, and this
-- service verifies that session (src/auth.ts) rather than keeping its own copy. `user_id`
-- below is the Supabase `auth.users` uuid, stored as a plain string with NO foreign key —
-- there is nothing here to point at, by design.
--
-- This service did start with a local users table, back when it was a standalone product. It
-- had to go: it made every row depend on a shadow copy of identity that nothing kept in step,
-- and the first real Supabase login failed on its foreign key.

-- A one-shot code typed into the provisioning flow. Minted by an admin route; burned by
-- /api/devices/register. This is how a device is bound to an account.
CREATE TABLE claim_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,                    -- Supabase auth.users uuid
  user_name  TEXT NOT NULL DEFAULT '',
  used       INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX claim_tokens_user_idx ON claim_tokens (user_id);

CREATE TABLE devices (
  id               TEXT PRIMARY KEY,           -- dev-<serial lowercased>
  user_id          TEXT NOT NULL,               -- Supabase auth.users uuid
  name             TEXT NOT NULL DEFAULT '',
  serial           TEXT NOT NULL,
  fw               TEXT NOT NULL DEFAULT '',
  online           INTEGER NOT NULL DEFAULT 0 CHECK (online IN (0,1)),
  ip               TEXT,
  last_seen        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  pending_sessions INTEGER NOT NULL DEFAULT 0,
  state            TEXT NOT NULL DEFAULT 'idle',
  ota_state        TEXT,
  battery_pct      INTEGER,
  battery_mv       INTEGER,
  total_recordings INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX devices_user_idx   ON devices (user_id);
CREATE INDEX devices_serial_idx ON devices (serial);

CREATE TABLE device_commands (
  id         TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  op         TEXT NOT NULL,
  payload    TEXT,                             -- json; also carries the OTA {url,version}
  consumed   INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX device_commands_poll_idx ON device_commands (device_id, consumed, created_at);

-- The device roster. The firmware calls this the "patient list" and renders `name` on Home;
-- here it is a folder ("Voice Notes", "Work", "Ideas"). GET /api/patients serves it verbatim
-- in the firmware's expected shape.
CREATE TABLE folders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,                    -- Supabase auth.users uuid
  folder_id  TEXT NOT NULL,                    -- the string the device stamps on every take
  name       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX folders_unique_idx ON folders (user_id, folder_id);

-- One uploaded recording, and its place in the pipeline.
--
-- status is the state machine: queued -> transcribing -> summarizing -> done | error.
-- It exists for the same reason the clinical lane's does: a long AI call cannot be awaited
-- inside the request that accepts the upload, so the upload only enqueues.
CREATE TABLE notes (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,                 -- Supabase auth.users uuid
  device_serial TEXT NOT NULL,
  folder_id     TEXT NOT NULL DEFAULT 'notes',
  session_number INTEGER NOT NULL DEFAULT 0,
  sample_rate   INTEGER NOT NULL DEFAULT 16000,
  bytes         INTEGER NOT NULL DEFAULT 0,
  duration_s    REAL,
  storage_key   TEXT,
  flags         TEXT,                          -- json array of ms offsets (the flag button)
  title         TEXT,                          -- written by the summariser
  status        TEXT NOT NULL DEFAULT 'queued',
  -- Real transcription progress, so the UI can show a bar that means something. The work is
  -- one AI call per audio chunk, so "chunk 3 of 7" is a fact the pipeline already knows — it
  -- just never wrote it down, and the page had nothing to show but a static line of text that
  -- is indistinguishable from a hang.
  chunks_done   INTEGER NOT NULL DEFAULT 0,
  chunks_total  INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT,
  error         TEXT,
  -- The sate_device_sessions id this note came from, when it arrived via the clinical
  -- device-api rather than being uploaded here directly. It is the idempotency key for that
  -- path: device-api fires and forgets, so a retry must not create a second note.
  source_id     TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX notes_source_idx ON notes (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX notes_user_idx   ON notes (user_id, created_at);
CREATE INDEX notes_status_idx ON notes (status, created_at);
-- The uploader's idempotency probe looks a take up by exactly this triple. Unlike the
-- clinical lane (which has no unique backstop and says so in CLAUDE.md), enforce it here:
-- a re-uploaded take after a lost ACK must not become a second note.
CREATE UNIQUE INDEX notes_take_idx ON notes (device_serial, folder_id, session_number, bytes);

-- Transcript is computed ONCE and is the expensive artifact (~96% of per-hour cost).
CREATE TABLE transcripts (
  note_id    TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  lang       TEXT,
  text       TEXT NOT NULL DEFAULT '',
  segments   TEXT NOT NULL DEFAULT '[]',       -- json: [{start,end,text}], global timeline
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Summaries are cheap and re-runnable, so they are keyed by (note, template, model) rather
-- than folded into the transcript. Re-summarising with a different template must never
-- re-transcribe: that would cost ~25x for no reason, and "summarise this another way" is the
-- single thing users poke at most.
CREATE TABLE summaries (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  template   TEXT NOT NULL DEFAULT 'meeting',
  model      TEXT NOT NULL DEFAULT '',
  json       TEXT NOT NULL DEFAULT '{}',       -- {title,tldr,bullets[],actions[],chapters[],highlights[]}
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX summaries_unique_idx ON summaries (note_id, template, model);

-- OTA. Separate from the clinical fleet's sate_firmware ON PURPOSE: getLatestFirmware there
-- has no product filter, so one shared table would push a notes build to every clinical
-- recorder on its next update check.
CREATE TABLE firmware (
  id         TEXT PRIMARY KEY,
  version    TEXT NOT NULL,
  url        TEXT NOT NULL,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX firmware_created_idx ON firmware (created_at);

-- ---------------------------------------------------------------------------------------
-- Who may use the notes feature, and in which mode. Set by an admin, never self-service.
--
-- An account with NO row here has no access. That default matters: adding this service to the
-- stack must not change what any existing clinical user sees, so the feature is off for
-- everyone until it is deliberately turned on.
--
-- user_id is the SUPABASE auth.users uuid — the same identity the clinical app uses. There is
-- no user table here on purpose; identity has exactly one owner.
-- ---------------------------------------------------------------------------------------
CREATE TABLE account_access (
  user_id    TEXT PRIMARY KEY,
  email      TEXT NOT NULL DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  mode       TEXT NOT NULL DEFAULT 'notes',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX account_access_email_idx ON account_access (lower(email));

-- Admins of THIS lane, by email. Deliberately separate from the clinical `sate_admins`:
-- this service cannot read that table, and an admin here grants nothing over patient data.
CREATE TABLE notes_admins (
  email      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------------------
-- "I deleted this note on purpose."
--
-- Deleting a note for a recent recording is not enough on its own: the Devices page generates
-- a note automatically for anything recorded in the last 24 hours, so the note would reappear
-- within seconds and delete would look broken. A deletion is an intention, and it has to
-- outlive the row it deleted.
--
-- Explicitly asking for a note again (the button on the session's own row) clears the entry —
-- the user changed their mind, which is also an intention.
-- ---------------------------------------------------------------------------------------
CREATE TABLE note_optouts (
  user_id    TEXT NOT NULL,
  source_id  TEXT NOT NULL,          -- the sate_device_sessions id the note came from
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, source_id)
);
