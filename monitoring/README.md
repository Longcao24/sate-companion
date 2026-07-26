SATE service monitor

A single-page dashboard for live service health: the processing pipeline
(queued / processing / done / error, **stuck** jobs, recent errors), the device
**fleet** (online/offline, last-seen, firmware per device), and the current
**versions** across components.

## Data source

It polls **`GET /admin/status`** on `device-api` — an admin-gated (service-role,
`sate_admins`) aggregation endpoint added in `device-api` v15+. So:

1. **Deploy the endpoint**: redeploy device-api after pulling this change —
   `supabase functions deploy device-api --no-verify-jwt`.
2. **Be an admin**: your email must be in the `sate_admins` table.
3. **Get an admin JWT**: from your logged-in admin web session (the Supabase access
   token). Paste it into **⚙ Settings** along with the device-api base URL and the
   Supabase anon key.

Config is stored in `localStorage` (this browser only) — no secrets in the file.

## Run

```bash
# locally
python3 -m http.server 8080 -d monitoring    # → http://localhost:8080

# or open monitoring/index.html directly (file://), or deploy to Cloudflare Pages
```

Click **Demo** to render with mock data (no backend needed) to see the layout.

## Notes

- Auto-refreshes every 15 s; **↻ Refresh** forces it.
- App/web versions aren't in the DB (build-time) — they're set in
  `STATIC_VERSIONS` at the top of the script; bump them per release to match the
  docs **Version log**. Recorder firmware is live (reported in each device
  heartbeat → `sate_devices.fw`); the pendant version isn't reported over BLE yet.
- If you deploy it to a URL, **gate it with Cloudflare Access** — it's an admin tool.
- The endpoint is **read-only** and does not expose secrets, but it returns
  fleet-wide data, so keep the admin gate.
