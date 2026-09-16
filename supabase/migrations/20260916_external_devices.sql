-- External device families in Connected Recorders
-- =================================================
--
-- A SATE recorder registers itself: it has Wi-Fi, a device key, and it posts to
-- /devices/register. Plaud, the Pendant and the SATE L816 cannot — they have no
-- network of their own and reach the server only through the phone. So their
-- recordings have always arrived as sessions with no device behind them, and the
-- web app's Connected Recorders list simply never showed them.
--
-- Two additions fix that, and both are additive: nothing here changes an existing
-- row or an existing query's result.
--
-- 1. `sate_devices.kind` — which family a row is. NULL means 'sate', so every
--    row that exists today keeps its exact current meaning and no backfill is
--    needed. The web and the app both already branch on `kind`; until now
--    nothing populated it.
--
-- 2. `sate_external_device_optouts` — because removing a derived row has to
--    OUTLIVE the row. `listDevices` synthesizes a device for any external serial
--    that has uploaded sessions, so a plain DELETE would be undone on the next
--    poll (2 s later) and the Remove button would look broken. This is the same
--    shape as `note_optouts` in the notes lane, for the same reason. Pairing the
--    device again clears the opt-out — that is also an intention.

alter table public.sate_devices
  add column if not exists kind text;

comment on column public.sate_devices.kind is
  'Device family: NULL/''sate'' = ESP32-S3 recorder (registers itself, commandable, OTA-able); '
  '''plaud'' / ''pendant'' / ''l816'' = external, paired through the phone, no device key — '
  'never command or OTA one of these.';

create table if not exists public.sate_external_device_optouts (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  serial     text        not null,
  created_at timestamptz not null default now(),
  primary key (user_id, serial)
);

comment on table public.sate_external_device_optouts is
  'A user removed this external device from Connected Recorders. listDevices must not '
  're-synthesize it from its sessions. The RECORDINGS ARE KEPT — this hides the hardware '
  'row only. Re-pairing the device deletes the row here.';

alter table public.sate_external_device_optouts enable row level security;

-- Read/write your own opt-outs only. device-api runs as the service role and is
-- unaffected; this is the backstop for any direct PostgREST access.
drop policy if exists sate_external_device_optouts_own on public.sate_external_device_optouts;
create policy sate_external_device_optouts_own
  on public.sate_external_device_optouts
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- listDevices looks up "which external serials has this user opted out of?" on
-- every poll (every 2 s from the Devices page), so keep it indexed by user.
create index if not exists sate_external_device_optouts_user_idx
  on public.sate_external_device_optouts (user_id);
