# SATE on Cloudflare — parallel stack

A second, self-contained backend: **Workers + D1 + R2** instead of Supabase.
Everything lives in this folder. **Nothing outside `cloudflare/` was modified** — the live
Supabase stack, the web app's `src/`, and the firmware are all untouched, and the existing
`npm run build` still targets Supabase.

| Supabase | Here |
|---|---|
| Postgres | D1 (SQLite) — `schema.sql` |
| Row Level Security | `src/policy.ts` ⚠️ |
| Auth (GoTrue) | `src/auth.ts` + `src/authRoutes.ts` |
| PostgREST | `src/rest.ts` |
| Storage | R2 — `src/storage.ts` |
| Edge functions | `src/functions/` |
| supabase-js | `web/supabaseShim.ts` |

## Read these three things before touching anything

### 1. There is no RLS here. `src/policy.ts` is all there is.

On Supabase, tenant isolation lives in the **database**: Postgres refuses to return another
SLP's rows even if the app asks. A bug in application code could not leak a patient.

D1 has no RLS. That net does not exist. `src/policy.ts` re-implements all 17 non-Stripe
policies and is the **only** thing between one SLP and another SLP's patients. It denies by
default — a table with no entry is refused outright, so adding a table to `schema.sql` does
**not** make it reachable. `test/policy.test.ts` pins the rules against production; 21 tests,
all passing.

### 2. Plaud token minting is DISABLED, and enabling it can brick a device.

`mint-plaud-token` sends `user_id: sate_<uid>`. CLAUDE.md RULE #1 requires that identity to
be **stable and account-derived** — the same string here and in the app's `connect()`.

**This stack has its own `users` table with its own uuids**, so `sate_<cf_uid>` ≠
`sate_<supabase_uid>`. Pointing the phone at this backend while a Plaud device is bound under
the Supabase identity presents a *different* identity to an already-bound device: the exact
re-bind that RULE #1 says can **permanently lock** it.

So `handleMintPlaudToken` returns 501 unless `PLAUD_ALLOW_MINT=1`. Before you set that, one
of these must be true:

- **(a)** No Plaud device has ever been bound against Supabase (clean test fleet only); or
- **(b)** You seed `users.id` with the **same uuids** as Supabase's `auth.users`, so
  `sate_<uid>` is identical on both stacks and the identity genuinely does not change; or
- **(c)** Plaud confirms the re-bind semantics in writing.

**(b) is the recommended path** if this stack is ever meant to serve real users: keep the
uuids and the identity question disappears.

### 3. Workers have a 128 MB memory limit. Deno Deploy did not.

A full-length take is ~118 MB. The Supabase original assembled sessions in a `Uint8Array`;
doing that here would OOM on exactly the long recordings that cost this project a 62-minute
session in July. Both hot paths therefore **stream**:

- `deviceApi.ts` — parts flow R2 → destination object; the WAV header is patched on part 0
  using the length from the contiguity check. Peak memory ~1 MB regardless of session length.
- `processDeviceSession.ts` — the multipart body to the AI is hand-built around the R2 stream,
  because `FormData` would need the whole file as a Blob.

**Still buffered, and still a limit:** `POST /sessions` with `wav_base64` (the phone's Plaud /
BLE path) decodes the whole file in memory. It inherits that shape from the Supabase original.
A ~90 MB+ session on that route will OOM. The chunked recorder path is unaffected.

## Setup

```bash
cd cloudflare
npm install

npx wrangler d1 create sate          # paste the id into wrangler.toml
npx wrangler r2 bucket create sate-storage
npm run db:migrate                   # applies schema.sql

# Secrets — never [vars]; wrangler.toml is committed.
npx wrangler secret put JWT_SECRET       # 32+ random bytes; mints any user's session
npx wrangler secret put SERVICE_KEY      # bypasses every access policy
npx wrangler secret put AI_PROCESS_URL   # the ngrok tunnel, unchanged
npx wrangler secret put PROCESSOR_SECRET

npm run deploy
```

Web app against this backend (does not touch `react_app_sate-ui_update/src`):

```bash
VITE_CF_URL=https://sate-cf.<subdomain>.workers.dev \
  npx vite build --config cloudflare/web/vite.config.cf.ts
```

Recorder against this backend: point `cfgServer` at
`https://sate-cf.<subdomain>.workers.dev/functions/v1/device-api`. No firmware change —
`serverIsSupabase()` keys off the hostname to pick TLS, and this is HTTPS too.

## Status — deployed and smoke-tested

Live at **https://sate-cf.longcao.workers.dev** (D1 `sate` · R2 `sate-storage`).
Database is **empty**: no PHI was migrated, and the smoke-test rows were removed.

```bash
npm run typecheck   # clean
npm test            # 21 passing
```

Verified against the deployed Worker, not just locally:

| Check | Result |
|---|---|
| signup / signin / wrong password | ok / ok / `Invalid login credentials` |
| Alice reads her own patients | 1 row |
| **Bob reads Alice's patients** | **`[]`** |
| Bob inserts a row owned by Alice | 403 |
| Anonymous read | 401 |
| Any client reads `sate_admins` | 403 |
| `DELETE /patients` (no such policy in prod) | 403 |
| SQL injection via column name | 400 |
| `rpc/generate_invite_code`, `mobile-link` QR | ok |
| `mint-plaud-token` | **501 — lock guard holding** |

## What was deliberately NOT ported

**Stripe** — dropped per request: `payments`, `stripe_customers`, `stripe_webhook_events`,
`subscriptions`, the `active_subscriptions` view, and 4 edge functions. The web app's
`stripeService.ts` still imports them, so any billing screen will fail on this stack.

**Four tables that do not exist.** `patient_goals`, `patient_recordings`, `reports`,
`sessions` are referenced by `src/services/patientService.ts`, but they are **not in the
Supabase database** — those code paths are already broken in production. Their only consumer,
`src/services/reportService.ts`, is imported by nobody. Porting them would have ported dead,
broken code. Worth deleting on the Supabase side too.

## Known divergences from Supabase

| Thing | Status |
|---|---|
| **Password hashing** | **Weaker than Supabase.** GoTrue uses bcrypt (memory-hard). Workers has neither bcrypt nor argon2 without shipping WASM, so this uses PBKDF2-SHA256 — and the runtime *refuses* iteration counts above 100_000 (`NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported`). OWASP's guidance is 600_000. 100_000 is the platform ceiling, not a choice. See `src/auth.ts`. |
| Password reset email | **Not wired.** GoTrue mailed it free; Cloudflare has no sender. `/auth/v1/recover` mints a token and only **logs** the link. Reset does not work end-to-end until an email provider is configured. |
| Email confirmation | Auto-confirmed on signup. Same reason. |
| Plaud token minting | Disabled — see above. |
| `wav_base64` upload | Buffered; OOMs on very large sessions. |
| Data | **This stack starts empty.** No PHI was migrated. Migrating live patient data to an unproven backend is a separate, deliberate decision. |
| `invite_codes` SELECT | Transcribed verbatim: `is_active = true`, **not** scoped to the creator, so any signed-in user can read any active code. That is current production behaviour, reproduced rather than silently "fixed". Worth a look on the Supabase side. |

## Cost reality check

Storage is 1.6 GB and the DB 245 MB; on Workers Paid this workload costs roughly **$5/mo**
versus Supabase Pro's $25. A $10k credit covers ~166 years of it and will expire long before
it is spent — the credit is not what makes this worth doing. What Pro buys that this does not:
daily backups, a managed auth service with email, RLS enforced by the database, and a project
that does not pause. For 15 patients and 280 recordings with real revenue attached, that is
not an obvious trade.
