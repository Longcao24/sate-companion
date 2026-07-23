"""sate — the hardware CLI for the SATE Companion system.

One professional entry point for testing and flashing the recorder and pendant:

    sate test                 run the hardware-in-the-loop tests (recorder)
    sate test --sim           self-test the harness with no board attached
    sate test -t pendant      test the pendant over BLE
    sate flash recorder       build + flash the recorder firmware
    sate flash pendant        build + flash the pendant firmware
    sate devices              list connected devices (serial ports + BLE)
    sate doctor               check the toolchain and environment
    sate gui | dashboard      launch the native window / browser dashboard
    sate version              show CLI + firmware source versions

Built on the `hwtest` package (scenarios, runner, sim); see `hwtest/README.md`.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

VERSION = "0.1.0"
RECORDER_FQBN = "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi"
PENDANT_FQBN = "Seeeduino:nrf52:xiaonRF52840SensePlus"

# ---------------------------------------------------------------- pretty output
_USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def _c(code: str, s: str) -> str:
    return f"\033[{code}m{s}\033[0m" if _USE_COLOR else s


def bold(s: str) -> str: return _c("1", s)
def dim(s: str) -> str: return _c("2", s)
def green(s: str) -> str: return _c("32", s)
def red(s: str) -> str: return _c("31", s)
def yellow(s: str) -> str: return _c("33", s)
def cyan(s: str) -> str: return _c("36", s)


def ok(msg: str) -> None: print(f"  {green('✓')} {msg}")
def bad(msg: str) -> None: print(f"  {red('✗')} {msg}")
def warn(msg: str) -> None: print(f"  {yellow('!')} {msg}")
def info(msg: str) -> None: print(f"  {cyan('·')} {msg}")


def banner() -> None:
    print(bold(cyan("  sate")) + dim(f"  ·  SATE Companion hardware CLI  ·  v{VERSION}"))


# ---------------------------------------------------------------- repo helpers
def find_repo_root() -> Path:
    """Walk up from this file until we find the firmware sketches / .git."""
    here = Path(__file__).resolve()
    for p in [here] + list(here.parents):
        if (p / "SATE_Recorder").is_dir() or (p / ".git").is_dir():
            return p
    return Path.cwd()


REPO = find_repo_root()


def load_config(path: str | None) -> dict:
    if not path:
        # default to hwtest/config.toml if present
        default = REPO / "hwtest" / "config.toml"
        path = str(default) if default.exists() else None
    if not path:
        return {}
    p = Path(path)
    if not p.exists():
        bad(f"config not found: {path}")
        sys.exit(2)
    try:
        import tomllib  # py3.11+
    except ModuleNotFoundError:  # pragma: no cover
        import tomli as tomllib  # type: ignore
    with p.open("rb") as f:
        return tomllib.load(f)


def _run(cmd: list[str], cwd: Path | None = None) -> int:
    print(dim("  $ " + " ".join(cmd)))
    try:
        return subprocess.call(cmd, cwd=str(cwd) if cwd else None)
    except FileNotFoundError:
        bad(f"command not found: {cmd[0]}")
        return 127


# ---------------------------------------------------------------- commands
def cmd_test(args: argparse.Namespace) -> int:
    from hwtest.runner import run
    from hwtest.scenarios import ALL

    if args.list:
        from hwtest.pendant import PENDANT_SCENARIOS
        print(bold("\nRecorder scenarios") + dim("  (USB serial + device-api)\n"))
        for s in ALL:
            need = dim(f"  [needs: {', '.join(s.requires)}]") if s.requires else ""
            print(f"  {cyan(f'{s.key:22}')} {s.title}{need}")
            print(dim(f"  {'':22} ↳ {s.bug}"))
        print(bold("\nPendant scenarios") + dim("  (BLE — `sate test -t pendant`)\n"))
        for k in PENDANT_SCENARIOS:
            print(f"  {cyan(k)}")
        return 0

    cfg = load_config(args.config)
    keys = [k.strip() for k in args.only.split(",")] if args.only else None

    # Recorder serial port: --port wins, else use config, else auto-detect; and if the
    # configured port has vanished (USB renumber), fall back to the detected one.
    if args.target == "recorder" and not args.sim:
        scfg = cfg.setdefault("serial", {})
        if getattr(args, "port", None):
            scfg["port"] = args.port
        else:
            want = scfg.get("port")
            if not want or not Path(want).exists():
                auto = _auto_port()
                if auto:
                    if want:
                        warn(f"configured port {want} not found — using detected {auto}")
                    scfg["port"] = auto

    if args.target == "pendant":
        from hwtest.pendant import run_pendant
        from hwtest.scenarios import PASS, FAIL, ERROR, SKIP
        col = {PASS: green, FAIL: red, SKIP: yellow, ERROR: lambda s: _c("35", s)}
        results = run_pendant(cfg, keys, sim=args.sim)
        print(bold("\n═════════════ SUMMARY (pendant) ═════════════"))
        for r in results:
            tag = col.get(r.status, str)(f"{r.status:5}")
            print(f"  {tag}  {r.title}: {r.detail}")
        return 1 if any(r.status in (FAIL, ERROR) for r in results) else 0

    if args.sim:
        cfg.setdefault("record", {}).update({"take_s": 1, "resume_hold_s": 0,
                                             "trim_watch_s": 0.3, "gap_wait_s": 0.3,
                                             "upload_wait_s": 3, "delete_target": 1})
    results = run(cfg, keys, sim=args.sim, color=_USE_COLOR)
    return 1 if any(r.status in ("FAIL", "ERROR") for r in results) else 0


def cmd_flash(args: argparse.Namespace) -> int:
    if shutil.which("arduino-cli") is None and args.target == "recorder":
        bad("arduino-cli not found on PATH — see `sate doctor`.")
        return 127

    if args.target == "recorder":
        banner()
        info(f"repo: {REPO}")
        # --debug adds the CDC serial interface so the hwtest harness can read the
        # firmware log ([MEM] ready, [CONN] uploaded, …). Production builds emit no serial.
        fqbn = RECORDER_FQBN + (",CDCOnBoot=cdc,USBMode=hwcdc" if args.debug else "")
        if args.debug:
            info("debug build (CDCOnBoot=cdc) — serial log enabled for `sate test`")
        if not args.upload_only:
            rc = _run(["arduino-cli", "compile", "--fqbn", fqbn, "SATE_Recorder"], cwd=REPO)
            if rc != 0:
                bad("compile failed."); return rc
            ok("compiled")
        if args.compile_only:
            return 0
        port = args.port or _auto_port()
        if not port:
            bad("no serial port found — pass --port /dev/cu.usbmodemXXX (see `sate devices`)."); return 2
        rc = _run(["arduino-cli", "upload", "-p", port, "--fqbn", fqbn, "SATE_Recorder"], cwd=REPO)
        (ok if rc == 0 else bad)("flashed" if rc == 0 else "upload failed")
        return rc

    # pendant
    script = REPO / "SATE_Pendant" / "flash_xiao.sh"
    if not script.exists():
        bad(f"missing {script}"); return 2
    banner()
    warn("pendant uses the SEEED core only (Adafruit Feather core bricks the BLE stack).")
    return _run(["bash", str(script), "SATE_Pendant"], cwd=REPO)


def _auto_port() -> str | None:
    try:
        from serial.tools import list_ports
    except ImportError:
        import glob
        cands = glob.glob("/dev/cu.usbmodem*") + glob.glob("/dev/ttyACM*") + glob.glob("/dev/ttyUSB*")
        return cands[0] if cands else None
    ports = [p.device for p in list_ports.comports() if "usbmodem" in p.device or "ACM" in p.device or "USB" in p.device]
    return ports[0] if ports else None


def cmd_devices(args: argparse.Namespace) -> int:
    banner()
    print(bold("\nSerial ports"))
    try:
        from serial.tools import list_ports
        ports = list(list_ports.comports())
        if not ports:
            warn("no serial ports found (is the recorder plugged in?)")
        for p in ports:
            mark = green(" ← likely recorder") if "usbmodem" in p.device or "ACM" in p.device else ""
            print(f"  {cyan(p.device):30} {dim(p.description or '')}{mark}")
    except ImportError:
        warn("pyserial not installed — `pip install pyserial` (or `sate doctor`).")

    if args.ble:
        print(bold("\nBLE pendants") + dim("  (scanning ~5 s)"))
        rc = _scan_ble(args.name)
        if rc != 0:
            return rc
    else:
        print(dim("\n  add --ble to scan for the pendant over Bluetooth"))
    return 0


def _scan_ble(name_filter: str | None) -> int:
    try:
        import asyncio
        from bleak import BleakScanner
    except ImportError:
        warn("bleak not installed — `pip install bleak` (or `sate doctor`).")
        return 0

    async def scan():
        found = await BleakScanner.discover(timeout=5.0)
        hits = 0
        for d in found:
            nm = d.name or ""
            local = (d.details or {}) if isinstance(d.details, dict) else {}
            if name_filter and name_filter.lower() not in nm.lower():
                continue
            if nm or name_filter:
                print(f"  {cyan(d.address):40} {dim(nm or '(no name)')}")
                hits += 1
        if hits == 0:
            warn("no pendant found — make sure it is advertising (blue LED blinking).")
    try:
        asyncio.run(scan())
        return 0
    except Exception as e:  # noqa: BLE001
        bad(f"BLE scan failed: {e}")
        return 1


CRASH_RX = (r"(Guru Meditation|Backtrace:|abort\(\)|Brownout|assert failed|"
            r"CORRUPT HEAP|StoreProhibited|LoadProhibited|Kernel panic|Panic'ked)")


def _read_serial_log(port: str, seconds: float) -> list[str]:
    """Reset the board and collect its boot/heartbeat log for `seconds`."""
    import time
    from hwtest.link import SerialLink
    link = SerialLink(port)
    lines: list[str] = []
    try:
        link.reset()
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            ln = link.readline(min(1.0, max(0.05, end - time.monotonic())))
            if ln is not None:
                lines.append(ln)
    finally:
        link.close()
    return lines


def _deep_recorder(port: str, seconds: float) -> int:
    print(bold("\nDevice — recorder") + dim(f"  ({port} · reset + read {seconds:g}s of boot log)"))
    try:
        lines = _read_serial_log(port, seconds)
    except Exception as e:  # noqa: BLE001
        bad(f"could not open {port}: {e}")
        info("close any serial monitor / arduino-cli using the port, check the cable, or pass --port")
        return 1
    return _diagnose_recorder_lines(lines, seconds)


def _diagnose_recorder_lines(lines: list[str], seconds: float) -> int:
    """Pure analysis of a recorder boot log → prints findings, returns exit code.
    Split out from I/O so the diagnosis logic is testable without a board."""
    import re

    if not lines:
        bad("no serial output from the board")
        info("wrong CDC build (needs CDCOnBoot=cdc,USBMode=hwcdc), board unpowered, or wrong port")
        return 1

    text = "\n".join(lines)
    faults = 0

    m = re.search(CRASH_RX, text)
    if m:
        bad(f"crash / panic detected: {m.group(0)}"); faults += 1
        for l in lines:
            if re.search(CRASH_RX, l):
                info(dim(l.strip())); break

    boots = sum(1 for l in lines if l.startswith("ESP-ROM:") or "rst:0x" in l)
    if boots > 1:
        warn(f"{boots} boot banners in {seconds:g}s — possible boot-loop (brownout / bad flash)"); faults += 1

    if any("SD_MMC.begin failed" in l or "setPins failed" in l for l in lines):
        bad("SD card init FAILED — reseat the microSD / check wiring"); faults += 1
    else:
        sd = next((l for l in lines if "SD card size MB" in l), None)
        if sd:
            ok(f"SD ok — {sd.strip()}")

    if any("ES8311 init failed" in l for l in lines):
        bad("audio codec ES8311 init FAILED — check the I2C bus / codec"); faults += 1

    if any("Fallback single LVGL" in l for l in lines):
        warn("display fell back to a single draw buffer (low PSRAM?)")
    elif any("[DISPLAY]" in l and "PSRAM" in l for l in lines):
        ok("display init ok (PSRAM draw buffers)")

    ready = next((l for l in lines if "[MEM]" in l and "ready" in l), None)
    if ready:
        ok("setup completed — reached [MEM] ready")
        mm = re.search(r"int free=\s*(\d+).*largest=\s*(\d+).*min=\s*(\d+).*psram free=\s*(\d+)", ready)
        if mm:
            ifree, largest, mn, ps = map(int, mm.groups())
            info(f"heap free={ifree}  largest={largest}  min={mn}  psram free={ps}")
            if ps == 0:
                bad("psram free = 0 — PSRAM not detected (check PSRAM=opi / octal)"); faults += 1
            if 0 < largest < 40000:
                warn(f"largest contiguous block {largest} < 40 KB — TLS handshake / OTA may fail (fragmented heap)")
    else:
        bad(f"did NOT reach [MEM] ready in {seconds:g}s — setup hanging or crashing (SD / audio / services)")
        faults += 1

    pm = re.search(r"provisioned=(\d)", text)
    if pm:
        info("device is " + (green("claimed / provisioned") if pm.group(1) == "1"
                             else yellow("UNCLAIMED — needs onboarding")))

    regs = [l for l in lines if "register attempt" in l]
    if regs:
        cm = re.search(r"code=(-?\d+)", regs[-1])
        if cm and int(cm.group(1)) < 0:
            warn(f"registration failing — {regs[-1].strip()}  (check Wi-Fi / server / device key)")

    print()
    if faults == 0:
        ok(green(f"no hardware faults detected  ({len(lines)} log lines read)"))
        info(dim("note: a frozen screen despite [MEM] ready = the LV_TICK_CUSTOM trap — verify the screen visually"))
    else:
        bad(red(f"{faults} hardware fault(s) detected — see above"))
    return 1 if faults else 0


def _deep_pendant(name: str | None, seconds: float) -> int:
    print(bold("\nDevice — pendant") + dim(f"  (BLE scan + connect, {seconds:g}s)"))
    try:
        import asyncio
        from bleak import BleakClient, BleakScanner
    except ImportError:
        warn("bleak not installed — `pip install bleak`")
        return 1

    want = (name or "SATE").lower()

    async def probe() -> int:
        dev = await BleakScanner.find_device_by_filter(
            lambda d, ad: want in ((d.name or ad.local_name or "").lower()), timeout=seconds)
        if not dev:
            bad("pendant not found advertising — check it is powered and the blue LED is blinking")
            return 1
        ok(f"advertising: {dev.name or '(scan-response name)'}  [{dev.address}]")
        try:
            async with BleakClient(dev) as client:
                ok("connected")
                try:
                    val = await client.read_gatt_char("00002a19-0000-1000-8000-00805f9b34fb")
                    b = val[0]
                    ok(f"battery {b & 0x7f}%  charging={'yes' if b & 0x80 else 'no'}")
                except Exception:  # noqa: BLE001
                    warn("connected but could not read the battery characteristic")
            ok(green("pendant healthy — advertises, connects, and responds"))
            return 0
        except Exception as e:  # noqa: BLE001
            bad(f"found but connect failed: {e}")
            return 1

    try:
        return asyncio.run(probe())
    except Exception as e:  # noqa: BLE001
        bad(f"BLE probe failed: {e}")
        return 1


def cmd_doctor(args: argparse.Namespace) -> int:
    banner()
    print(bold("\nEnvironment"))
    py = sys.version_info
    (ok if py >= (3, 10) else bad)(f"Python {py.major}.{py.minor}.{py.micro}" + ("" if py >= (3, 10) else "  (need ≥ 3.10)"))

    for mod, why in [("serial", "recorder serial + device discovery"), ("bleak", "pendant BLE")]:
        try:
            __import__(mod); ok(f"{mod} installed  {dim('— ' + why)}")
        except ImportError:
            warn(f"{mod} missing  {dim('— ' + why)}  →  pip install -r hwtest/requirements.txt")

    print(bold("\nToolchain"))
    for tool, why in [("arduino-cli", "build + flash firmware"), ("git", "version source of truth")]:
        (ok if shutil.which(tool) else warn)(f"{tool} " + ("found" if shutil.which(tool) else "missing") + dim(f"  — {why}"))

    print(bold("\nProject"))
    info(f"repo root: {REPO}")
    cfg = REPO / "hwtest" / "config.toml"
    (ok if cfg.exists() else warn)(f"config.toml " + ("present" if cfg.exists() else "missing — copy hwtest/config.example.toml"))
    port = _auto_port()
    (ok if port else warn)(f"serial port: {port}" if port else "no recorder serial port detected")

    # --device: actually probe the attached hardware and surface real faults
    if getattr(args, "device", False):
        if args.target == "pendant":
            return _deep_pendant(args.name, args.seconds)
        target_port = args.port or port
        if not target_port:
            bad("no serial port — plug in the recorder or pass --port (see `sate devices`)")
            return 2
        return _deep_recorder(target_port, args.seconds)
    else:
        print(dim("\n  add --device to reset the board and diagnose real hardware faults"))
    return 0


def cmd_gui(args: argparse.Namespace) -> int:
    return _run([sys.executable, str(REPO / "hwtest" / "gui.py")], cwd=REPO / "hwtest")


def cmd_dashboard(args: argparse.Namespace) -> int:
    return _run([sys.executable, str(REPO / "hwtest" / "dashboard.py")], cwd=REPO / "hwtest")


def cmd_version(args: argparse.Namespace) -> int:
    banner()
    print()
    info(f"CLI: {VERSION}")
    for label, sketch, const in [
        ("recorder fw", "SATE_Recorder/SATE_Recorder.ino", "FIRMWARE_VERSION"),
        ("pendant fw", "SATE_Pendant/SATE_Pendant.ino", "FIRMWARE_VERSION"),
    ]:
        v = _grep_version(REPO / sketch, const)
        info(f"{label}: {v or dim('unknown')}  {dim(sketch)}")
    return 0


def _grep_version(path: Path, const: str) -> str | None:
    try:
        for line in path.read_text(errors="ignore").splitlines():
            if const in line and '"' in line:
                return line.split('"')[1]
    except OSError:
        return None
    return None


# ---------------------------------------------------------------- arg parsing
def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="sate",
        description="SATE Companion hardware CLI — test and flash the recorder & pendant.",
        epilog="Run `sate <command> -h` for command options.  Docs: https://sate-docs.pages.dev",
    )
    ap.add_argument("--version", action="version", version=f"sate {VERSION}")
    sub = ap.add_subparsers(dest="cmd", metavar="<command>")

    t = sub.add_parser("test", help="run hardware-in-the-loop tests")
    t.add_argument("-t", "--target", choices=["recorder", "pendant"], default="recorder")
    t.add_argument("-p", "--port", help="recorder serial port (overrides config; auto-detected if omitted)")
    t.add_argument("-c", "--config", help="path to config.toml (default: hwtest/config.toml)")
    t.add_argument("--sim", action="store_true", help="run against the in-memory device (no hardware)")
    t.add_argument("--only", help="comma-separated scenario keys")
    t.add_argument("-l", "--list", action="store_true", help="list scenarios and exit")
    t.set_defaults(func=cmd_test)

    f = sub.add_parser("flash", help="build + flash firmware")
    f.add_argument("target", choices=["recorder", "pendant"])
    f.add_argument("-p", "--port", help="serial port (recorder; auto-detected if omitted)")
    f.add_argument("--compile-only", action="store_true", help="compile, do not upload")
    f.add_argument("--upload-only", action="store_true", help="upload the last build, skip compile")
    f.add_argument("--debug", action="store_true", help="recorder: build with CDC serial so `sate test` can read the log")
    f.set_defaults(func=cmd_flash)

    d = sub.add_parser("devices", help="list connected devices")
    d.add_argument("--ble", action="store_true", help="also scan for the pendant over BLE")
    d.add_argument("--name", help="BLE name filter (default: any)")
    d.set_defaults(func=cmd_devices)

    doc = sub.add_parser("doctor", help="check the toolchain + environment (add --device to diagnose the board)")
    doc.add_argument("-d", "--device", action="store_true", help="reset the attached board and diagnose real hardware faults")
    doc.add_argument("-t", "--target", choices=["recorder", "pendant"], default="recorder")
    doc.add_argument("-p", "--port", help="serial port for the recorder probe (auto-detected if omitted)")
    doc.add_argument("--name", help="BLE name filter for the pendant probe (default: SATE)")
    doc.add_argument("--seconds", type=float, default=15.0, help="how long to read the boot log / scan (default: 15)")
    doc.set_defaults(func=cmd_doctor)
    sub.add_parser("gui", help="launch the native test window").set_defaults(func=cmd_gui)
    sub.add_parser("dashboard", help="launch the browser test dashboard").set_defaults(func=cmd_dashboard)
    sub.add_parser("version", help="show CLI + firmware versions").set_defaults(func=cmd_version)
    return ap


def main(argv: list[str] | None = None) -> int:
    # make the sibling `hwtest` package importable when run as a script
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    ap = build_parser()
    args = ap.parse_args(argv)
    if not getattr(args, "cmd", None):
        banner()
        print()
        ap.print_help()
        return 0
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
