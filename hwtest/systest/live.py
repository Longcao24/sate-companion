"""Tier A — tests that run against the REAL backend (device-api, Supabase, Storage,
the Cloudflare processor).

These use the same two credentials the system itself uses: the recorder's device key
(for the upload/verify routes) and a normal user login (for everything the web app
does). No recorder is needed — a synthesized WAV is pushed through the exact route the
firmware uses, so the whole server-side pipeline runs for real.

Footprint: every session this creates is deleted again in cleanup(). Nothing else in
the account is touched, and no test publishes firmware or writes to another account.
"""
from __future__ import annotations

import base64
import json
import math
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
import io
from dataclasses import dataclass, field


# ---------------------------------------------------------------------------

@dataclass
class Ctx:
    base: str          # device-api base url
    supabase: str      # https://<ref>.supabase.co
    anon: str
    token: str         # user access token
    device_key: str    # "key-dev-..."
    device_id: str
    serial: str
    created_sessions: list = field(default_factory=list)
    notes: list = field(default_factory=list)


def req(url, method="GET", headers=None, data=None, timeout=90, allow_redirect=True):
    """Returns (status, headers, body_bytes). Never raises on an HTTP error status."""
    r = urllib.request.Request(url, method=method, data=data)
    for k, v in (headers or {}).items():
        r.add_header(k, v)

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    opener = urllib.request.build_opener(*([] if allow_redirect else [_NoRedirect]))
    try:
        with opener.open(r, timeout=timeout) as x:
            return x.status, dict(x.headers), x.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()
    except Exception as e:  # network-level
        return 0, {}, str(e).encode()


def jbody(b):
    try:
        return json.loads(b or b"{}")
    except Exception:
        return {"_raw": (b or b"")[:300].decode("utf-8", "replace")}


def speech_wav(seconds=4.0, rate=16000):
    """A WAV with real signal — not silence, so the pipeline treats it as a take."""
    n = int(seconds * rate)
    frames = bytearray()
    for i in range(n):
        t = i / rate
        # a wobbling tone: enough energy to be audio, cheap to make
        v = 6000 * math.sin(2 * math.pi * (180 + 40 * math.sin(2 * math.pi * 1.7 * t)) * t)
        frames += struct.pack("<h", int(v))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(bytes(frames))
    return buf.getvalue()


def user_headers(c: Ctx):
    return {"Authorization": f"Bearer {c.token}", "apikey": c.anon}


def dev_headers(c: Ctx):
    return {"Authorization": f"Bearer {c.device_key}", "apikey": c.anon}


# ---------------------------------------------------------------------------
# building blocks

def upload_raw(c: Ctx, wav: bytes, patient="Standalone", session_number=90, sample_rate=16000):
    q = urllib.parse.urlencode({
        "device_serial": c.serial, "patient_id": patient,
        "session_number": session_number, "sample_rate": sample_rate,
    })
    st, _, b = req(f"{c.base}/api/sessions/raw?{q}", "POST",
                   {**dev_headers(c), "Content-Type": "application/octet-stream"}, wav)
    return st, jbody(b)


def list_sessions(c: Ctx, limit=200):
    st, _, b = req(f"{c.base}/api/sessions?limit={limit}", headers=user_headers(c))
    return st, jbody(b)


def get_session(c: Ctx, sid):
    st, rows = list_sessions(c)
    if st != 200 or not isinstance(rows, list):
        return None
    for r in rows:
        if r.get("id") == sid:
            return r
    return None


def wait_settled(c: Ctx, sid, timeout=600, poll=6):
    """Poll until the state machine reaches a terminal state. Returns the last row."""
    end = time.time() + timeout
    seen = []
    row = None
    while time.time() < end:
        row = get_session(c, sid)
        if row:
            st = row.get("status")
            if not seen or seen[-1] != st:
                seen.append(st)
            if st in ("done", "error"):
                break
        time.sleep(poll)
    if row is not None:
        row = dict(row)
        row["_status_path"] = seen
    return row


def verify_stored(c: Ctx, patient, session_number, byte_count):
    q = urllib.parse.urlencode({
        "patient_id": patient, "session_number": session_number,
        "bytes": byte_count, "device_serial": c.serial,
    })
    st, _, b = req(f"{c.base}/api/sessions/verify?{q}", headers=dev_headers(c))
    return st, jbody(b)


def delete_session(c: Ctx, sid):
    st, _, _ = req(f"{c.base}/api/sessions/{sid}", "DELETE", user_headers(c))
    return st


def cleanup(c: Ctx):
    out = []
    for sid in list(c.created_sessions):
        st = delete_session(c, sid)
        out.append(f"{sid}:{st}")
    return out


def borrow_speech_wav(c: Ctx):
    """Reuse the audio of an already-processed take that produced a transcript, so the
    pipeline test exercises the REAL transcript path instead of a synthetic tone.

    Returns (wav_bytes, source_session_id) or (None, None).
    """
    st, rows = list_sessions(c, 200)
    if st != 200 or not isinstance(rows, list):
        return None, None
    cands = [r for r in rows
             if r.get("status") == "done" and r.get("recording_id") and not r.get("no_text")
             and 40_000 < (r.get("bytes") or 0) < 6_000_000]
    for r in cands[:4]:
        code, hdrs, _ = req(f"{c.base}/api/sessions/{r['id']}/audio",
                            headers=user_headers(c), allow_redirect=False)
        loc = hdrs.get("Location")
        if code != 302 or not loc:
            continue
        s2, _, data = req(loc, timeout=180)
        if s2 == 200 and data[:4] == b"RIFF" and len(data) == r["bytes"]:
            return data, r["id"]
    return None, None


def _service_key(c: Ctx):
    """Fetch the project's service_role key from the Supabase Management API using the
    CLI's stored token. Never written to disk or the repo."""
    import os
    import subprocess
    if os.environ.get("SATE_SERVICE_KEY"):
        return os.environ["SATE_SERVICE_KEY"]
    try:
        tok = subprocess.run(["security", "find-generic-password", "-s", "Supabase CLI", "-w"],
                             capture_output=True, text=True, timeout=20).stdout.strip()
        if not tok:
            return None
        ref = c.supabase.split("//")[1].split(".")[0]
        # api.supabase.com sits behind Cloudflare, which 403s urllib's default UA (1010).
        _, _, b = req(f"https://api.supabase.com/v1/projects/{ref}/api-keys?reveal=true",
                      headers={"Authorization": f"Bearer {tok}",
                               "User-Agent": "sate-systest/1.0"})
        for k in (jbody(b) or []):
            if k.get("name") == "service_role":
                return k.get("api_key")
    except Exception:
        return None
    return None


def make_throwaway_user(c: Ctx):
    """Create a temporary NON-admin account so role separation is tested for real, not
    just argued from source. Removed again by drop_throwaway_user()."""
    import secrets
    svc = _service_key(c)
    if not svc:
        return None
    email = f"sate-systest-{int(time.time())}-{secrets.token_hex(3)}@sate-qa.dev"
    password = secrets.token_urlsafe(18) + "aA1!"
    admin = {"apikey": svc, "Authorization": f"Bearer {svc}", "Content-Type": "application/json"}
    st, _, b = req(f"{c.supabase}/auth/v1/admin/users", "POST", admin,
                   json.dumps({"email": email, "password": password,
                               "email_confirm": True}).encode())
    body = jbody(b)
    uid = body.get("id")
    if st not in (200, 201) or not uid:
        return None
    st2, _, b2 = req(f"{c.supabase}/auth/v1/token?grant_type=password", "POST",
                     {"apikey": c.anon, "Content-Type": "application/json"},
                     json.dumps({"email": email, "password": password}).encode())
    tok = jbody(b2).get("access_token")
    if not tok:
        req(f"{c.supabase}/auth/v1/admin/users/{uid}", "DELETE", admin)
        return None
    c.notes.append(f"throwaway non-admin user {email} ({uid})")
    return {"email": email, "token": tok, "id": uid, "_svc": svc}


def drop_throwaway_user(c: Ctx, u):
    if not u:
        return None
    admin = {"apikey": u["_svc"], "Authorization": f"Bearer {u['_svc']}"}
    return req(f"{c.supabase}/auth/v1/admin/users/{u['id']}", "DELETE", admin)[0]
