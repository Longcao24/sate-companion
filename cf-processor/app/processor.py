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

import io
import os
import time
import traceback
import wave

import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
AI_PROCESS_URL = os.environ.get("AI_PROCESS_URL", "")
FINALIZE_URL = os.environ.get("FINALIZE_URL", "")
STUCK_MINUTES = int(os.environ.get("STUCK_MINUTES", "45"))
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "3"))
# A recording shorter than this holds no speech (an accidental button-tap: a ~32 ms,
# 1 KB WAV). The AI service returns HTTP 500 on such a near-empty file instead of an
# empty transcript, and a 5xx is classified transient — so it retry-loops 3x into a
# permanently stuck 'error'. Finalize these as no_text WITHOUT ever calling the AI.
# 0.4 s is far below any real clinical utterance. See _has_text for the post-AI case.
MIN_AUDIO_SEC = float(os.environ.get("MIN_AUDIO_SEC", "0.4"))
# A take whose audio is AUDIBLE but which the AI returns with zero words is far more likely
# to be a flaky AI response than a genuinely silent recording: byte-identical speech audio
# was measured coming back empty on roughly one upload in three, and transcribing normally
# on the next. Finalizing that as `no_text` is silent data loss — the clinician sees a
# recording that captured nothing, with no error and no way to retry (the Retry button only
# accepts status='error'). So: retry an audible-but-empty result, and only accept `no_text`
# once the attempts are spent or the audio really is silent. RMS is in int16 units — digital
# silence is 0, and this mic is QUIET: a measured 7.6 s clinical take that transcribes fine
# reads only ~76 RMS, so the cut sits just above digital silence, not at a "speech" level.
SILENT_RMS_MAX = float(os.environ.get("SILENT_RMS_MAX", "20"))
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


def _wav_seconds(data):
    """Duration in seconds of a WAV byte string, or None if it can't be parsed."""
    try:
        with wave.open(io.BytesIO(data)) as wf:
            fr = wf.getframerate()
            return wf.getnframes() / float(fr) if fr else None
    except Exception:
        return None


def _audio_rms(data):
    """RMS amplitude of a 16-bit mono WAV, or None if it can't be read."""
    try:
        with wave.open(io.BytesIO(data)) as wf:
            if wf.getsampwidth() != 2:
                return None
            frames = wf.readframes(wf.getnframes())
    except Exception:
        return None
    if not frames:
        return 0.0
    import array
    a = array.array("h")
    a.frombytes(frames[: len(frames) - (len(frames) % 2)])
    if not len(a):
        return 0.0
    return (sum(v * v for v in a) / len(a)) ** 0.5


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

    # Guard: a too-short/empty take has no speech, and the AI service returns 500 on it
    # (not an empty transcript) — which would retry-loop into a permanently stuck
    # 'error'. Finalize it as no_text up front and never call the AI.
    dur = _wav_seconds(wav)
    if dur is not None and dur < MIN_AUDIO_SEC:
        finalize({"session_id": sid, "no_text": True})
        _log(f"{sid}: audio {dur:.3f}s < {MIN_AUDIO_SEC}s — finalized no_text, skipped AI")
        return

    transcript = call_ai(file_name, wav)
    if not transcript or not isinstance(transcript.get("segments"), list):
        raise Permanent("AI returned no segments")

    # No usable speech. Distinguish a genuinely silent take from a flaky AI response by
    # looking at the AUDIO, not the transcript — the two are indistinguishable otherwise.
    if not _has_text(transcript):
        rms = _audio_rms(wav)
        attempt = int(s.get("attempts") or 1)
        if rms is not None and rms >= SILENT_RMS_MAX and attempt < MAX_ATTEMPTS:
            raise Transient(
                f"AI returned no words for {dur:.1f}s of audible audio "
                f"(rms {rms:.0f} >= {SILENT_RMS_MAX}) — retrying rather than storing an "
                f"empty transcript")
        finalize({"session_id": sid, "no_text": True})
        _log(f"{sid}: no_text (rms={rms}, attempt {attempt}/{MAX_ATTEMPTS})")
        return

    # Keyed by SESSION, not by wall-clock. With a timestamp in the key every retry wrote a
    # NEW object, so a job that kept failing the finalize step left one orphaned copy of the
    # clinical audio per attempt and nothing ever collected them. The upload is upsert, so a
    # stable key means a retry overwrites its own previous copy.
    rec_path = f"{s['user_id']}/{sid}_{file_name}"
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
