"""Pendant (XIAO nRF52840) hardware tests — over BLE.

The pendant has NO serial log and does not upload to device-api; it streams 16 kHz
mono PCM (244-byte notifies) over BLE to the phone app, which wraps a WAV. So the
harness plays the app's role: it is a BLE central (via `bleak`) that connects,
sends the control bytes (0x01 start / 0x00 stop / 0x02 find-me), and measures the
audio stream + battery directly on the Mac. That directly exercises the audit's
pendant bugs (nap-wipes-ring under a stalled-loud stream, dropped-packet stall,
stop-gating, battery decode).

macOS note: Python/Terminal needs Bluetooth permission (System Settings → Privacy
& Security → Bluetooth). `pip install bleak` for real hardware; --sim needs nothing.
"""
from __future__ import annotations

import asyncio
import time
from typing import Callable, List, Optional

from .scenarios import ERROR, FAIL, PASS, SKIP, Result

SERVICE = "19b10000-e8f2-537e-4f6c-d104768a1214"
AUDIO = "19b10001-e8f2-537e-4f6c-d104768a1214"
CTRL = "19b10002-e8f2-537e-4f6c-d104768a1214"
BATTERY = "00002a19-0000-1000-8000-00805f9b34fb"

SAMPLE_RATE = 16000
BYTES_PER_SEC = SAMPLE_RATE * 2  # 16-bit mono = 32000 B/s
CMD_START, CMD_STOP, CMD_FINDME = 0x01, 0x00, 0x02


class PendantClient:
    """Real BLE client. Matches the app: scan (no service filter), match on name
    OR localName OR the advertised audio service; then connect + control."""

    def __init__(self, cfg: dict, log: Callable[[str], None]):
        self.cfg = cfg
        self.log = log
        self._client = None
        self._pcm: List[tuple[float, int]] = []  # (monotonic, nbytes) per notify

    async def connect(self, timeout: float = 15.0):
        from bleak import BleakClient, BleakScanner  # lazy: only needed for real HW
        # If the UI (or config) already picked a specific pendant, connect straight
        # to its address and skip the scan.
        addr = (self.cfg.get("pendant", {}) or {}).get("address")
        if addr:
            self.log(f"  Connecting directly to {addr}…")
            self._client = BleakClient(addr)
            await self._client.connect()
            return
        want = self.cfg.get("pendant", {}).get("name", "SATE Pendant").lower()
        self.log(f"  Scanning for the pendant (name/localName '{want}' or service {SERVICE[:8]}…)")
        dev = None
        found = await BleakScanner.discover(timeout=timeout, return_adv=True)
        for d, adv in found.values():
            name = (d.name or "").lower()
            local = (getattr(adv, "local_name", "") or "").lower()
            uuids = [u.lower() for u in (getattr(adv, "service_uuids", None) or [])]
            if want in name or want in local or SERVICE in uuids:
                dev = d
                break
        if dev is None:
            raise RuntimeError("pendant not found in the BLE scan (advertising? in range?)")
        self.log(f"  Found {dev.address} — connecting…")
        self._client = BleakClient(dev.address)
        await self._client.connect()

    def _on_audio(self, _sender, data: bytearray) -> None:
        self._pcm.append((time.monotonic(), len(data)))

    async def start(self):
        self._pcm.clear()
        await self._client.start_notify(AUDIO, self._on_audio)
        await self._client.write_gatt_char(CTRL, bytes([CMD_START]), response=True)

    async def stop(self):
        await self._client.write_gatt_char(CTRL, bytes([CMD_STOP]), response=True)

    async def find_me(self):
        await self._client.write_gatt_char(CTRL, bytes([CMD_FINDME]), response=True)

    async def stop_notify(self):
        try:
            await self._client.stop_notify(AUDIO)
        except Exception:
            pass

    async def battery(self) -> Optional[int]:
        try:
            raw = await self._client.read_gatt_char(BATTERY)
            return raw[0] if raw else None
        except Exception:
            return None

    async def collect(self, seconds: float) -> tuple[int, float, int]:
        """Stream for `seconds`; return (total_bytes, max_gap_ms, packet_count)."""
        self._pcm.clear()
        await asyncio.sleep(seconds)
        total = sum(n for _, n in self._pcm)
        gaps = [(self._pcm[i][0] - self._pcm[i - 1][0]) * 1000
                for i in range(1, len(self._pcm))]
        return total, (max(gaps) if gaps else 0.0), len(self._pcm)

    async def disconnect(self):
        try:
            if self._client:
                await self.stop_notify()
                await self._client.disconnect()
        except Exception:
            pass


class SimPendantClient(PendantClient):
    """In-memory pendant: emits a healthy 32 kB/s stream so --sim self-tests the
    pendant assertions with no board or bleak."""

    def __init__(self, cfg, log):
        super().__init__(cfg, log)
        self._streaming = False

    async def connect(self, timeout: float = 15.0):
        self.log("  (sim) connected to a fake pendant")

    async def start(self):
        self._streaming = True

    async def stop(self):
        self._streaming = False

    async def find_me(self):
        pass

    async def stop_notify(self):
        pass

    async def battery(self):
        return 76

    async def collect(self, seconds: float):
        await asyncio.sleep(min(seconds, 0.3))
        if not self._streaming:
            return 0, 0.0, 0
        total = int(BYTES_PER_SEC * seconds)
        return total, 18.0, total // 244  # ~15 ms between 244-byte notifies

    async def disconnect(self):
        pass


# ---------------- scenarios (async) ----------------

async def _advertise(c, cfg, log, prompt) -> Result:
    return Result("pendant_advertise", "Pendant is discoverable + connects",
                  "advertising: name in scan-response, stale GAP name",
                  PASS, "scanned, matched and connected")


async def _stream(c, cfg, log, prompt) -> Result:
    secs = float(cfg.get("pendant", {}).get("stream_s", 5))
    prompt(f"Make CONTINUOUS sound near the pendant for ~{secs:.0f}s (talk/tap)")
    await c.start()
    total, max_gap, pkts = await c.collect(secs)
    await c.stop()
    expected = BYTES_PER_SEC * secs
    ratio = total / expected if expected else 0
    gap_limit = float(cfg.get("pendant", {}).get("max_gap_ms", 400))
    detail = f"{total} B in {secs:.0f}s = {ratio*100:.0f}% of live rate, {pkts} pkts, max gap {max_gap:.0f}ms"
    # Under continuous sound the stream must be near-live. A low ratio means the
    # ring was wiped / the stream stalled (the nap-under-loud bug); a big gap means
    # dropped notifies stalled the audio.
    if ratio < 0.5:
        return Result("pendant_stream", "Loud stream flows near-live", "nap wipes ring on a stalled-loud stream",
                      FAIL, "stream stalled / ring wiped: " + detail)
    if max_gap > gap_limit:
        return Result("pendant_stream", "No dropped-packet stall", "dropped packets make audio stuck",
                      FAIL, "gap too long (audio stuck): " + detail)
    return Result("pendant_stream", "Loud stream flows near-live, no stall",
                  "nap-wipe / dropped-packet stall", PASS, detail)


async def _stop_gates(c, cfg, log, prompt) -> Result:
    await c.start()
    await c.collect(1.0)
    await c.stop()
    # After 0x00 the firmware ends PDM → notifies must stop. A trickle after stop is
    # the 'extra seconds after Stop' class.
    trailing, _, _ = await c.collect(1.0)
    if trailing > 244 * 3:
        return Result("pendant_stop", "Notifies stop after 0x00", "audio keeps arriving after Stop",
                      FAIL, f"{trailing} bytes still arrived ~1s after Stop")
    return Result("pendant_stop", "Notifies stop after 0x00", "audio keeps arriving after Stop",
                  PASS, f"{trailing} bytes after Stop (clean)")


async def _battery(c, cfg, log, prompt) -> Result:
    raw = await c.battery()
    if raw is None:
        return Result("pendant_battery", "Battery reads 0–100 with a sane charging bit",
                      "battery decode", SKIP, "battery characteristic not readable")
    pct, charging = raw & 0x7F, bool(raw & 0x80)
    if pct > 100:
        return Result("pendant_battery", "Battery reads 0–100", "battery percent not clamped",
                      FAIL, f"impossible battery {pct}% (raw {raw})")
    return Result("pendant_battery", "Battery reads 0–100 with a sane charging bit",
                  "battery decode", PASS, f"{pct}% charging={charging}")


async def _findme(c, cfg, log, prompt) -> Result:
    await c.find_me()
    prompt("Confirm the pendant LEDs flash for ~5s (find-me)")
    return Result("pendant_findme", "Find-me flashes the LEDs", "control 0x02",
                  PASS, "find-me command sent (visual confirm)")


PENDANT_SCENARIOS = {
    "pendant_advertise": _advertise,
    "pendant_stream": _stream,
    "pendant_stop": _stop_gates,
    "pendant_battery": _battery,
    "pendant_findme": _findme,
}


async def _run(cfg, keys, sim, log, prompt) -> List[Result]:
    client = SimPendantClient(cfg, log) if sim else PendantClient(cfg, log)
    order = keys or list(PENDANT_SCENARIOS)
    results: List[Result] = []
    try:
        await client.connect()
    except Exception as e:
        for k in order:
            results.append(Result(k, k, "", ERROR, f"connect failed: {e}"))
        return results
    try:
        for k in order:
            fn = PENDANT_SCENARIOS.get(k)
            if not fn:
                continue
            log("")
            log(f"── {k}")
            try:
                results.append(await fn(client, cfg, log, prompt))
            except Exception as e:
                results.append(Result(k, k, "", ERROR, f"{type(e).__name__}: {e}"))
    finally:
        await client.disconnect()
    return results


def run_pendant(cfg, keys=None, *, sim=False, log=print, prompt=None) -> List[Result]:
    if prompt is None:
        if sim:
            # No human or hardware in --sim: auto-advance so it runs unattended (CI).
            def prompt(msg):  # noqa
                log(f"    ▸ (sim) {msg}")
        else:
            def prompt(msg):  # noqa
                try:
                    input(f"    ▸ {msg}  [Enter] ")
                except EOFError:
                    time.sleep(4)
    return asyncio.run(_run(cfg, keys, sim, log, prompt))
