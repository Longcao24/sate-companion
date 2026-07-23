"""In-memory device that replays the firmware's real log lines.

This is NOT a firmware emulator — it exists so the harness's OWN assertions can be
self-tested with no board attached (`run.py --sim`). It implements the same Link /
Server / Actions interfaces the real backends do, and emits the exact `[MEM]` /
`[CONN]` / `[REC]` markers a healthy device prints, so a green --sim run proves the
plumbing (reset → record → parse bytes → verify) is wired correctly.
"""
from __future__ import annotations

from .context import Actions
from .link import QueueLink
from .server import BaseServer

BOOT_LINES = [
    "[DISPLAY] Double-buffered LVGL draw buffers (PSRAM).",
    "[CONN] serial=SATE-SIM01 provisioned=1",
    "[MEM] ready               int free=210000  largest=190000  min=180000  psram free=4000000",
]


class SimBackend(Actions, BaseServer):
    def __init__(self, cfg: dict, log=print):
        self.cfg = cfg
        self.log = log
        self.link = QueueLink()
        self._recording = False
        self._session = 0
        self._next_session = 1
        self._stored: dict[tuple[str, int], int] = {}
        self._pending_heal = False
        rec = cfg.get("record", {})
        self._take_bytes = int(rec.get("take_s", 6)) * 32000 + 44
        self._patient = rec.get("patient_id", "Unassigned")

    # -- Link.reset() equivalent is driven through Actions.trigger_reboot() below --

    # ---- Actions ----
    def prompt(self, message: str) -> None:
        self.log(f"    ▸ (sim) {message}")

    def trigger_record(self, local: bool = False) -> None:
        self._recording = True
        self._session = self._next_session
        self.link.push("[MEM] record start        int free=200000  largest=180000  min=170000  psram free=3900000")

    def trigger_stop(self) -> None:
        if not self._recording:
            return
        self._recording = False
        n, b = self._session, self._take_bytes
        self._stored[(self._patient, n)] = b
        self._next_session += 1
        self.link.push(f"[CONN] uploaded {self._patient} session {n} ({b} bytes) in 1400 ms", delay=0.1)
        # A synced take beyond the newest 5 would be reclaimed — always server-confirmed.
        self.link.push(f"[CONN] freed synced audio {self._patient} session 0 (server-confirmed, keep newest 5)", delay=0.15)

    def trigger_reboot(self) -> None:
        for i, ln in enumerate(BOOT_LINES):
            self.link.push(ln, delay=0.05 * (i + 1))
        tail = 0.05 * (len(BOOT_LINES) + 1)
        if self._recording:
            # A take was in progress → the firmware resumes it on boot.
            self.link.push(
                f"[REC] resume session {self._session} from part 0 (32000 bytes already on card)",
                delay=tail,
            )
        if self._pending_heal:
            self._pending_heal = False
            self.link.push("[REC] healed interrupted delete in /sate/patients/PT (scanned 5)", delay=tail)

    def trigger_delete(self, session_number: int) -> None:
        # Simulate an interrupted renumber that heals on the next boot…
        self._pending_heal = True
        # …and a concurrent in-flight take finishing byte-exact (no offset gap), so
        # the delete_during_upload scenario has an upload to verify against.
        n, b = self._next_session, self._take_bytes
        self._stored[(self._patient, n)] = b
        self._next_session += 1
        # delay past the gap-watch window so the upload-watch is what catches it
        # (on real hardware the upload completes seconds after the delete).
        self.link.push(f"[CONN] uploaded {self._patient} session {n} ({b} bytes) in 1500 ms", delay=0.6)

    # ---- Server ----
    def available(self) -> bool:
        return True

    def verify(self, patient_id: str, session_number: int, byte_count: int) -> bool:
        return self._stored.get((patient_id, session_number)) == byte_count
