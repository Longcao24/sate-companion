"""Serial link to the recorder — the real one (pyserial) and the sim one.

The recorder's USB is a USB-Serial-JTAG port (/dev/cu.usbmodem*). Serial output
only appears when the firmware was built with CDCOnBoot=cdc,USBMode=hwcdc, and a
reset-to-run is done by pulsing RTS(EN)/DTR(GPIO0) — see CLAUDE.md. This module
encodes that so a test can reboot the board and read its boot/heartbeat log.
"""
from __future__ import annotations

import re
import time
from collections import deque
from typing import Optional


class BaseLink:
    """Common line-matching helpers over a raw readline()/reset()."""

    def reset(self) -> None:
        raise NotImplementedError

    def readline(self, timeout: float) -> Optional[str]:
        """One log line without the trailing newline, or None if `timeout` s pass."""
        raise NotImplementedError

    def drain(self) -> None:
        pass

    def close(self) -> None:
        pass

    # -- higher level, shared by every implementation --------------------------
    def wait_for(self, pattern: str, timeout: float, on_line=None) -> Optional[re.Match]:
        """Read lines until one matches `pattern` (regex). Returns the match or None."""
        rx = re.compile(pattern)
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            line = self.readline(remaining)
            if line is None:
                continue
            if on_line:
                on_line(line)
            m = rx.search(line)
            if m:
                return m

    def expect_absent(self, pattern: str, window: float, on_line=None) -> bool:
        """True if NO line matches `pattern` during `window` seconds (used to prove
        a crash/panic/boot-hang marker never appears)."""
        rx = re.compile(pattern)
        deadline = time.monotonic() + window
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return True
            line = self.readline(remaining)
            if line is None:
                continue
            if on_line:
                on_line(line)
            if rx.search(line):
                return False


class SerialLink(BaseLink):
    """Real USB serial link to an attached recorder."""

    def __init__(self, port: str, baud: int = 115200):
        try:
            import serial  # pyserial
        except ImportError as e:  # pragma: no cover - environment dependent
            raise RuntimeError(
                "pyserial is not installed. Run `pip install pyserial` "
                "(or use --sim to self-test the harness without hardware)."
            ) from e
        self._ser = serial.Serial(port, baud, timeout=0.2)
        self._buf = b""

    def reset(self) -> None:
        # esptool "classic" hard reset to RUN the app (not the bootloader):
        #   DTR -> GPIO0 HIGH (normal boot), RTS -> EN LOW (assert reset), release.
        s = self._ser
        s.setDTR(False)
        s.setRTS(True)
        time.sleep(0.12)
        s.setRTS(False)
        time.sleep(0.05)
        self.drain()

    def readline(self, timeout: float) -> Optional[str]:
        end = time.monotonic() + timeout
        while True:
            nl = self._buf.find(b"\n")
            if nl >= 0:
                line, self._buf = self._buf[:nl], self._buf[nl + 1:]
                return line.decode("utf-8", "replace").rstrip("\r")
            self._ser.timeout = max(0.01, min(0.2, end - time.monotonic()))
            chunk = self._ser.read(256)
            if chunk:
                self._buf += chunk
            if time.monotonic() >= end and b"\n" not in self._buf:
                return None

    def drain(self) -> None:
        self._buf = b""
        try:
            self._ser.reset_input_buffer()
        except Exception:
            pass

    def screendump(self, timeout: float = 10.0):
        """Ask a --debug-build recorder for one screen snapshot over THIS serial link.
        Returns (w, h, rgb888) or raises. Cheap: one lv_snapshot, freed immediately.
        Call only between scenario steps (never mid-capture) so it can't disturb a take."""
        import base64
        import re
        self.drain()
        self._ser.write(b"SCREENDUMP\n")
        deadline = time.monotonic() + timeout
        w = h = 0
        swap = False
        b64: list[str] = []
        collecting = began = False
        b64_re = re.compile(r"^[A-Za-z0-9+/=]+$")
        while time.monotonic() < deadline:
            s = self.readline(max(0.05, deadline - time.monotonic()))
            if not s:
                continue
            s = s.strip()
            if s.startswith("[SCREENSHOT-ERR"):
                raise RuntimeError(s)
            m = re.search(r"\[SCREENSHOT-BEGIN w=(\d+) h=(\d+).*swap=(\d+)", s)
            if m:
                w, h, swap = int(m.group(1)), int(m.group(2)), m.group(3) == "1"
                collecting = began = True
                continue
            if "[SCREENSHOT-END]" in s:
                break
            if collecting and b64_re.match(s):
                b64.append(s)
        if not began:
            raise RuntimeError("no screendump response (needs a --debug build)")
        data = base64.b64decode("".join(b64), validate=False)
        want = w * h * 2
        if len(data) < want:
            data = data + b"\x00" * (want - len(data))
        # RGB565 -> RGB888
        buf = data[:want]
        rgb = bytearray((len(buf) // 2) * 3)
        o = 0
        for i in range(0, len(buf) - 1, 2):
            v = (buf[i] << 8) | buf[i + 1] if swap else (buf[i + 1] << 8) | buf[i]
            r = (v >> 11) & 0x1f
            g = (v >> 5) & 0x3f
            b = v & 0x1f
            rgb[o] = (r << 3) | (r >> 2)
            rgb[o + 1] = (g << 2) | (g >> 4)
            rgb[o + 2] = (b << 3) | (b >> 2)
            o += 3
        return w, h, bytes(rgb)

    def close(self) -> None:
        try:
            self._ser.close()
        except Exception:
            pass


class QueueLink(BaseLink):
    """A link fed by an in-memory queue of (monotonic_deadline, line) events.
    The sim backend pushes the firmware's real log lines here so a test's
    assertions run unchanged against a board that isn't there."""

    def __init__(self):
        self._events: deque[tuple[float, str]] = deque()
        self._hb_line: Optional[str] = None   # periodic line the device emits on its own
        self._hb_period = 0.0
        self._hb_next = 0.0

    def push(self, line: str, delay: float = 0.0) -> None:
        self._events.append((time.monotonic() + delay, line))

    def set_idle_heartbeat(self, line: str, period: float) -> None:
        """A line the simulated device emits by itself, forever, on a cadence.

        Some behaviour is only observable because the device reports it unprompted
        (the idle reclaim sweep's card inventory). Scheduling a fixed burst instead
        would be consumed by whichever scenario happens to read first."""
        self._hb_line, self._hb_period = line, period
        self._hb_next = time.monotonic() + period

    def reset(self) -> None:
        # The sim backend scripts boot lines in response to reset(); nothing here.
        pass

    def readline(self, timeout: float) -> Optional[str]:
        end = time.monotonic() + timeout
        while True:
            now = time.monotonic()
            if self._events and self._events[0][0] <= now:
                return self._events.popleft()[1]
            # Scripted lines win; the idle heartbeat only fills genuine quiet.
            if self._hb_line and now >= self._hb_next:
                self._hb_next = now + self._hb_period
                return self._hb_line
            if now >= end:
                return None
            time.sleep(0.005)
