"""Watch a take travel the WHOLE system — the deep end-to-end layer.

The scenario suite proves the device half (record → upload → verified bytes). This
module follows the audio all the way through the backend:

    recorder ──▶ device-api ──▶ Storage + DB row ──▶ queued ──▶ cf-processor
    (record)     (chunked        (sate_device_       (status)    claims the job
                  HTTPS)          sessions)                          │
                                                                     ▼
    done ◀── finalize-session ◀───────────── AI /process (self-hosted CUDA)
    (processed_at, recording_id)

Everything here reads the same rows the web app reads (user JWT + RLS), so it sees
exactly what a clinician would. Stage timings come from the row's own timestamps:

    queue wait  = processing_started_at - created_at
    processing  = processed_at - processing_started_at   (cf-processor + AI + finalize)
    total       = processed_at - created_at

`watch()` polls a session to completion, invoking a callback on every stage change —
that one callback feeds the CLI (`sate e2e`), the desktop live graph, or anything
else. `snapshot()` is one poll, for pure rendering.
"""
from __future__ import annotations

import datetime as _dt
import json
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, List, Optional

from . import sate_account as A

# The canonical stage order shown everywhere (graph nodes, CLI, reports).
STAGES = [
    ("record",   "Recorder",       "capturing audio on the device"),
    ("upload",   "device-api",     "chunked HTTPS upload"),
    ("stored",   "Storage + DB",   "WAV in Storage, session row written"),
    ("queued",   "Queue",          "waiting for the processor"),
    ("claimed",  "Cloudflare",     "cf-processor claimed the job"),
    ("ai",       "AI service",     "transcription in flight"),
    ("finalize", "Finalize",       "analysis stored, recording created"),
    ("done",     "Done",           "visible in the clinician report"),
]
STAGE_KEYS = [k for k, _, _ in STAGES]

SESSIONS_REST = A.SUPABASE_URL + "/rest/v1/sate_device_sessions"


def _get(url: str, token: str) -> list:
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}", "apikey": A.ANON_KEY})
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.loads(r.read().decode())
    return d if isinstance(d, list) else []


def _ts(v: Optional[str]) -> Optional[float]:
    if not v:
        return None
    try:
        return _dt.datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


@dataclass
class SessionState:
    """One session row, digested into pipeline terms."""
    session_number: int
    bytes: int
    status: str                      # queued | processing | done | error
    created: Optional[float]
    started: Optional[float]         # processing_started_at
    done: Optional[float]            # processed_at
    recording_id: Optional[str]
    error: Optional[str]
    attempts: int
    device_serial: str = ""
    row_id: str = ""

    @property
    def stage(self) -> str:
        """Where the audio is right now, in STAGES terms."""
        if self.status == "error":
            return "error"
        if self.status == "done":
            return "done"
        if self.status == "processing":
            # cf-processor holds the job through claim → AI → finalize; without a
            # finer-grained timestamp the live view treats it as "ai" (the long part).
            return "ai"
        return "queued"   # row exists but nothing claimed it yet

    @property
    def queue_wait_s(self) -> Optional[float]:
        if self.created and self.started:
            return max(0.0, self.started - self.created)
        return None

    @property
    def processing_s(self) -> Optional[float]:
        if self.started and self.done:
            return max(0.0, self.done - self.started)
        return None

    @property
    def total_s(self) -> Optional[float]:
        if self.created and self.done:
            return max(0.0, self.done - self.created)
        return None


def _row_to_state(x: dict) -> SessionState:
    return SessionState(
        session_number=int(x.get("session_number") or 0),
        bytes=int(x.get("bytes") or 0),
        status=str(x.get("status") or ("done" if x.get("processed") else "queued")),
        created=_ts(x.get("created_at")),
        started=_ts(x.get("processing_started_at")),
        done=_ts(x.get("processed_at")),
        recording_id=x.get("recording_id"),
        error=x.get("process_error"),
        attempts=int(x.get("attempts") or 0),
        device_serial=str(x.get("device_serial") or ""),
        row_id=str(x.get("id") or ""),
    )


_SELECT = ("select=id,session_number,bytes,status,created_at,processing_started_at,"
           "processed_at,recording_id,process_error,attempts,device_serial,processed")


def recent_sessions(token: str, device_serial: str, limit: int = 12) -> List[SessionState]:
    """Newest-first history — feeds the 'how long did past runs take' panel."""
    url = (f"{SESSIONS_REST}?{_SELECT}"
           f"&device_serial=eq.{urllib.parse.quote(device_serial)}"
           f"&order=created_at.desc&limit={limit}")
    return [_row_to_state(x) for x in _get(url, token)]


def session_by_number(token: str, device_serial: str, number: int) -> Optional[SessionState]:
    url = (f"{SESSIONS_REST}?{_SELECT}"
           f"&device_serial=eq.{urllib.parse.quote(device_serial)}"
           f"&session_number=eq.{number}&order=created_at.desc&limit=1")
    rows = _get(url, token)
    return _row_to_state(rows[0]) if rows else None


@dataclass
class Snapshot:
    """One poll of the whole picture: the in-flight take + history."""
    device_state: str                # idle | recording | uploading | offline
    active: Optional[SessionState]   # newest not-done session, if any
    history: List[SessionState] = field(default_factory=list)

    @property
    def live_stage(self) -> str:
        if self.device_state == "recording":
            return "record"
        if self.device_state == "uploading":
            return "upload"
        if self.active:
            return self.active.stage
        return "done"


def snapshot(token: str, device_serial: str, limit: int = 12) -> Snapshot:
    dev_state = "offline"
    try:
        for d in A.list_devices(token):
            if str(d.get("serial", "")) == device_serial:
                dev_state = str(d.get("state") or "idle") if d.get("online") else "offline"
                break
    except Exception:  # noqa: BLE001
        pass
    hist = recent_sessions(token, device_serial, limit)
    active = next((s for s in hist if s.status in ("queued", "processing")), None)
    return Snapshot(device_state=dev_state, active=active, history=hist)


def watch(token: str, device_serial: str, session_number: int, *,
          timeout_s: float = 600, poll_s: float = 2.0,
          on_change: Callable[[SessionState], None] = lambda s: None,
          baseline_created: Optional[float] = None) -> SessionState:
    """Poll ONE session until done/error/timeout, firing on_change per stage move.

    baseline_created guards against matching an OLD row with the same session
    number (numbers restart after unlink/reset): rows older than it are ignored.
    """
    last_stage = None
    end = time.monotonic() + timeout_s
    state = None
    while time.monotonic() < end:
        s = session_by_number(token, device_serial, session_number)
        if s and (baseline_created is None or (s.created or 0) > baseline_created):
            state = s
            if s.stage != last_stage:
                last_stage = s.stage
                on_change(s)
            if s.status in ("done", "error"):
                return s
        time.sleep(poll_s)
    if state:
        return state
    raise TimeoutError(f"session {session_number} never appeared on the server")


__all__ = ["STAGES", "STAGE_KEYS", "SessionState", "Snapshot",
           "recent_sessions", "session_by_number", "snapshot", "watch"]
