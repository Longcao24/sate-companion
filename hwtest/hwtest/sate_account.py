"""SATE account login + claim-token minting — the mobile app's connect-to-server flow.

No admin token / MCP needed: sign in with your SATE **email + password** (Supabase Auth,
public anon key) to get a session JWT, then mint a device claim token bound to your account.
Mirrors `src/api/sateApi.ts` (`login()` + `claimToken()`). Stdlib only (urllib).
"""
from __future__ import annotations

import json
import urllib.request

# Public project config (same values the firmware/app ship).
SUPABASE_URL = "https://zlgdpivcbmaodgokkdvz.supabase.co"
ANON_KEY = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
            "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpsZ2RwaXZjYm1hb2Rnb2trZHZ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk3NTY5NTgsImV4cCI6MjA2NTMzMjk1OH0."
            "x58hiBi5EeRwbedrsrBzRkw7y2tFBw5ztIdmujZoPMQ")
DEVICE_API = SUPABASE_URL + "/functions/v1/device-api"


def _post(url: str, headers: dict, body) -> dict:
    data = json.dumps(body).encode() if body is not None else b""
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:  # surface the server's message
        detail = e.read().decode("utf-8", "replace")[:200]
        raise RuntimeError(f"{e.code}: {detail}") from None


def login(email: str, password: str, *, anon: str = ANON_KEY, url: str = SUPABASE_URL) -> str:
    """Sign in via Supabase Auth → return the session access token (a real user JWT)."""
    j = _post(f"{url}/auth/v1/token?grant_type=password",
              {"Content-Type": "application/json", "apikey": anon},
              {"email": email, "password": password})
    tok = j.get("access_token")
    if not tok:
        raise RuntimeError("login returned no access_token")
    return tok


def claim_token(access_token: str, *, anon: str = ANON_KEY, device_api: str = DEVICE_API) -> str:
    """Mint a device claim token bound to this account (device-api validates the session)."""
    j = _post(f"{device_api}/api/devices/claim-token",
              {"Authorization": f"Bearer {access_token}", "apikey": anon,
               "Content-Type": "application/json"},
              None)
    tok = j.get("token")
    if not tok:
        raise RuntimeError("no claim token in response")
    return tok


def _get(url: str, headers: dict) -> object:
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:200]
        raise RuntimeError(f"{e.code}: {detail}") from None


def list_devices(access_token: str, *, anon: str = ANON_KEY, device_api: str = DEVICE_API) -> list:
    """The account's claimed devices (sate_devices rows)."""
    d = _get(f"{device_api}/api/devices",
             {"Authorization": f"Bearer {access_token}", "apikey": anon})
    return d if isinstance(d, list) else []


def device_key_for(access_token: str, serial: str) -> tuple:
    """Find an already-claimed device by serial → (device_key, device_id). None if not found."""
    for row in list_devices(access_token):
        cand = {str(row.get(k, "")) for k in ("id", "serial", "device_serial", "name")}
        if serial and serial in cand:
            dev_id = row.get("id") or row.get("device_id") or serial
            return "key-" + str(dev_id), str(dev_id)
    return None, None


def login_and_claim(email: str, password: str) -> str:
    """Convenience: email + password → a fresh device claim token."""
    return claim_token(login(email, password))
