-- One row per submitted test run.
CREATE TABLE IF NOT EXISTS results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,        -- unix ms, server-stamped
  tester      TEXT,
  run_date    TEXT,
  device      TEXT,
  build       TEXT,
  n_pass      INTEGER NOT NULL DEFAULT 0,
  n_fail      INTEGER NOT NULL DEFAULT 0,
  n_na        INTEGER NOT NULL DEFAULT 0,
  n_total     INTEGER NOT NULL DEFAULT 0,
  payload     TEXT NOT NULL            -- full JSON { meta, tests }
);
CREATE INDEX IF NOT EXISTS results_created ON results (created_at DESC);
