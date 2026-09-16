"""Offline simulation of a take crossing the WHOLE pipeline — no device, no server.

The live map (`sate pipeline` / the Debugger's pipeline view) only lights up when
real audio is moving: that is deliberate (idle never fakes green), but it makes the
map impossible to demo, review or eyeball-test when no recorder is on the bench.

This module replays the exact same journey in pure Python:

    idle → recording → uploading (real growing byte counts) → the gap (device done,
    row not landed) → row queued → cf-processor claims it → AI in flight → done

It emits the SAME event stream the view's poll thread emits — `("snap", Snapshot)`,
`("upprog", dict)`, `("infra", dict)` — so the map's real state machine (`_flow`)
drives the animation. Nothing in the renderer knows it is a simulation; every stage,
timing readout, byte count and history row goes through the production code path.
That is the point: the simulation exercises the view, it does not re-implement it.

Fidelity rules kept on purpose:

* the take records for EXACTLY the requested duration, and the bytes it lands are
  the true PCM size for that duration (44-byte WAV header + 16 kHz mono S16LE), so
  the map's "audio N vs target" check verifies against real arithmetic;
* upload wall-time is derived from the size, not a fixed sleep;
* the row appears only AFTER the upload finishes, with a gap in between — the same
  blind window the real pipeline has (mid-upload there is no row, only `_tmp` parts);
* stage timestamps (`created` / `processing_started_at` / `processed_at`) are real,
  so queue-wait / processing / total are computed, never hardcoded.

Entry point: `stream(profile, stop)` yields `(kind, payload)` and does its own
sleeping — run it on a thread and push what it yields into the view's queue.
"""
from __future__ import annotations

import random
import time
from dataclasses import dataclass, replace
from typing import Iterator, Optional, Tuple

from .pipeline import SessionState, Snapshot

PCM_BPS = 32000.0          # 16 kHz mono S16LE — bytes per second of audio
WAV_HEADER = 44
UPLOAD_BPS = 1.15e6        # chunked-HTTPS throughput, bytes/s (bench-observed)
PART_BYTES = 256 * 1024    # chunk size the recorder POSTs

Event = Tuple[str, object]


@dataclass
class SimProfile:
    """Shape of the simulated run. Normally only `take_seconds` varies."""
    take_seconds: float = 30.0     # audio length of the take (drives bytes + wall time)
    serial: str = "SIM-RECORDER"
    patient: str = "sim-demo"
    session_number: int = 42
    gap_s: float = 1.8             # device idle, row not landed yet
    queue_s: float = 3.5           # waiting for cf-processor to claim
    process_s: float = 9.0         # claim → AI → finalize
    done_hold_s: float = 13.0      # outlasts the view's 12 s done banner
    tick_s: float = 0.4
    fail: bool = False             # end in `error` instead of `done`

    @property
    def take_bytes(self) -> int:
        return int(WAV_HEADER + self.take_seconds * PCM_BPS)

    @property
    def upload_s(self) -> float:
        return max(1.5, min(45.0, self.take_bytes / UPLOAD_BPS))


HEALTHY_TIERS = {"recorder": "ok", "api": "ok", "storage": "ok",
                 "db": "ok", "worker": "ok", "ai": "ok"}


class _Aborted(Exception):
    """Escape was pressed / the window closed — unwind the whole stream."""


def _finished(now: float, age_s: float, number: int, audio_s: float,
              p: SimProfile) -> SessionState:
    """A plausible past run for the history panel (and the baseline the view takes)."""
    created = now - age_s
    q = random.uniform(1.2, 6.0)
    proc = random.uniform(0.28, 0.55) * audio_s + random.uniform(4.0, 9.0)
    return SessionState(
        session_number=number, bytes=int(WAV_HEADER + audio_s * PCM_BPS), status="done",
        created=created, started=created + q, done=created + q + proc,
        recording_id=f"sim-rec-{number}", error=None, attempts=1,
        device_serial=p.serial, row_id=f"sim-row-{number}", patient_id=p.patient)


class _Sim:
    def __init__(self, p: SimProfile, stop=None):
        self.p, self.stop = p, stop
        now = time.time()
        n = p.session_number
        self.history = [_finished(now, 14 * 60, n - 1, 62, p),
                        _finished(now, 51 * 60, n - 2, 128, p),
                        _finished(now, 96 * 60, n - 3, 33, p)]
        self.row: Optional[SessionState] = None      # the take being simulated

    # ---------------------------------------------------------------- helpers
    def _snap(self, device: str) -> Event:
        row, hist = self.row, self.history
        rows = ([row] + hist) if row is not None else hist
        active = row if (row is not None and row.status in ("queued", "processing")) else None
        return "snap", Snapshot(device_state=device, active=active, history=list(rows))

    def _hold(self, secs: float, device: str, on_tick=None) -> Iterator[Event]:
        """Emit snapshots for `secs` of wall time, at the profile's tick rate."""
        t0 = time.time()
        while True:
            if self.stop is not None and self.stop.is_set():
                raise _Aborted
            frac = 1.0 if secs <= 0 else min(1.0, (time.time() - t0) / secs)
            if on_tick is not None:
                yield from on_tick(frac)
            yield self._snap(device)
            if frac >= 1.0:
                return
            time.sleep(min(self.p.tick_s, max(0.05, secs * 0.02)))

    # ------------------------------------------------------------- the stages
    def run(self) -> Iterator[Event]:
        p = self.p
        yield "simphase", "SIMULATION — armed"
        yield "infra", dict(HEALTHY_TIERS)

        # 0) idle, device online and reachable
        yield from self._hold(1.2, "idle")

        # 1) recording — the audio exists only on the SD card
        yield "simphase", "SIMULATION — recording on the device"
        yield from self._hold(p.take_seconds, "recording")

        # 2) uploading — real growing byte count, still no row on the server
        yield "simphase", "SIMULATION — chunked upload into Storage"
        total = p.take_bytes

        def up_tick(frac):
            sent = int(total * frac)
            yield "upprog", {"uploading": True, "uploads": [{
                "patient_id": p.patient, "session_number": p.session_number,
                "parts": max(1, sent // PART_BYTES), "bytes": sent}]}

        yield from self._hold(p.upload_s, "uploading", on_tick=up_tick)

        # 3) the gap — device idle, the row has not been written yet
        yield "simphase", "SIMULATION — finalizing the upload (row not written yet)"
        yield "upprog", {"uploading": False, "uploads": []}
        yield from self._hold(p.gap_s, "idle")

        # 4) the row lands, status queued
        self.row = SessionState(
            session_number=p.session_number, bytes=total, status="queued",
            created=time.time(), started=None, done=None, recording_id=None,
            error=None, attempts=0, device_serial=p.serial,
            row_id="sim-row-live", patient_id=p.patient)
        yield "simphase", "SIMULATION — queued, waiting for cf-processor"
        yield from self._hold(p.queue_s, "idle")

        # 5) cf-processor claims it → AI /process holds the audio
        self.row = replace(self.row, status="processing", started=time.time(), attempts=1)
        yield "simphase", "SIMULATION — claimed · AI /process holding the audio"
        yield from self._hold(p.process_s, "idle")

        # 6) finalize-session → done (or a permanent error)
        if p.fail:
            self.row = replace(self.row, status="error", attempts=3,
                               error="AI /process 500 — simulated failure")
            yield "simphase", "SIMULATION — finished: ERROR"
        else:
            self.row = replace(self.row, status="done", done=time.time(),
                               recording_id="sim-rec-live")
            yield "simphase", "SIMULATION — finished: done, visible in the report"
        # `_snap` already prepends the live row to the history it publishes —
        # inserting it here too listed the finished take twice.
        yield from self._hold(p.done_hold_s, "idle")


def stream(p: Optional[SimProfile] = None, stop=None) -> Iterator[Event]:
    """The whole journey as `(kind, payload)` events, with its own sleeps.

    kinds: "simphase" (str, for the badge) · "infra" · "snap" · "upprog".
    `stop` is anything with `.is_set()` (a `threading.Event`) — checked every tick,
    so Escape aborts mid-flight instead of after the last sleep.
    """
    try:
        yield from _Sim(p or SimProfile(), stop).run()
    except _Aborted:
        return


__all__ = ["SimProfile", "HEALTHY_TIERS", "stream"]
