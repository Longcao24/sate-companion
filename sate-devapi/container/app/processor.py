"""SATE Developer API — the job processor.

This container exists for ONE reason: the AI transcription call cannot be held by a
serverless request. A Cloudflare Worker dies at the ~100 s origin timeout and a Supabase
edge function at ~150 s — both *mid-fetch, before any except: block runs*, so a long job
would strand with no error ever recorded. A container has no wall-clock at all.

It owns no state and speaks no SQL. It claims work from the Worker over /internal/*, calls
the AI, and posts the result back. Everything restartable, nothing to lose on a reboot.

Clinical priority
-----------------
The AI box is shared with the clinical pipeline and its GPU concurrency is 1. A developer's
batch must never make a clinician's recording wait, so before claiming work this loop probes
whether the clinical queue has anything pending and defers if it does. The deferral is
bounded (MAX_DEFER_SEC): a permanently busy or permanently unreachable clinical queue
degrades developer latency, it does not stop developer traffic forever.
"""

import io
import json
import os
import threading
import time
import wave

import requests

API_BASE = os.environ.get("API_BASE", "").rstrip("/")
INTERNAL_SECRET = os.environ.get("INTERNAL_SECRET", "")
AI_PROCESS_URL = os.environ.get("AI_PROCESS_URL", "")
WORKER_ID = os.environ.get("WORKER_ID", "devapi-container-1")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "10"))

# Clinical-priority gate. With no probe URL the gate is simply off.
CLINICAL_PROBE_URL = os.environ.get("CLINICAL_PROBE_URL", "")
CLINICAL_PROBE_KEY = os.environ.get("CLINICAL_PROBE_KEY", "")
CLINICAL_DEFER_SEC = int(os.environ.get("CLINICAL_DEFER_SEC", "15"))
MAX_DEFER_SEC = int(os.environ.get("MAX_DEFER_SEC", "600"))

# A near-empty upload has no speech, and the AI service answers 500 on one rather than
# returning an empty transcript. A 500 reads as transient, so it would retry-loop into a
# stuck error. Short audio is finished as no-speech up front and never reaches the AI.
MIN_AUDIO_SEC = float(os.environ.get("MIN_AUDIO_SEC", "0.4"))

AI_CONNECT_TIMEOUT_S = 30
AI_READ_TIMEOUT_S = int(os.environ.get("AI_READ_TIMEOUT_S", "3600"))
HEARTBEAT_SEC = 60


class Transient(Exception):
    """Worth retrying: network blip, 5xx, timeout."""


class Permanent(Exception):
    """Will fail identically forever: malformed audio, 4xx, no segments."""


def _log(msg):
    print(f"[devapi] {msg}", flush=True)


def _headers():
    return {"Authorization": f"Bearer {INTERNAL_SECRET}", "Content-Type": "application/json"}


# ---------------------------------------------------------------------------
# Worker API (the only place this container gets work or reports results)
# ---------------------------------------------------------------------------
def claim_next():
    r = requests.post(
        f"{API_BASE}/internal/claim",
        headers=_headers(),
        json={"worker_id": WORKER_ID},
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get("job")


def download_audio(url):
    r = requests.get(url, headers={"Authorization": f"Bearer {INTERNAL_SECRET}"}, timeout=(30, 900))
    if r.status_code == 404:
        raise Permanent("audio object missing")
    if not r.ok:
        raise Transient(f"audio download HTTP {r.status_code}")
    return r.content


def complete(job_id, transcript, no_text, duration):
    r = requests.post(
        f"{API_BASE}/internal/jobs/{job_id}/complete",
        headers=_headers(),
        json={"transcript": transcript, "no_text": no_text, "duration_sec": duration},
        timeout=120,
    )
    r.raise_for_status()


def fail(job_id, message, kind):
    try:
        requests.post(
            f"{API_BASE}/internal/jobs/{job_id}/fail",
            headers=_headers(),
            json={"error": str(message)[:500], "kind": kind},
            timeout=30,
        )
    except requests.RequestException as e:
        # Nothing more we can do; the Worker's stale-job watchdog reclaims it.
        _log(f"could not report failure for {job_id}: {e}")


def heartbeat(job_id):
    try:
        requests.post(
            f"{API_BASE}/internal/jobs/{job_id}/heartbeat", headers=_headers(), timeout=15
        )
    except requests.RequestException:
        pass


# ---------------------------------------------------------------------------
# Clinical priority
# ---------------------------------------------------------------------------
def clinical_busy():
    """True when the clinical pipeline has work pending or in flight.

    Returns None when the probe cannot be reached, which the caller treats as "assume
    busy, but only up to the deferral ceiling" — a misconfigured probe must not become a
    silent permanent outage for developers.
    """
    if not CLINICAL_PROBE_URL:
        return False
    try:
        headers = {"Accept": "application/json"}
        if CLINICAL_PROBE_KEY:
            headers["apikey"] = CLINICAL_PROBE_KEY
            headers["Authorization"] = f"Bearer {CLINICAL_PROBE_KEY}"
        r = requests.get(CLINICAL_PROBE_URL, headers=headers, timeout=10)
        if not r.ok:
            return None
        body = r.json()
        # PostgREST returns a list of matching rows; anything non-empty means work pending.
        if isinstance(body, list):
            return len(body) > 0
        if isinstance(body, dict):
            return bool(body.get("busy"))
        return False
    except (requests.RequestException, ValueError):
        return None


def wait_for_clinical_window():
    """Block while the clinical queue is busy, up to MAX_DEFER_SEC."""
    waited = 0
    while waited < MAX_DEFER_SEC:
        busy = clinical_busy()
        if busy is False:
            return
        reason = "clinical queue busy" if busy else "clinical probe unreachable"
        _log(f"deferring: {reason} ({waited}s/{MAX_DEFER_SEC}s)")
        time.sleep(CLINICAL_DEFER_SEC)
        waited += CLINICAL_DEFER_SEC
    _log(f"deferral ceiling reached after {waited}s — proceeding")


# ---------------------------------------------------------------------------
# AI
# ---------------------------------------------------------------------------
def call_ai(file_name, data, pause_threshold, language):
    files = {"audio_file": (file_name, data, "audio/wav")}
    form = {"device": "cuda", "pause_threshold": str(pause_threshold or 0.25)}
    if language:
        form["language"] = language
    try:
        r = requests.post(
            AI_PROCESS_URL,
            files=files,
            data=form,
            headers={"Accept": "application/json"},
            # Hold a long transcription, but never hang the only worker forever on an AI
            # service that is up-but-dead.
            timeout=(AI_CONNECT_TIMEOUT_S, AI_READ_TIMEOUT_S),
        )
    except requests.RequestException as e:
        raise Transient(f"AI network error: {e}")
    if not r.ok:
        kind = Transient if r.status_code >= 500 or r.status_code in (408, 429) else Permanent
        raise kind(f"AI HTTP {r.status_code}: {r.text[:200]}")
    try:
        return r.json()
    except ValueError:
        raise Permanent("AI returned a non-JSON body")


def wav_seconds(data):
    try:
        with wave.open(io.BytesIO(data)) as wf:
            rate = wf.getframerate()
            return wf.getnframes() / float(rate) if rate else None
    except Exception:
        return None


def has_text(transcript):
    for seg in transcript.get("segments") or []:
        for w in seg.get("words") or []:
            if (w.get("word") or "").strip():
                return True
        text = seg.get("text")
        if isinstance(text, str) and text.strip():
            return True
    return False


# ---------------------------------------------------------------------------
# One job
# ---------------------------------------------------------------------------
def process(job):
    job_id = job["id"]
    audio = download_audio(job["audio_url"])
    duration = wav_seconds(audio)

    if duration is not None and duration < MIN_AUDIO_SEC:
        complete(job_id, None, True, duration)
        _log(f"{job_id}: {duration:.3f}s < {MIN_AUDIO_SEC}s — no-speech, AI skipped")
        return

    # Keep the job's claim alive across a long transcription so the Worker's watchdog does
    # not reclaim work that is genuinely still running.
    stop = threading.Event()

    def beat():
        while not stop.wait(HEARTBEAT_SEC):
            heartbeat(job_id)

    beater = threading.Thread(target=beat, daemon=True)
    beater.start()
    try:
        transcript = call_ai(
            job.get("file_name") or "audio.wav",
            audio,
            job.get("pause_threshold"),
            job.get("language"),
        )
    finally:
        stop.set()

    if not transcript or not isinstance(transcript.get("segments"), list):
        raise Permanent("AI returned no segments")

    if not has_text(transcript):
        complete(job_id, None, True, duration)
        _log(f"{job_id}: no speech detected")
        return

    complete(job_id, transcript, False, duration)
    _log(f"{job_id}: done ({len(transcript['segments'])} segments)")


# ---------------------------------------------------------------------------
# Loop
# ---------------------------------------------------------------------------
def missing_config():
    for name, value in (
        ("API_BASE", API_BASE),
        ("INTERNAL_SECRET", INTERNAL_SECRET),
        ("AI_PROCESS_URL", AI_PROCESS_URL),
    ):
        if not value:
            return name
    return None


def loop():
    _log(f"processor starting as {WORKER_ID}")
    while True:
        missing = missing_config()
        if missing:
            # Do not hammer anything before the secrets are wired.
            _log(f"config incomplete: {missing} unset — sleeping")
            time.sleep(15)
            continue

        try:
            job = claim_next()
        except requests.RequestException as e:
            _log(f"claim failed: {e}")
            time.sleep(POLL_INTERVAL)
            continue

        if not job:
            time.sleep(POLL_INTERVAL)
            continue

        # Only wait on the clinical gate once there is real work to run, so an idle loop
        # never probes.
        wait_for_clinical_window()

        job_id = job["id"]
        _log(f"{job_id}: claimed (attempt {job.get('attempts')})")
        try:
            process(job)
        except Permanent as e:
            _log(f"{job_id}: permanent failure: {e}")
            fail(job_id, e, "permanent")
        except Transient as e:
            _log(f"{job_id}: transient failure: {e}")
            fail(job_id, e, "transient")
        except Exception as e:  # noqa: BLE001 — an unexpected bug must not kill the loop
            _log(f"{job_id}: unexpected error: {e}")
            fail(job_id, e, "transient")
