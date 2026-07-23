"""BLE client for the SATE Recorder — the app's provisioning/bridge role, headless.

The recorder advertises `SATE_SERVICE` and exposes four GATT characteristics
(INFO read, CONTROL write, STATUS notify, DATA notify). Messages are chunk-framed
`[flag][payload]` (0x01 partial, 0x02 final). This mirrors `src/protocol.ts` and
`src/ble/SateBle.ts` so the laptop's BLE can:

  - read the device identity (model/fw/serial/provisioned)
  - `identify` (beep + flash — a safe connectivity check)
  - `scan_wifi`, `change_wifi` / `provision` (Wi-Fi onto an offline unit)
  - `list_sessions`, `reboot`

Needs `bleak` and, on macOS, Bluetooth permission for the terminal/Python.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Callable, Optional

SATE_SERVICE = "53415445-0001-4a7e-8c5e-000000000001"
CHAR_INFO = "53415445-0001-4a7e-8c5e-000000000010"
CHAR_CONTROL = "53415445-0001-4a7e-8c5e-000000000020"
CHAR_STATUS = "53415445-0001-4a7e-8c5e-000000000030"
CHAR_DATA = "53415445-0001-4a7e-8c5e-000000000040"
FRAME_PARTIAL = 0x01
FRAME_FINAL = 0x02
_CHUNK = 180  # matches the firmware BLE_CHUNK


def _frame(payload: bytes, chunk: int = _CHUNK) -> list[bytes]:
    """Split a payload into `[flag][slice]` packets (0x01 partial, 0x02 final)."""
    packets: list[bytes] = []
    i = 0
    n = len(payload)
    if n == 0:
        return [bytes([FRAME_FINAL])]
    while i < n:
        part = payload[i:i + chunk]
        i += chunk
        flag = FRAME_FINAL if i >= n else FRAME_PARTIAL
        packets.append(bytes([flag]) + part)
    return packets


class RecorderBle:
    """Async BLE link to one recorder. Use as `async with RecorderBle(...) as r:`."""

    def __init__(self, address: str, log: Callable[[str], None] = print):
        from bleak import BleakClient  # imported lazily so --sim / non-BLE runs don't need it
        self._client = BleakClient(address)
        self._log = log
        self._events: "asyncio.Queue[dict]" = asyncio.Queue()
        self._status_buf = bytearray()
        self._data_buf = bytearray()

    # -- discovery -------------------------------------------------------------
    @staticmethod
    async def find(name: str = "SATE-", timeout: float = 8.0) -> Optional[str]:
        """Return the BLE address of the first recorder whose name starts with `name`."""
        from bleak import BleakScanner
        dev = await BleakScanner.find_device_by_filter(
            lambda d, ad: (d.name or ad.local_name or "").upper().startswith(name.upper()),
            timeout=timeout)
        return dev.address if dev else None

    # -- lifecycle -------------------------------------------------------------
    async def __aenter__(self) -> "RecorderBle":
        await self._client.connect()
        await self._client.start_notify(CHAR_STATUS, self._on_status)
        return self

    async def __aexit__(self, *exc) -> None:
        try:
            await self._client.stop_notify(CHAR_STATUS)
        except Exception:
            pass
        try:
            await self._client.disconnect()
        except Exception:
            pass

    def _on_status(self, _char, data: bytearray) -> None:
        if not data:
            return
        flag, payload = data[0], data[1:]
        self._status_buf.extend(payload)
        if flag == FRAME_FINAL:
            raw = bytes(self._status_buf)
            self._status_buf.clear()
            try:
                self._events.put_nowait(json.loads(raw.decode("utf-8", "replace")))
            except json.JSONDecodeError:
                self._log(f"  (ble) non-JSON status: {raw[:60]!r}")

    # -- primitives ------------------------------------------------------------
    async def read_info(self) -> dict:
        raw = await self._client.read_gatt_char(CHAR_INFO)
        return json.loads(bytes(raw).decode("utf-8", "replace"))

    async def send_op(self, op: dict) -> None:
        payload = json.dumps(op, separators=(",", ":")).encode("utf-8")
        for pkt in _frame(payload):
            await self._client.write_gatt_char(CHAR_CONTROL, pkt, response=True)

    async def next_event(self, timeout: float) -> Optional[dict]:
        try:
            return await asyncio.wait_for(self._events.get(), timeout)
        except asyncio.TimeoutError:
            return None

    async def wait_event(self, timeout: float, **match) -> Optional[dict]:
        """Wait for the next event whose fields match all of `match` (e.g. ev='state')."""
        deadline = asyncio.get_event_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                return None
            ev = await self.next_event(remaining)
            if ev is None:
                return None
            if all(ev.get(k) == v for k, v in match.items()):
                return ev

    # -- high-level ops --------------------------------------------------------
    async def identify(self) -> bool:
        """Safe connectivity check: the unit beeps/flashes. Returns True on ack."""
        await self.send_op({"op": "identify"})
        ack = await self.wait_event(6.0, ev="ok", op="identify")
        return ack is not None

    async def scan_wifi(self, timeout: float = 25.0) -> list[dict]:
        await self.send_op({"op": "scan_wifi"})
        ev = await self.wait_event(timeout, ev="scan")
        return (ev or {}).get("networks", [])

    async def change_wifi(self, ssid: str, password: str, timeout: float = 45.0) -> dict:
        """Move an already-claimed unit to a new network (keeps the account)."""
        await self.send_op({"op": "change_wifi", "ssid": ssid, "pass": password})
        return await self._await_provision(timeout)

    async def provision(self, ssid: str, password: str, server: str, claim_token: str,
                        timeout: float = 60.0) -> dict:
        """First-time setup: Wi-Fi creds + claim the device to an account."""
        await self.send_op({"op": "provision", "ssid": ssid, "pass": password,
                            "server": server, "claim_token": claim_token})
        return await self._await_provision(timeout)

    async def _await_provision(self, timeout: float) -> dict:
        """Consume ev:state events until a terminal state (or timeout)."""
        deadline = asyncio.get_event_loop().time() + timeout
        last: dict = {}
        terminal = {"registered", "wifi_saved", "error"}
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                return last or {"state": "timeout"}
            ev = await self.next_event(remaining)
            if ev is None:
                return last or {"state": "timeout"}
            if ev.get("ev") == "state":
                last = ev
                self._log(f"  (ble) state: {ev.get('state')}" + (f"  ip={ev['ip']}" if ev.get("ip") else "")
                          + (f"  {ev['msg']}" if ev.get("msg") else ""))
                if ev.get("state") in terminal:
                    return ev

    async def list_sessions(self, timeout: float = 15.0) -> list[dict]:
        await self.send_op({"op": "list_sessions"})
        ev = await self.wait_event(timeout, ev="sessions")
        return (ev or {}).get("items", [])

    async def reboot(self) -> bool:
        await self.send_op({"op": "reboot"})
        ack = await self.wait_event(6.0, ev="ok", op="reboot")
        return ack is not None
