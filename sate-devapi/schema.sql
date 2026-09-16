-- SATE Developer API — D1 (SQLite) schema.
--
-- This service is STANDALONE. It shares nothing with the SATE clinical app except the
-- AI transcription box it calls. There is deliberately NO patient, no clinician, no
-- device, no recording, and no link to a SATE account anywhere in this schema. A
-- developer uploads audio; they get a transcript and a report back. That is the whole
-- product surface — do not add clinical entities here.
--
-- Conventions (same as cloudflare/schema.sql so the two read alike):
--   uuid        -> TEXT (crypto.randomUUID())
--   jsonb       -> TEXT (JSON text, parsed at the API boundary)
--   timestamptz -> TEXT (ISO-8601 UTC, lexically sortable — ORDER BY stays correct)
--   boolean     -> INTEGER 0/1, CHECK-constrained
-- now() -> strftime('%Y-%m-%dT%H:%M:%fZ','now')  (NOT CURRENT_TIMESTAMP — that yields a
-- space-separated, ms-less, Z-less string that Date.parse reads differently.)

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- developers — one row per human with portal access.
--
-- `status` is the access gate: a self-service request lands as 'pending' and can do
-- NOTHING until an admin approves it. `scopes` is the admin-assigned allowance — a
-- developer can only ever mint keys whose scopes are a subset of this.
-- ---------------------------------------------------------------------------
CREATE TABLE developers (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL,
  password_hash  TEXT,                       -- pbkdf2$<iters>$<salt_b64u>$<hash_b64u>
  name           TEXT NOT NULL DEFAULT '',
  org            TEXT NOT NULL DEFAULT '',
  use_case       TEXT NOT NULL DEFAULT '',   -- what they said they were building, at request time
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','active','suspended','rejected')),
  is_admin       INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
  -- Allowance the developer's keys may draw scopes from. JSON array of scope strings:
  -- 'transcript:read' | 'annotations:read' | 'report:read'.
  scopes         TEXT NOT NULL DEFAULT '["transcript:read","report:read"]',

  -- Audio budget. `quota_minutes` is the cap (0 = unlimited) and `quota_period` decides
  -- what it caps:
  --   'monthly' — minutes per calendar month, the usual plan-style allowance
  --   'total'   — minutes EVER, a hard lifetime ceiling that does not roll over
  -- `quota_reset_at` is the floor of the counting window. An admin pressing "reset usage"
  -- just moves it to now(), which zeroes the used figure without deleting a single usage
  -- row — the billing history stays intact and auditable either way.
  quota_minutes  INTEGER NOT NULL DEFAULT 120,
  quota_period   TEXT NOT NULL DEFAULT 'monthly' CHECK (quota_period IN ('monthly','total')),
  quota_reset_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- API lock. Distinct from `status`: a locked developer keeps their portal login (so they
  -- can read why they are locked and see their usage) but every /v1 call is refused. This
  -- is the "stop the traffic now, sort it out after" lever — no key revocation, no account
  -- deletion, instantly reversible.
  api_locked     INTEGER NOT NULL DEFAULT 0 CHECK (api_locked IN (0,1)),
  lock_reason    TEXT NOT NULL DEFAULT '',

  rate_per_min   INTEGER NOT NULL DEFAULT 20,   -- default ceiling for keys this developer mints
  max_keys       INTEGER NOT NULL DEFAULT 5,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_at    TEXT,
  approved_by    TEXT,
  last_login_at  TEXT,
  notes          TEXT NOT NULL DEFAULT ''      -- admin-only note, never exposed to the developer
);
CREATE UNIQUE INDEX developers_email_lower_idx ON developers (lower(email));
CREATE INDEX developers_status_idx ON developers (status);

-- Portal browser sessions (HttpOnly cookie). Distinct from API keys: a cookie can drive
-- the portal but can never call /v1.
CREATE TABLE portal_sessions (
  token        TEXT PRIMARY KEY,             -- sha256 of the cookie value, never the value
  developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT NOT NULL,
  user_agent   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX portal_sessions_dev_idx ON portal_sessions (developer_id);
CREATE INDEX portal_sessions_exp_idx ON portal_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- api_keys — what a developer creates for their own application.
--
-- The full key (sate_live_<32 chars>) is shown EXACTLY ONCE, at creation. Only its
-- SHA-256 is stored, so a database leak cannot be replayed against the API. `prefix`
-- is the first few characters, kept in the clear purely so the UI can say which key
-- is which.
-- ---------------------------------------------------------------------------
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT '',
  prefix       TEXT NOT NULL,                -- e.g. 'sate_live_9f3a2c' — display only
  key_hash     TEXT NOT NULL,                -- sha256 hex of the full key
  scopes       TEXT NOT NULL DEFAULT '[]',   -- JSON array; MUST be a subset of the developer's
  rate_per_min INTEGER NOT NULL DEFAULT 20,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE UNIQUE INDEX api_keys_hash_idx ON api_keys (key_hash);
CREATE INDEX api_keys_dev_idx ON api_keys (developer_id);

-- ---------------------------------------------------------------------------
-- jobs — one audio submission.
--
-- ⚠️ The AI transcription call CANNOT run inside a Worker (a Worker dies at the ~100 s
-- origin timeout; a long take can take an hour). So every submission is asynchronous:
-- the Worker only queues here, and a long-lived container claims and processes. Never
-- "simplify" this into a synchronous fetch — that is the single most expensive lesson
-- in the sibling clinical pipeline.
--
-- status: queued -> processing -> done | error   (no_text finishes as done, empty result)
-- ---------------------------------------------------------------------------
CREATE TABLE jobs (
  id             TEXT PRIMARY KEY,
  developer_id   TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  api_key_id     TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','processing','done','error','canceled')),
  priority       INTEGER NOT NULL DEFAULT 0,   -- higher wins; a lever for a partner, unused by default
  view           TEXT NOT NULL DEFAULT 'full'  -- the view the caller asked for at submit time
                 CHECK (view IN ('full','transcript','report')),
  audio_key      TEXT,                         -- R2 object key; NULLed once the audio is purged
  audio_purged   INTEGER NOT NULL DEFAULT 0 CHECK (audio_purged IN (0,1)),
  file_name      TEXT NOT NULL DEFAULT 'audio.wav',
  content_type   TEXT NOT NULL DEFAULT 'audio/wav',
  bytes          INTEGER NOT NULL DEFAULT 0,
  duration_sec   REAL,                         -- from the WAV header when parseable
  language       TEXT NOT NULL DEFAULT '',
  pause_threshold REAL NOT NULL DEFAULT 0.25,  -- passed straight through to the AI service
  metadata       TEXT NOT NULL DEFAULT '{}',   -- opaque developer-supplied JSON, echoed back
  webhook_url    TEXT,
  webhook_status TEXT,                         -- 'sent' | 'failed: <reason>' | NULL
  -- Results. `transcript` is the raw AI output (segments + annotations); `report` is the
  -- computed counts/metrics. Both are stored in full regardless of the caller's scopes —
  -- projection happens at read time, so widening a key's scopes later works retroactively.
  transcript     TEXT,
  report         TEXT,
  no_text        INTEGER NOT NULL DEFAULT 0 CHECK (no_text IN (0,1)),
  error          TEXT,
  error_kind     TEXT,                         -- 'transient' | 'permanent' | 'timeout'
  attempts       INTEGER NOT NULL DEFAULT 0,
  worker_id      TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at     TEXT,
  finished_at    TEXT,
  heartbeat_at   TEXT,
  expires_at     TEXT NOT NULL                 -- results are hard-deleted after this
);
CREATE INDEX jobs_dev_idx     ON jobs (developer_id, created_at);
-- The claim query's exact shape: oldest queued first, highest priority first.
CREATE INDEX jobs_claim_idx   ON jobs (status, priority, created_at);
CREATE INDEX jobs_expiry_idx  ON jobs (expires_at);

-- ---------------------------------------------------------------------------
-- usage_events — one row per billable/rate-limited API call. Drives both the developer's
-- usage monitor and the per-minute rate limiter, so it is written on EVERY /v1 request,
-- including the ones that fail.
-- ---------------------------------------------------------------------------
CREATE TABLE usage_events (
  id            TEXT PRIMARY KEY,
  developer_id  TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  api_key_id    TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  job_id        TEXT,
  endpoint      TEXT NOT NULL,
  method        TEXT NOT NULL DEFAULT 'GET',
  view          TEXT,
  status_code   INTEGER NOT NULL DEFAULT 200,
  audio_seconds REAL NOT NULL DEFAULT 0,       -- non-zero only on a successful submit
  ms            INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- The rate limiter counts this developer's events in the last 60 s; the usage monitor
-- aggregates by day. Both are (developer_id, created_at) range scans.
CREATE INDEX usage_dev_time_idx ON usage_events (developer_id, created_at);
CREATE INDEX usage_key_time_idx ON usage_events (api_key_id, created_at);

-- ---------------------------------------------------------------------------
-- audit_log — admin actions only (approve/suspend/scope/quota changes). Small, append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  target_id  TEXT,
  detail     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX audit_created_idx ON audit_log (created_at);
