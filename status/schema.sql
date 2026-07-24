-- One row per component per probe. The status page aggregates these into the
-- 90-day uptime bars and the uptime %.
CREATE TABLE IF NOT EXISTS checks (
  component   TEXT    NOT NULL,
  ts          INTEGER NOT NULL,   -- unix seconds
  status      TEXT    NOT NULL,   -- 'up' | 'degraded' | 'down'
  code        INTEGER,            -- HTTP status (0 = no response)
  latency_ms  INTEGER
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
