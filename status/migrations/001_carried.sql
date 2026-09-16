-- 2026-08-12 — add checks.carried, and un-stick the throttled AI /process target.
--
-- Why: `minIntervalSec` looked up "the last row" for the component to decide whether
-- the throttle window had expired — but the carried row it writes every 5 minutes IS
-- the newest row, so the window never expired. From 2026-08-04 the AI /process target
-- was probed exactly ONCE and then copied forward 2,314 times: the status page and the
-- daily report showed a live-looking "up" that no longer came from any network call.
--
-- Run once against the deployed DB (from status/):
--   npx wrangler d1 execute sate-status --remote --file migrations/001_carried.sql
-- Safe to run before OR after deploying the worker: the old code ignores the column.

ALTER TABLE checks ADD COLUMN carried INTEGER NOT NULL DEFAULT 0;

-- Backfill: every AI /process row after its last genuine probe is a copy. Marking them
-- carried makes the next cron tick do a real probe instead of waiting another 24h on a
-- fake timestamp. Rows for un-throttled targets are all real probes — leave them 0.
UPDATE checks
   SET carried = 1
 WHERE component = 'AI /process'
   AND ts > (SELECT MIN(ts) FROM checks
              WHERE component = 'AI /process'
                AND ts >= strftime('%s', '2026-08-04'));
