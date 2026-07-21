-- SATE — D1 (SQLite) schema, ported from Supabase Postgres.
--
-- Type mapping (SQLite has no native uuid/jsonb/timestamptz/boolean):
--   uuid          -> TEXT      (UUID string; generated with crypto.randomUUID() in the Worker,
--                               since SQLite has no uuid_generate_v4()/gen_random_uuid())
--   jsonb         -> TEXT      (JSON text; parsed at the API boundary. json_extract() works on it)
--   timestamptz   -> TEXT      (ISO-8601 UTC, e.g. 2026-07-16T09:41:02.123Z — lexically sortable,
--                               which is why the ISO form matters: ORDER BY on it stays correct)
--   boolean       -> INTEGER   (0/1, CHECK-constrained)
--   date          -> TEXT      (YYYY-MM-DD)
--   real          -> REAL
--   bigint        -> INTEGER   (SQLite INTEGER is 64-bit)
--   varchar(n)    -> TEXT      (SQLite ignores length limits anyway; enforced in the Worker)
--
-- now() -> strftime('%Y-%m-%dT%H:%M:%fZ','now'). NOT CURRENT_TIMESTAMP: that yields
-- 'YYYY-MM-DD HH:MM:SS' (space-separated, no ms, no Z), which neither Date.parse nor the
-- existing client date handling reads the same way as Postgres' ISO output.
--
-- NOT PORTED (deliberate):
--   Stripe:      payments, stripe_customers, stripe_webhook_events, subscriptions,
--                active_subscriptions (view) — dropped per request.
--   Dead tables: patient_goals, patient_recordings, reports, sessions — referenced by
--                src/services/patientService.ts but they do not exist in the Supabase
--                database, and their only consumer (src/services/reportService.ts) is
--                imported by nobody. Porting them would port broken code.
--
-- ⚠️ SQLite has NO ROW LEVEL SECURITY. Postgres enforced tenant isolation in the database;
-- here it does not exist at all. Every rule from pg_policies is re-implemented in
-- src/policy.ts and enforced in the Worker. The database will happily hand any row to
-- anyone who asks. src/policy.ts is the ONLY thing standing between one SLP and another
-- SLP's patients. Read it before touching any query path.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- users — replaces Supabase auth.users (GoTrue). Has no Cloudflare equivalent,
-- so we own it. Password hashing/JWT live in src/auth.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL,
  -- PBKDF2-HMAC-SHA256; format: pbkdf2$<iterations>$<salt_b64>$<hash_b64>.
  -- Nullable: an account created by an admin/import may have no password yet.
  password_hash      TEXT,
  -- Mirrors auth.users.raw_user_meta_data. The client reads full_name / name off it.
  user_metadata      TEXT NOT NULL DEFAULT '{}',
  email_confirmed_at TEXT,
  last_sign_in_at    TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Postgres auth.users treats email case-insensitively; SQLite does not unless told.
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

-- Refresh tokens (GoTrue kept these internally; the client relies on auto-refresh
-- via supabase.auth.getSession(), so the shim needs a real refresh flow).
CREATE TABLE refresh_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

-- Password-reset tokens (GoTrue sent these by email; see README — email delivery is
-- the one Supabase freebie with no drop-in Cloudflare equivalent).
CREATE TABLE password_reset_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);

-- ---------------------------------------------------------------------------
-- Clinical
-- ---------------------------------------------------------------------------
CREATE TABLE patients (
  id                TEXT PRIMARY KEY,
  slp_id            TEXT REFERENCES users(id) ON DELETE SET NULL,
  first_name        TEXT NOT NULL,
  last_name         TEXT NOT NULL,
  date_of_birth     TEXT,
  gender            TEXT,
  diagnosis         TEXT,
  contact_email     TEXT,
  contact_phone     TEXT,
  guardian_name     TEXT,
  guardian_phone    TEXT,
  notes             TEXT,
  created_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  is_active         INTEGER DEFAULT 1 CHECK (is_active IN (0,1)),
  device_patient_id TEXT
);
CREATE INDEX patients_slp_idx ON patients (slp_id);

CREATE TABLE recordings (
  id              TEXT PRIMARY KEY,
  user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  file_path       TEXT NOT NULL,
  transcript      TEXT NOT NULL,          -- jsonb
  created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  error_counts    TEXT,                   -- jsonb
  file_name       TEXT,
  file_size       INTEGER,
  duration        REAL DEFAULT 0,
  analysis        TEXT,                   -- jsonb
  updated_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  patient_id      TEXT REFERENCES patients(id) ON DELETE SET NULL,
  recording_name  TEXT,
  protocol        TEXT,
  notes           TEXT,
  segments_edited INTEGER NOT NULL DEFAULT 0 CHECK (segments_edited IN (0,1)),
  needs_review    INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0,1)),
  flags           TEXT,                   -- jsonb
  flag_notes      TEXT DEFAULT '{}'       -- jsonb
);
CREATE INDEX recordings_user_idx    ON recordings (user_id);
CREATE INDEX recordings_patient_idx ON recordings (patient_id);

-- ---------------------------------------------------------------------------
-- Invite codes
-- ---------------------------------------------------------------------------
CREATE TABLE invite_codes (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  created_by   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT,
  max_uses     INTEGER DEFAULT 1,
  current_uses INTEGER DEFAULT 0,
  is_active    INTEGER DEFAULT 1 CHECK (is_active IN (0,1)),
  metadata     TEXT DEFAULT '{}'          -- jsonb
);
CREATE INDEX invite_codes_created_by_idx ON invite_codes (created_by);

CREATE TABLE invite_code_usage (
  id             TEXT PRIMARY KEY,
  invite_code_id TEXT NOT NULL REFERENCES invite_codes(id) ON DELETE CASCADE,
  used_by        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  used_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX invite_code_usage_code_idx ON invite_code_usage (invite_code_id);
-- validate_and_use_invite_code() checks "user already used this code" then inserts.
-- Postgres held a FOR UPDATE row lock across that gap; D1 has no such lock, so the
-- uniqueness is enforced here instead and the porting code relies on it.
CREATE UNIQUE INDEX invite_code_usage_once_idx ON invite_code_usage (invite_code_id, used_by);

-- ---------------------------------------------------------------------------
-- Mobile QR login
-- ---------------------------------------------------------------------------
CREATE TABLE mobile_link_codes (
  code        TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX mobile_link_codes_user_idx ON mobile_link_codes (user_id);

-- ---------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------
CREATE TABLE sate_devices (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  serial           TEXT NOT NULL,
  fw               TEXT NOT NULL DEFAULT '',
  online           INTEGER NOT NULL DEFAULT 0 CHECK (online IN (0,1)),
  ip               TEXT,
  last_seen        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  pending_sessions INTEGER NOT NULL DEFAULT 0,
  state            TEXT NOT NULL DEFAULT 'idle',
  slp              TEXT,
  slp_id           TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ota_state        TEXT,
  battery_pct      INTEGER,
  total_recordings INTEGER NOT NULL DEFAULT 0,
  battery_mv       INTEGER
);
CREATE INDEX sate_devices_user_idx   ON sate_devices (user_id);
CREATE INDEX sate_devices_serial_idx ON sate_devices (serial);

CREATE TABLE sate_device_commands (
  id         TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL REFERENCES sate_devices(id) ON DELETE CASCADE,
  op         TEXT NOT NULL,
  patient    TEXT,                        -- jsonb (also carries the OTA url/version payload)
  consumed   INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- pollCommands() reads unconsumed commands for one device, oldest first.
CREATE INDEX sate_device_commands_poll_idx ON sate_device_commands (device_id, consumed, created_at);

CREATE TABLE sate_device_patients (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_id          TEXT NOT NULL,
  name                TEXT NOT NULL DEFAULT '',
  age                 TEXT NOT NULL DEFAULT '',
  session_type        TEXT NOT NULL DEFAULT '',
  clinician           TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  clinical_patient_id TEXT REFERENCES patients(id) ON DELETE SET NULL
);
CREATE INDEX sate_device_patients_user_idx ON sate_device_patients (user_id);
-- sendCommand() upserts here with onConflict 'user_id,patient_id'. ON CONFLICT needs a
-- matching unique index to have anything to conflict against — without it the upsert
-- becomes a plain insert and re-recording for the same patient duplicates the roster row.
CREATE UNIQUE INDEX sate_device_patients_unique_idx ON sate_device_patients (user_id, patient_id);

CREATE TABLE sate_device_sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_serial TEXT NOT NULL,
  patient_id    TEXT NOT NULL DEFAULT 'PT',
  session_number INTEGER NOT NULL DEFAULT 0,
  sample_rate   INTEGER NOT NULL DEFAULT 16000,
  bytes         INTEGER NOT NULL DEFAULT 0,
  storage_path  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  recording_id  TEXT REFERENCES recordings(id) ON DELETE SET NULL,
  processed     INTEGER NOT NULL DEFAULT 0 CHECK (processed IN (0,1)),
  processed_at  TEXT,
  process_error TEXT,
  flags         TEXT,                     -- jsonb
  no_text       INTEGER NOT NULL DEFAULT 0 CHECK (no_text IN (0,1))
);
CREATE INDEX sate_device_sessions_user_idx   ON sate_device_sessions (user_id);
CREATE INDEX sate_device_sessions_device_idx ON sate_device_sessions (device_serial);
-- The uploader's idempotency probe looks a session up by exactly this triple.
CREATE INDEX sate_device_sessions_lookup_idx
  ON sate_device_sessions (device_serial, patient_id, session_number);

CREATE TABLE sate_claim_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_name  TEXT NOT NULL DEFAULT '',
  used       INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX sate_claim_tokens_user_idx ON sate_claim_tokens (user_id);

CREATE TABLE sate_firmware (
  id         TEXT PRIMARY KEY,
  version    TEXT NOT NULL,
  url        TEXT NOT NULL,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX sate_firmware_created_idx ON sate_firmware (created_at);

-- Admin allowlist, by email. /admin manages ALL devices + firmware system-wide and is
-- gated on membership here. Keep the gate — see CLAUDE.md.
CREATE TABLE sate_admins (
  email      TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
