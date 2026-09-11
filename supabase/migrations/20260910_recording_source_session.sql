-- Link a recording back to the device session it came from.
--
-- The link existed in one direction only: sate_device_sessions.recording_id -> recordings.id.
-- Anything holding a recording and asking "which session made this?" had to scan the sessions
-- table, so the dashboard would have needed a second request (~300 rows) on every load just to
-- decide whether a row can become a meeting note — the notes API keys off the SESSION, not the
-- recording. It also bit the delete cascade, which could only ever walk session -> recording.
--
-- Nullable on purpose: a recording uploaded straight from the web app has no session and never
-- will, and that is exactly the distinction the UI needs to show.
alter table public.recordings add column if not exists source_session_id text;

create index if not exists recordings_source_session_idx
  on public.recordings (source_session_id) where source_session_id is not null;

-- Backfill from the existing one-way link.
update public.recordings r
   set source_session_id = s.id
  from public.sate_device_sessions s
 where s.recording_id = r.id
   and r.source_session_id is distinct from s.id;

-- Keep it filled going forward. finalize-session is what sets sate_device_sessions.recording_id,
-- and its source is not in this repo — a trigger covers it without having to edit and redeploy
-- that function.
create or replace function public.recordings_link_source_session() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.recording_id is not null
     and (old.recording_id is null or old.recording_id is distinct from new.recording_id) then
    update public.recordings set source_session_id = new.id where id = new.recording_id;
  end if;
  return new;
end $fn$;

drop trigger if exists sate_device_sessions_link_recording on public.sate_device_sessions;
create trigger sate_device_sessions_link_recording
  after update of recording_id on public.sate_device_sessions
  for each row execute function public.recordings_link_source_session();
