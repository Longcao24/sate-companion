"""Test context + the 'actions' that physically drive the recorder.

Some steps can't be done over USB alone — the RECORD/FLAG keys are physical, and a
true brownout needs a power relay. Actions abstracts those so a scenario reads the
same whether the step is automated (remote command / relay) or done by an operator
at the bench when prompted. The sim backend supplies its own Actions.
"""
from __future__ import annotations

import sys
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

from .link import BaseLink
from .server import BaseServer


class Actions:
    """Physical/remote triggers. Real impl below; sim provides its own."""

    def prompt(self, message: str) -> None:
        raise NotImplementedError

    def trigger_record(self, local: bool = False) -> None:
        raise NotImplementedError

    def trigger_stop(self) -> None:
        raise NotImplementedError

    def trigger_reboot(self) -> None:
        raise NotImplementedError

    def trigger_delete(self, session_number: int) -> None:
        raise NotImplementedError


class BenchActions(Actions):
    """Real bench: reset over serial; physical steps via an operator prompt.

    record_mode:
      - "manual": prompt the operator to press RECORD / Stop / Delete on the device.
      - "remote": (future) queue the command through device-api; noted where used.
    reboot_mode:
      - "reset":  pulse the serial reset line (clean reset — exercises the
                  resume-on-boot path; NOT a true power brownout).
      - "manual": prompt the operator to physically cut and restore power.
    unattended: when True, prompts auto-continue after `prompt_wait` seconds
                (for a rig with a servo/relay where no human is watching).
    """

    def __init__(self, link: BaseLink, *, record_mode: str = "manual",
                 reboot_mode: str = "reset", unattended: bool = False,
                 prompt_wait: float = 6.0, log: Callable[[str], None] = print,
                 prompt_fn: Optional[Callable[[str], None]] = None,
                 base_url: str = "", device_id: str = "",
                 access_token: str = "", anon_key: str = ""):
        self.link = link
        self.record_mode = record_mode
        self.reboot_mode = reboot_mode
        self.unattended = unattended
        self.prompt_wait = prompt_wait
        self.log = log
        self.prompt_fn = prompt_fn  # web UI / custom bridge; falls back to stdin
        # remote-record (record_mode="remote"): queue a device-api command with the
        # signed-in SLP session so the device records ~8s on its own — no button press.
        self.base_url = base_url
        self.device_id = device_id
        self.access_token = access_token
        self.anon_key = anon_key

    def _can_remote(self) -> bool:
        return bool(self.record_mode == "remote" and self.access_token and self.device_id and self.base_url)

    def _send_remote(self, op: str) -> None:
        import json
        import urllib.request
        url = f"{self.base_url}/api/devices/{self.device_id}/commands"
        req = urllib.request.Request(
            url, data=json.dumps({"op": op}).encode(), method="POST",
            headers={"Authorization": f"Bearer {self.access_token}", "apikey": self.anon_key,
                     "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=20):
            pass

    def prompt(self, message: str) -> None:
        if self.prompt_fn is not None:
            self.prompt_fn(message)
            return
        if self.unattended:
            self.log(f"    ▸ {message}  (auto-continue in {self.prompt_wait:.0f}s)")
            time.sleep(self.prompt_wait)
            return
        try:
            input(f"    ▸ {message}  [press Enter] ")
        except EOFError:
            self.log(f"    ▸ {message}  (no TTY — waiting {self.prompt_wait:.0f}s)")
            time.sleep(self.prompt_wait)

    def trigger_record(self, local: bool = False) -> None:
        # `local=True` forces a button-started take (e.g. reboot_resume, which only
        # auto-resumes local takes — remote takes use review=false by design).
        if not local and self._can_remote():
            self.log("    ▸ queuing a remote RECORD command (device records ~8s on its own)…")
            try:
                self._send_remote("record")
                return
            except Exception as e:  # noqa: BLE001
                self.log(f"    ▸ remote record failed ({e}) — falling back to a prompt")
        self.prompt("Press RECORD on the device to start a take")

    def trigger_stop(self) -> None:
        if self._can_remote():
            # fw >=1.5.15 has a real remote "stop" (before that a server-started take
            # could only be ended at the device or by the ~62-min ceiling).
            self.log("    ▸ sending remote STOP command…")
            try:
                self._send_remote("stop")
                return
            except Exception as e:  # noqa: BLE001
                self.log(f"    ▸ remote stop failed ({e}) — falling back to a reset")
                self.link.reset()
                return
        self.prompt("Press RECORD again to STOP the take")

    def trigger_reboot(self) -> None:
        if self.reboot_mode == "manual":
            self.prompt("Cut power to the device, wait ~2s, then restore it")
            return
        # Prefer the remote "reboot" command. A serial reset CANNOT reboot the board
        # while it is recording: on the debug build Serial is USB-CDC, whose DTR/RTS
        # reset is handled in software, and the capture loop never services USB — the
        # pulse is simply never seen. The remote command runs on the core-0 net task,
        # which keeps ticking through a take.
        if self._can_remote():
            self.log("    ▸ sending remote REBOOT command…")
            try:
                self._send_remote("reboot")
                return
            except Exception as e:  # noqa: BLE001
                self.log(f"    ▸ remote reboot failed ({e}) — falling back to a serial reset")
        self.log("    ▸ resetting the device over the serial line…")
        self.link.reset()

    def trigger_delete(self, session_number: int) -> None:
        self.prompt(f"On the Sessions screen, delete session {session_number}")


@dataclass
class Ctx:
    link: BaseLink
    server: BaseServer
    act: Actions
    cfg: dict
    log: Callable[[str], None] = print
    lines: list = field(default_factory=list)

    def record_line(self, line: str) -> None:
        """Callback for wait_for/expect_absent: echo + keep every serial line."""
        self.lines.append(line)
        self.log(f"      │ {line}")

    def patient_id(self) -> str:
        # Standalone recording uses a default patient id; overridable in config.
        return self.cfg.get("record", {}).get("patient_id", "Unassigned")
