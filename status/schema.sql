-- One row per component per probe. The status page aggregates these into the
-- 90-day uptime bars and the uptime %.
CREATE TABLE IF NOT EXISTS checks (
  component   TEXT    NOT NULL,
  ts          INTEGER NOT NULL,   -- unix seconds
  status      TEXT    NOT NULL,   -- 'up' | 'degraded' | 'down'
  code        INTEGER,            -- HTTP status (0 = no response)
  latency_ms  INTEGER,
  -- 1 = no network call happened; this row copies the last REAL probe forward so the
  -- 90-day bar stays continuous for a rate-limited target (minIntervalSec). The
  -- throttle in runChecks() only counts carried = 0 rows — without this flag the
  -- carried row resets the window and the target is never probed again.
  carried     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS checks_comp_ts ON checks (component, ts);

-- Alert de-dup: one row (id=1) holding the signature of the CURRENT problem set and
-- when we last emailed, so a lingering error mails once (not every 5 minutes) and an
-- all-clear fires exactly once when it resolves.
CREATE TABLE IF NOT EXISTS alert_state (
  id       INTEGER PRIMARY KEY,
  sig      TEXT    NOT NULL DEFAULT '',
  sent_ms  INTEGER NOT NULL DEFAULT 0
);
