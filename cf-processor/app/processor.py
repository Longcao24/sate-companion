"""SATE async device-session processor — the poll loop.

Runs inside the Cloudflare container (a long-lived process, so no serverless
wall-clock limit). Each iteration:

  1. requeue_stale_sessions() — watchdog: reclaim jobs a dead worker left in
     'processing'.
  2. claim_next_session() — atomically grab the oldest 'queued' session.
  3. process it: download the WAV from Supabase Storage, HOLD the long AI (ngrok)
     call, and — if there is speech — copy the audio into the recordings bucket and
     hand the transcript to the finalize-session edge (which runs analysis + inserts
     the recording). No-speech takes are finalized as no_text.
  4. on any failure -> fail_session() (marks 'error', NEVER deletes device audio).

The AI call uses a 1-hour read ceiling (AI_READ_TIMEOUT_S): a 32-min take can transcribe for
minutes and that is fine here.
"""

import os
import time
import traceback

import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
AI_PROCESS_URL = os.environ.get("AI_PROCESS_URL", "")
FINALIZE_URL = os.environ.get("FINALIZE_URL", "")
STUCK_MINUTES = int(os.environ.get("STUCK_MINUTES", "45"))
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "3"))
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "10"))
# Ceiling on how long ONE AI read may hang. The old value was None (unbounded,
# deliberate for long takes) — but if the AI service accepts the connection and
# then never responds, the single worker thread wedges FOREVER: the 45-min
# watchdog requeues the JOB, yet no worker is free to claim it until the
# container recycles. 1 h comfortably covers the longest possible take (~62 min
# of audio) while guaranteeing the worker always comes back.
AI_READ_TIMEOUT_S = int(os.environ.get("AI_READ_TIMEOUT_S", "3600"))
WORKER_ID = os.environ.get("WORKER_ID", "cf-container-1")

_JSON_HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}
_STORAGE_HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
}


def _log(*a):
    print("[processor]", *a, flush=True)


# Transient = worth retrying (network blip, ngrok down, 408/429/5xx). Permanent =
# don't retry (4xx, malformed AI response) — a retry would just fail the same way.
class Transient(Exception):
    pass


class Permanent(Exception):
    pass


def _raise_http(prefix, r):
    code = r.status_code
    if code in (408, 429) or code >= 500:
        raise Transient(f"{prefix} {code}: {r.text[:200]}")
    raise Permanent(f"{prefix} {code}: {r.text[:200]}")


# ---- Supabase RPC helpers ---------------------------------------------------

def _rpc(fn, payload):
    r = requests.post(f"{SUPABASE_URL}/rest/v1/rpc/{fn}", headers=_JSON_HEADERS, json=payload, timeout=30)
    r.raise_for_status()
    return r.json() if r.text else None


def claim_next():
    row = _rpc("claim_next_session", {"p_worker": WORKER_ID})
    if isinstance(row, list):
        row = row[0] if row else None
    if not row or not row.get("id"):
        return None
    return row


def requeue_stale():
    try:
        _rpc("requeue_stale_sessions", {"p_stuck_minutes": STUCK_MINUTES, "p_max_attempts": MAX_ATTEMPTS})
    except Exception as e:  # noqa: BLE001
        _log("watchdog error:", e)


def fail_session(session_id, msg):
    try:
        _rpc("fail_session", {"p_id": session_id, "p_msg": str(msg)[:500]})
    except Exception as e:  # noqa: BLE001
        _log("fail_session error:", e)


def requeue_session(session_id):
    try:
        _rpc("requeue_session", {"p_id": session_id})
    except Exception as e:  # noqa: BLE001
        _log("requeue_session error:", e)


# ---- Storage + AI + finalize ------------------------------------------------

def download_wav(path):
    try:
        r = requests.get(
            f"{SUPABASE_URL}/storage/v1/object/device-sessions/{path}",
            headers=_STORAGE_HEADERS,
            timeout=(30, 900),   # 15-min read ceiling: large files, but never a wedged worker
        )
    except requests.RequestException as e:
        raise Transient(f"download network error: {e}")
    if not r.ok:
        _raise_http("download failed", r)
    return r.content


def upload_recording(rec_path, data):
    try:
        r = requests.post(
            f"{SUPABASE_URL}/storage/v1/object/recordings/{rec_path}",
            headers={**_STORAGE_HEADERS, "Content-Type": "audio/wav", "x-upsert": "true"},
            data=data,
            timeout=(30, None),
        )
    except requests.RequestException as e:
        raise Transient(f"recordings upload network error: {e}")
    if r.status_code not in (200, 201):
        _raise_http("recordings upload", r)


def call_ai(file_name, data):
    files = {"audio_file": (file_name, data, "audio/wav")}
    form = {"device": "cuda", "pause_threshold": "0.25"}
    try:
        # (connect 30 s, read AI_READ_TIMEOUT_S) — hold a long transcription, but
        # never hang the only worker forever on a dead-but-connected AI service.
        r = requests.post(AI_PROCESS_URL, files=files, data=form, headers={"Accept": "application/json"}, timeout=(30, AI_READ_TIMEOUT_S))
    except requests.RequestException as e:
        # ngrok down / connection reset / read failure — worth a retry.
        raise Transient(f"AI network error: {e}")
    if not r.ok:
        _raise_http("AI", r)
    return r.json()


def finalize(payload):
    try:
        r = requests.post(FINALIZE_URL, headers=_JSON_HEADERS, json=payload, timeout=120)
    except requests.RequestException as e:
        raise Transient(f"finalize network error: {e}")
    if not r.ok:
        _raise_http("finalize", r)
    return r.json()


def _has_text(t):
    for seg in (t.get("segments") or []):
        for w in (seg.get("words") or []):
            if (w.get("word") or "").strip():
                return True
        txt = seg.get("text")
        if isinstance(txt, str) and txt.strip():
            return True
    return False


def process(s):
    sid = s["id"]
    path = s.get("storage_path")
    if not path:
        raise Permanent("session has no storage_path")

    file_name = f"device_{s['device_serial']}_s{s['session_number']}.wav"
    wav = download_wav(path)

    transcript = call_ai(file_name, wav)
    if not transcript or not isinstance(transcript.get("segments"), list):
        raise Permanent("AI returned no segments")

    # No usable speech: finalize as no_text (no recording), let the edge mark it done.
    if not _has_text(transcript):
        finalize({"session_id": sid, "no_text": True})
        _log(f"{sid}: no_text")
        return

    rec_path = f"{s['user_id']}/{int(time.time() * 1000)}_{file_name}"
    upload_recording(rec_path, wav)
    res = finalize({
        "session_id": sid,
        "transcript": transcript,
        "rec_path": rec_path,
        "file_name": file_name,
        "file_size": len(wav),
    })
    _log(f"{sid}: done -> recording {res.get('recording_id')}")


# ---- Main loop --------------------------------------------------------------

def _missing_config():
    missing = [n for n, v in (
        ("SUPABASE_URL", SUPABASE_URL),
        ("SUPABASE_SERVICE_KEY", SERVICE_KEY),
        ("AI_PROCESS_URL", AI_PROCESS_URL),
        ("FINALIZE_URL", FINALIZE_URL),
    ) if not v]
    return missing


def loop():
    _log(f"loop start (worker={WORKER_ID}, stuck={STUCK_MINUTES}m, max_attempts={MAX_ATTEMPTS})")
    while True:
        # Don't hammer Supabase (or crash) if a secret isn't set yet — wait for it.
        missing = _missing_config()
        if missing:
            _log("waiting for config:", ", ".join(missing))
            time.sleep(15)
            continue
        try:
            requeue_stale()
            s = claim_next()
            if not s:
                time.sleep(POLL_INTERVAL)
                continue
            attempt = int(s.get("attempts") or 1)
            _log(f"claimed {s['id']} ({s.get('bytes')} bytes, attempt {attempt})")
            try:
                process(s)
            except Transient as e:
                # Retry a transient failure up to MAX_ATTEMPTS, with backoff, so a
                # brief ngrok/network blip doesn't turn into a hard error.
                if attempt < MAX_ATTEMPTS:
                    backoff = min(60, POLL_INTERVAL * attempt)
                    _log(f"{s['id']}: transient ({e}); requeue in {backoff}s (attempt {attempt}/{MAX_ATTEMPTS})")
                    time.sleep(backoff)
                    requeue_session(s["id"])
                else:
                    _log(f"{s['id']}: transient, gave up after {attempt} attempts: {e}")
                    fail_session(s["id"], f"transient, gave up after {attempt} attempts: {e}")
            except Permanent as e:
                _log(f"{s['id']}: permanent failure: {e}")
                fail_session(s["id"], f"{e}")
            except Exception as e:  # noqa: BLE001 — unknown: treat as transient, watchdog backstops
                traceback.print_exc()
                if attempt < MAX_ATTEMPTS:
                    requeue_session(s["id"])
                else:
                    fail_session(s["id"], f"{type(e).__name__}: {e}")
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            time.sleep(POLL_INTERVAL)
