"""sate — the hardware CLI for the SATE Companion system.

One professional entry point for testing and flashing the recorder and pendant:

    sate test                 run the hardware-in-the-loop tests (recorder)
    sate test --sim           self-test the harness with no board attached
    sate test -t pendant      test the pendant over BLE
    sate flash recorder       build + flash the recorder firmware
    sate flash pendant        build + flash the pendant firmware
    sate flash recorder --version 1.5.12    flash a published older build
    sate firmware             list every firmware image you can flash
    sate ci                   the standard firmware gate (build + flash + full suite)
    sate e2e                  deep test: recorder → Supabase → Cloudflare → AI → done
    sate infra                connection test: probe every tier (auth, DB, edge fn, storage, CF, AI, device)
    sate pipeline             live animated map of the audio pipeline
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
import time
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
# The standard CI gate for the SATE recorder. EVERY firmware version must pass this
# before it is released — it is the release criterion, not an optional extra.
CI_SCENARIOS = ["boot_health", "reboot_resume", "byte_match",
                "verified_trim",        # nothing UNSAFE is freed
                "unsynced_kept",        # ...and an unconfirmed take is never freed
                "reclaim_idle",         # ...and reclaim ACTUALLY RUNS when idle
                "standalone_default"]   # a server roster is not an assignment
PROTECTED_SERIALS = ("SATE-D19EB8",)  # real in-use unit: CI must never touch it


def cmd_ci(args: argparse.Namespace) -> int:
    """Build + flash the working tree (debug), run the standard suite, write a report.

    One command = the whole firmware gate:
      1. read FIRMWARE_VERSION from the source;
      2. compile + flash the debug (CDC) build so the harness can read the log
         (skippable with --no-flash to judge whatever is already on the board);
      3. run the hands-off scenarios (remote record/stop/reboot — nobody needed
         at the bench);
      4. write hwtest/ci-reports/fw-<version>_<stamp>.json and exit non-zero on
         any FAIL/ERROR.
    """
    import datetime
    import json as _json
    import re as _re

    cfg = load_config(args.config)

    # -- the device under test must never be the protected in-use unit
    serial_cfg = str(cfg.get("server", {}).get("device_serial", "")).upper()
    if serial_cfg in PROTECTED_SERIALS:
        bad(f"config points at protected device {serial_cfg} — refusing to run CI against it.")
        return 2

    # -- firmware version from source (the version being gated)
    src = (REPO / "SATE_Recorder" / "SATE_Recorder.ino").read_text(errors="ignore")
    m = _re.search(r'FIRMWARE_VERSION\s*=\s*"([^"]+)"', src)
    fw = m.group(1) if m else "unknown"

    banner()
    info(f"CI gate for recorder firmware {bold(fw)}")
    info(f"standard scenarios: {', '.join(CI_SCENARIOS)}")

    port = getattr(args, "port", None) or cfg.get("serial", {}).get("port")
    if not port or not Path(port).exists():
        port = _auto_port()
    if not port:
        bad("no serial port — plug the recorder in (CI asserts on its serial log).")
        return 2
    cfg.setdefault("serial", {})["port"] = port

    # -- flash the build being gated (debug: the harness needs the serial log)
    if not getattr(args, "no_flash", False):
        fqbn = RECORDER_FQBN + ",CDCOnBoot=cdc,USBMode=hwcdc"
        info("building + flashing the working tree (debug build)…")
        if _run(["arduino-cli", "compile", "--fqbn", fqbn, "SATE_Recorder"], cwd=REPO) != 0:
            bad("compile failed — CI gate FAILED before any test ran.")
            return 1
        if _run(["arduino-cli", "upload", "-p", port, "--fqbn", fqbn, "SATE_Recorder"], cwd=REPO) != 0:
            bad("flash failed — CI gate FAILED.")
            return 1
        ok(f"flashed {fw}")
    else:
        warn("--no-flash: gating whatever firmware is already on the board.")

    # -- serial must actually be ALIVE, not merely enumerated. The board has a
    # known failure mode where the CDC port exists but produces nothing until a
    # physical replug — running the suite then fails every scenario misleadingly.
    # A reset must yield SOME output within a few seconds, or we abort up front.
    info("checking the serial line is alive…")
    try:
        from hwtest.link import SerialLink
        _l = SerialLink(port)
        _l.reset()
        _alive = False
        _end = time.time() + 12
        while time.time() < _end:
            if _l.readline(1.0):
                _alive = True
                break
        _l.close()
    except Exception as e:  # noqa: BLE001
        bad(f"serial open failed: {e}")
        _alive = False
    if not _alive:
        bad("serial port is enumerated but SILENT — the known USB-CDC wedge.")
        info("unplug the USB cable, plug it back in, then re-run `sate ci`.")
        info("(the device itself usually still works over Wi-Fi — only the log view is dead,")
        info(" and CI cannot certify a firmware without its serial evidence)")
        return 2
    ok("serial alive")

    # -- sign in so the remote record/stop/reboot commands work hands-off
    acc = cfg.get("account", {})
    if acc.get("email") and acc.get("password"):
        try:
            from hwtest import sate_account as A
            cfg.setdefault("server", {})["access_token"] = A.login(acc["email"], acc["password"])
            info(f"signed in as {acc['email']} (remote commands enabled)")
        except Exception as e:  # noqa: BLE001
            warn(f"login failed ({e}) — scenarios that need remote commands will prompt/fail")
    cfg.setdefault("actions", {}).setdefault("record_mode", "remote")

    # -- run the standard suite
    from hwtest.runner import run
    results = run(cfg, CI_SCENARIOS, sim=False, color=_USE_COLOR)
    passed = not any(r.status in ("FAIL", "ERROR") for r in results)

    # -- report file: the durable record that this firmware passed its gate
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    rep_dir = REPO / "hwtest" / "ci-reports"
    rep_dir.mkdir(exist_ok=True)
    rep = rep_dir / f"fw-{fw}_{stamp}.json"
    rep.write_text(_json.dumps({
        "firmware": fw,
        "date": datetime.datetime.now().isoformat(timespec="seconds"),
        "device": cfg.get("server", {}).get("device_serial", ""),
        "port": port,
        "flashed": not getattr(args, "no_flash", False),
        "scenarios": [{"key": r.key, "status": r.status, "detail": r.detail} for r in results],
        "verdict": "PASS" if passed else "FAIL",
    }, indent=2) + "\n")
    info(f"report: {rep}")

    print()
    if passed:
        ok(f"CI GATE PASSED — firmware {fw} meets the standard suite. OK to release.")
        return 0
    bad(f"CI GATE FAILED — firmware {fw} must NOT be released. See the report + log above.")
    return 1


PROCESSOR_URL = "https://sate-processor.longcao.workers.dev"


def cmd_infra(args: argparse.Namespace) -> int:
    """Connection test for EVERY tier the audio depends on.

    One probe per hop, with latency, so 'the pipeline is stuck' turns into 'THIS
    tier is down'. Checks, in the order the audio travels:

      Supabase Auth → Supabase DB (REST) → device-api edge fn (incl. the v15
      /sessions/verify route that was once missing from the deployment) → Storage →
      Cloudflare processor Worker → pipeline state (queued / stuck / errors, the
      only visibility we have into the AI service) → the device's own heartbeat.
    """
    import json as _json
    import urllib.error
    import urllib.request

    cfg = load_config(args.config)
    acc = cfg.get("account", {})
    srv = cfg.get("server", {})
    base = srv.get("base_url", "")
    serial = str(srv.get("device_serial", ""))
    device_id = str(srv.get("device_id", ""))

    from hwtest import sate_account as A

    banner()
    info("infrastructure / connection test — one probe per tier\n")
    failures = 0
    warnings = 0

    def probe(name, fn, *, critical=True, hint=""):
        nonlocal failures, warnings
        t = time.time()
        try:
            detail = fn() or ""
            ms = (time.time() - t) * 1000
            ok(f"{name:<28} {ms:6.0f} ms  {detail}")
            return True
        except Exception as e:  # noqa: BLE001
            ms = (time.time() - t) * 1000
            (bad if critical else warn)(f"{name:<28} {ms:6.0f} ms  {e}")
            if hint:
                info(f"  ↳ {hint}")
            if critical:
                failures += 1
            else:
                warnings += 1
            return False

    def _http(url, headers=None, timeout=15):
        h = {"User-Agent": "sate-cli"}   # Cloudflare 403s a bare urllib UA
        h.update(headers or {})
        req = urllib.request.Request(url, headers=h)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()

    # 1) Supabase Auth
    tok = None

    def p_auth():
        nonlocal tok
        if not (acc.get("email") and acc.get("password")):
            raise RuntimeError("no [account] in config.toml")
        tok = A.login(acc["email"], acc["password"])
        return f"signed in as {acc['email']}"
    probe("Supabase Auth", p_auth,
          hint="check [account] in hwtest/config.toml and the Supabase project status")

    # 2) Supabase DB over REST (the rows the whole pipeline runs on)
    def p_db():
        if not tok:
            raise RuntimeError("skipped (no auth)")
        st, body = _http(
            A.SUPABASE_URL + "/rest/v1/sate_device_sessions?select=id&limit=1",
            {"Authorization": f"Bearer {tok}", "apikey": A.ANON_KEY})
        if st != 200:
            raise RuntimeError(f"HTTP {st}")
        return "sate_device_sessions readable"
    probe("Supabase DB (REST)", p_db)

    # 3) device-api edge fn — the front door for every device
    def p_api():
        if not tok:
            raise RuntimeError("skipped (no auth)")
        st, body = _http(f"{base}/api/devices",
                         {"Authorization": f"Bearer {tok}", "apikey": A.ANON_KEY})
        n = len(_json.loads(body)) if st == 200 else 0
        if st != 200:
            raise RuntimeError(f"HTTP {st}")
        return f"{n} device(s) on the account"
    probe("device-api edge fn", p_api,
          hint="supabase functions deploy device-api --no-verify-jwt --use-api")

    # 4) device-api /sessions/verify — the v15 route verified-trim depends on.
    #    This exact route was once missing from the DEPLOYED copy while present in
    #    the repo, and the device silently never reclaimed SD space. Probe it.
    def p_verify():
        dk = str(srv.get("device_key") or (("key-" + device_id) if device_id else ""))
        if not dk or dk == "key-":
            raise RuntimeError("no device_key/device_id in config")
        st, body = _http(f"{base}/api/sessions/verify?session_number=1&bytes=1"
                         f"&device_serial={serial}",
                         {"Authorization": f"Bearer {dk}", "apikey": A.ANON_KEY})
        if st != 200:
            raise RuntimeError(f"HTTP {st} — deployed device-api predates v15!")
        return "v15 route deployed (verified-trim works)"
    probe("device-api /sessions/verify", p_verify,
          hint="the DEPLOYED fn is older than the repo — redeploy device-api")

    # 5) Storage (public firmware bucket doubles as the storage-tier probe)
    def p_storage():
        st, body = _http(A.SUPABASE_URL + "/rest/v1/sate_firmware?select=version,url"
                         "&order=created_at.desc&limit=1",
                         {"Authorization": f"Bearer {tok}", "apikey": A.ANON_KEY})             if tok else (0, "[]")
        rows = _json.loads(body) if st == 200 else []
        if rows and rows[0].get("url"):
            r = urllib.request.Request(rows[0]["url"], method="HEAD")
            with urllib.request.urlopen(r, timeout=15) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"firmware object HTTP {resp.status}")
            return f"fw {rows[0]['version']} object reachable"
        # no published firmware yet — any well-formed answer (incl. 404) from the
        # public-object path proves the storage tier itself is up
        try:
            _http(A.SUPABASE_URL + "/storage/v1/object/public/firmware/_probe")
        except urllib.error.HTTPError as he:
            if he.code in (400, 404):
                return "storage endpoint reachable (no published firmware to HEAD)"
            raise
        return "storage endpoint reachable"
    probe("Supabase Storage", p_storage, critical=False)

    # 6) Cloudflare processor Worker (fronts the container that holds the AI call)
    def p_worker():
        st, body = _http(PROCESSOR_URL + "/health")
        if st != 200 or not _json.loads(body).get("ok"):
            raise RuntimeError(f"HTTP {st}")
        return "worker ok (container wakes on /tick)"
    probe("Cloudflare processor", p_worker,
          hint="wrangler deploy in cf-processor/ — without it nothing processes")

    # 7) pipeline state = the only visibility into the AI service
    def p_pipe():
        if not tok:
            raise RuntimeError("skipped (no auth)")
        hdr = {"Authorization": f"Bearer {tok}", "apikey": A.ANON_KEY,
               "Prefer": "count=exact", "Range": "0-0"}
        counts = {}
        for status in ("queued", "processing", "error"):
            req = urllib.request.Request(
                A.SUPABASE_URL + "/rest/v1/sate_device_sessions?select=id"
                f"&status=eq.{status}", headers=hdr)
            with urllib.request.urlopen(req, timeout=15) as r:
                cr = r.headers.get("Content-Range", "/0")
                counts[status] = int(cr.split("/")[-1]) if "/" in cr else 0
        msg = f"queued={counts['queued']} processing={counts['processing']} error={counts['error']}"
        if counts["queued"] > 5 or counts["processing"] > 3:
            raise RuntimeError(msg + " — backlog: the AI service may be down/slow")
        return msg
    probe("Pipeline / AI service", p_pipe, critical=False,
          hint="a growing queue usually means the ngrok AI endpoint is unreachable")

    # 8) the bench device's heartbeat
    def p_dev():
        if not tok:
            raise RuntimeError("skipped (no auth)")
        for d in A.list_devices(tok):
            if str(d.get("serial", "")) == serial:
                if not d.get("online"):
                    raise RuntimeError(f"offline (last_seen {d.get('last_seen')})")
                return f"online · {d.get('state')} · fw {d.get('fw')}"
        raise RuntimeError(f"{serial} not claimed on this account")
    probe(f"Device heartbeat ({serial})", p_dev, critical=False,
          hint="power/Wi-Fi, or claim it via the Debugger's Connect / set up")

    print()
    if failures:
        bad(f"{failures} tier(s) DOWN, {warnings} warning(s) — the pipeline cannot run end-to-end.")
        return 1
    if warnings:
        warn(f"all critical tiers up; {warnings} warning(s) above.")
        return 0
    ok("every tier reachable — infrastructure is healthy.")
    return 0


def cmd_e2e(args: argparse.Namespace) -> int:
    """The DEEP test: follow one take through the ENTIRE system.

    recorder → device-api (chunked upload) → Storage + DB row → queued →
    cf-processor claims → AI /process → finalize-session → done (recording row).

    Drives the device with remote record/stop and watches the same rows the web
    app reads, so it needs no serial cable — only the account and the device on
    Wi-Fi. Exit code gates on the audio ACTUALLY reaching "done" with a
    byte-verified object in Storage.
    """
    import json as _json
    import urllib.request

    cfg = load_config(args.config)
    acc = cfg.get("account", {})
    srv = cfg.setdefault("server", {})
    if not (acc.get("email") and acc.get("password")):
        bad("config.toml needs [account] email/password — e2e drives the device remotely.")
        return 2

    from hwtest import pipeline as P
    from hwtest import sate_account as A

    banner()
    tok = A.login(acc["email"], acc["password"])
    serial = str(srv.get("device_serial", ""))
    device_id = str(srv.get("device_id", ""))
    if serial.upper() in PROTECTED_SERIALS:
        bad(f"{serial} is a protected in-use device — refusing.")
        return 2
    if not (serial and device_id):
        bad("config.toml [server] needs device_serial and device_id.")
        return 2
    base = srv.get("base_url", "")
    info(f"deep end-to-end test on {bold(serial)} (recorder → Supabase → Cloudflare → AI → done)")

    def cmd(op):
        req = urllib.request.Request(
            f"{base}/api/devices/{device_id}/commands",
            data=_json.dumps({"op": op}).encode(), method="POST",
            headers={"Authorization": f"Bearer {tok}", "apikey": A.ANON_KEY,
                     "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=20):
            pass

    def dev_state():
        for d in A.list_devices(tok):
            if str(d.get("serial", "")) == serial:
                return (str(d.get("state") or "idle") if d.get("online") else "offline")
        return "unknown"

    t0 = time.time()
    marks = {}          # stage key -> wall-clock seconds from t0

    def mark(stage, note=""):
        dt = time.time() - t0
        marks[stage] = dt
        info(f"[{dt:6.1f}s] {bold(stage)}  {note}")

    # baseline: don't confuse an old row for the new take
    hist = P.recent_sessions(tok, serial, 1)
    baseline = hist[0].created if hist else None
    last_num = hist[0].session_number if hist else 0

    st = dev_state()
    if st == "offline":
        bad("device is offline — e2e needs it on Wi-Fi.")
        return 2
    if st == "recording":
        bad("device is already recording — stop it first (sate: the Debugger / remote stop).")
        return 2

    take_s = float(getattr(args, "take", 0) or cfg.get("record", {}).get("take_s", 8))

    # 1) record — fw >=1.5.19 stops ITSELF at exactly take_s (sample-exact cap),
    #    so the duration check below is meaningful. No stop race.
    def cmd_body(body):
        req = urllib.request.Request(
            f"{base}/api/devices/{device_id}/commands",
            data=_json.dumps(body).encode(), method="POST",
            headers={"Authorization": f"Bearer {tok}", "apikey": A.ANON_KEY,
                     "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=20):
            pass
    cmd_body({"op": "record", "seconds": int(take_s)})
    mark("record", f"remote RECORD queued — device records EXACTLY {take_s:.0f}s by itself")
    end = time.time() + 40
    while time.time() < end and dev_state() != "recording":
        time.sleep(2)
    if dev_state() != "recording":
        bad("device never started recording (heartbeat state stayed idle).")
        return 1
    info(f"          recording — the device caps the take at {take_s:.0f}s of PCM…")
    end = time.time() + take_s + 60
    while time.time() < end and dev_state() == "recording":
        time.sleep(3)
    if dev_state() == "recording":
        warn("still recording past the cap — sending a safety stop")
        cmd("stop")
    mark("upload", "take ended — device finalizes + uploads over HTTPS")

    # 3) the row appears (Storage + DB)
    row = None
    end = time.time() + float(getattr(args, "upload_timeout", 180))
    while time.time() < end:
        h = P.recent_sessions(tok, serial, 3)
        row = next((x for x in h if (baseline is None or (x.created or 0) > baseline)), None)
        if row:
            break
        time.sleep(3)
    if not row:
        bad("upload never landed: no new session row appeared on the server.")
        return 1
    mark("stored", f"session {row.session_number} · {row.bytes/1e6:.2f} MB in Storage + DB")

    # 4) byte-verify the object really exists (the same check the device trusts)
    dk = str(srv.get("device_key") or ("key-" + device_id))
    vurl = (f"{base}/api/sessions/verify?session_number={row.session_number}"
            f"&bytes={row.bytes}&device_serial={serial}")
    try:
        vreq = urllib.request.Request(vurl, headers={"Authorization": f"Bearer {dk}",
                                                     "apikey": A.ANON_KEY})
        with urllib.request.urlopen(vreq, timeout=20) as r:
            verified = bool(_json.loads(r.read().decode()).get("stored"))
    except Exception as e:  # noqa: BLE001
        warn(f"verify call failed ({e})")
        verified = False
    (ok if verified else warn)(f"          Storage object byte-verified ({row.bytes} bytes)"
                               if verified else "          verify did not confirm — continuing")

    # 5) queued → cf-processor → AI → finalize → done
    def on_change(st2):
        label = {"queued": "queued — waiting for the processor",
                 "ai": "cf-processor claimed — AI transcription in flight",
                 "done": "finalize done — recording row written",
                 "error": f"ERROR: {st2.error}"}.get(st2.stage, st2.stage)
        mark(st2.stage if st2.stage != "ai" else "claimed", label)

    final = P.watch(tok, serial, row.session_number,
                    timeout_s=float(getattr(args, "process_timeout", 600)),
                    on_change=on_change, baseline_created=baseline)

    total = time.time() - t0
    print()
    print(bold("═════════════ E2E SUMMARY ═════════════"))
    qw = f"{final.queue_wait_s:.1f}s" if final.queue_wait_s is not None else "—"
    pr = f"{final.processing_s:.1f}s" if final.processing_s is not None else "—"
    print(f"  session      : {final.session_number}  ({final.bytes/1e6:.2f} MB)")
    print(f"  storage      : {'byte-verified' if verified else 'NOT verified'}")
    print(f"  queue wait   : {qw}")
    print(f"  processing   : {pr}   (cf-processor + AI + finalize)")
    audio_s = max(0.0, (final.bytes - 44) / 32000.0)
    dur_ok = abs(audio_s - take_s) <= max(2.0, take_s * 0.05)
    print(f"  audio length : {audio_s:.1f}s vs requested {take_s:.0f}s  {'✓ exact' if dur_ok else '✗ OFF'}")
    print(f"  recording row: {'yes — ' + str(final.recording_id) if final.recording_id else 'none (no_text takes have none)'}")
    print(f"  wall clock   : {total:.1f}s from RECORD to the end")
    print()
    passed = final.status == "done" and verified and dur_ok
    if passed:
        ok("E2E PASSED — the audio travelled recorder → Supabase → Cloudflare → AI → done.")
        return 0
    bad(f"E2E FAILED — final status {final.status}" + ("" if verified else " (and storage unverified)"))
    return 1


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
                                             "upload_wait_s": 3, "delete_target": 1,
                                             "reclaim_watch_s": 1.5,
                                             "patient_id": "Standalone"})
    results = run(cfg, keys, sim=args.sim, color=_USE_COLOR, mirror=getattr(args, "mirror", None))
    return 1 if any(r.status in ("FAIL", "ERROR") for r in results) else 0


def cmd_firmware(args: argparse.Namespace) -> int:
    """Every image `sate flash --version` can put on a board."""
    from . import firmware as FW
    banner()
    rows = FW.list_available(str(REPO))
    if not rows:
        warn("no firmware images found (no local cache, no GitHub release assets).")
        info("build one with `sate flash recorder --compile-only`, or cut a release.")
        return 0
    info(f"cache: {FW.CACHE}")
    print()
    print(f"  {'VERSION':10} {'KIND':8} {'SIZE':>9}  {'SOURCE':8} NAME")
    for e in rows:
        print(f"  {e['version']:10} {e['kind']:8} {e['size']/1e6:8.1f}M  {e['source']:8} {e['name']}")
    print()
    info("flash one with:  sate flash recorder --version <VERSION>")
    info("'merged' rewrites the whole flash; 'app' writes the OTA slot + resets otadata.")
    return 0


def cmd_flash(args: argparse.Namespace) -> int:
    if shutil.which("arduino-cli") is None and args.target == "recorder":
        bad("arduino-cli not found on PATH — see `sate doctor`.")
        return 127

    if args.target == "recorder":
        banner()
        info(f"repo: {REPO}")
        # Flashing a KNOWN OLDER build (repro a field bug / bisect a regression) goes
        # straight to esptool — there is nothing to compile.
        if getattr(args, "version", None) or getattr(args, "image", None):
            from . import firmware as FW
            port = args.port or _auto_port()
            if not port:
                bad("no serial port found — pass --port /dev/cu.usbmodemXXX (see `sate devices`)."); return 2
            if args.image:
                okd = FW.flash_image(port, args.image, log=info)
            else:
                info(f"flashing published firmware {args.version} (not the working tree)")
                okd = FW.flash_version(port, args.version, repo_dir=str(REPO), log=info)
            (ok if okd else bad)("flashed" if okd else "flash failed")
            return 0 if okd else 1
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


def cmd_debug(args: argparse.Namespace) -> int:
    cfg = REPO / "hwtest" / "config.toml"
    argv = [sys.executable, str(REPO / "hwtest" / "debugger.py")]
    if cfg.exists():
        argv += ["--config", str(cfg)]
    return _run(argv, cwd=REPO / "hwtest")


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
def cmd_provision(args: argparse.Namespace) -> int:
    banner()
    try:
        import asyncio
        from hwtest.recorder_ble import RecorderBle
    except ImportError:
        bad("bleak not installed — `pip install bleak`"); return 1

    if args.wifi and ":" in args.wifi:
        ssid, pw = args.wifi.split(":", 1)
    else:
        ssid, pw = args.ssid, args.password
    if not ssid or pw is None:
        bad("need Wi-Fi creds: --wifi \"SSID:PASSWORD\"  (or --ssid + --password)"); return 2
    if args.claim_token and not args.server:
        bad("--claim-token also needs --server (the device-api base URL)"); return 2

    async def go() -> int:
        addr = args.address or await RecorderBle.find("SATE-", timeout=10)
        if not addr:
            bad("no recorder advertising over BLE — it must be in BLE/setup mode (offline)"); return 1
        info(f"connecting to {addr} …")
        async with RecorderBle(addr, log=print) as r:
            ident = await r.read_info()
            info(f"device: {ident.get('serial')}  fw {ident.get('fw')}  provisioned={ident.get('provisioned')}")
            if args.claim_token:
                info(f"provisioning + claiming to {args.server}  (Wi-Fi: {ssid})")
                res = await r.provision(ssid, pw, args.server, args.claim_token)
            else:
                info(f"change_wifi — joining {ssid} (keeps the account)")
                res = await r.change_wifi(ssid, pw)
        st = res.get("state")
        if st in ("registered", "wifi_saved"):
            ok(green(f"success: {st}") + (f"  ip={res['ip']}" if res.get("ip") else ""))
            return 0
        bad(f"provisioning ended in '{st}'  {res.get('msg', '')}")
        return 1

    try:
        return asyncio.run(go())
    except Exception as e:  # noqa: BLE001
        bad(f"provisioning failed: {e}"); return 1


# state a serial log line implies — for the live monitor / desktop mirror
def _derive_state(line: str, cur: str) -> str:
    l = line.lower()
    if "record" in l and "start" in l: return "RECORDING"
    if "[rec]" in l and "record" in l: return "RECORDING"
    if "uploaded" in l or "uploadstep" in l or "upload " in l: return "UPLOADING"
    if "play start" in l: return "PLAYBACK"
    if "[mem] ready" in l: return "HOME"
    if "ble mode" in l or "ble advertising" in l: return "BLE / OFFLINE"
    if "factory reset" in l: return "RESET"
    return cur


def cmd_monitor(args: argparse.Namespace) -> int:
    from hwtest.link import SerialLink
    port = args.port or _auto_port()
    if not port:
        bad("no serial port — plug in the recorder or pass --port"); return 2
    banner()
    info(f"live monitor on {port}" + (f" for {args.seconds:g}s" if args.seconds else " — Ctrl-C to stop"))
    print(dim("  mirrors what the recorder is doing from its serial log\n"))
    try:
        link = SerialLink(port)
    except Exception as e:  # noqa: BLE001
        bad(f"could not open {port}: {e}"); return 1
    if args.reset:
        link.reset()
    import time
    state = "?"
    end = (time.monotonic() + args.seconds) if args.seconds else None
    try:
        while end is None or time.monotonic() < end:
            ln = link.readline(1.0)
            if ln is None:
                continue
            new = _derive_state(ln, state)
            if new != state:
                state = new
                color = {"RECORDING": red, "UPLOADING": cyan, "HOME": green,
                         "PLAYBACK": yellow, "BLE / OFFLINE": yellow}.get(state, bold)
                print(bold("  >> STATE: ") + color(state))
            print(dim("    │ ") + ln)
    except KeyboardInterrupt:
        print(dim("\n  stopped"))
    finally:
        link.close()
    return 0


def _write_png(path: str, w: int, h: int, rgb: bytes) -> None:
    """Minimal RGB PNG writer (stdlib zlib only — no Pillow needed)."""
    import struct
    import zlib

    def chunk(typ: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + typ + data
                + struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff))

    raw = bytearray()
    for y in range(h):
        raw.append(0)                       # filter type 0 for the row
        raw += rgb[y * w * 3:(y + 1) * w * 3]
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        f.write(chunk(b"IEND", b""))


def _rgb565_to_rgb888(buf: bytes, swap: bool) -> bytes:
    out = bytearray((len(buf) // 2) * 3)
    o = 0
    for i in range(0, len(buf) - 1, 2):
        b0, b1 = buf[i], buf[i + 1]
        v = (b0 << 8) | b1 if swap else (b1 << 8) | b0
        r = (v >> 11) & 0x1f
        g = (v >> 5) & 0x3f
        b = v & 0x1f
        out[o] = (r << 3) | (r >> 2)
        out[o + 1] = (g << 2) | (g >> 4)
        out[o + 2] = (b << 3) | (b >> 2)
        o += 3
    return bytes(out)


def capture_screen(port: str, timeout: float = 12.0) -> tuple[int, int, bytes]:
    """Send SCREENDUMP over serial and return (w, h, rgb888). Raises RuntimeError.
    Reusable by the CLI and the desktop debugger. Does NOT reset the board."""
    import base64
    import re
    import time
    import serial
    ser = serial.Serial(port, 115200, timeout=0.3)
    try:
        ser.reset_input_buffer()
        ser.write(b"SCREENDUMP\n")
        deadline = time.monotonic() + timeout
        buf = b""
        w = h = 0
        swap = False
        b64_lines: list[str] = []
        collecting = began = False
        b64_re = re.compile(r"^[A-Za-z0-9+/=]+$")
        while time.monotonic() < deadline:
            buf += ser.read(4096)
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                s = line.decode("utf-8", "replace").strip()
                if not s:
                    continue
                if s.startswith("[SCREENSHOT-ERR"):
                    raise RuntimeError(f"device refused: {s}")
                m = re.search(r"\[SCREENSHOT-BEGIN w=(\d+) h=(\d+).*swap=(\d+)", s)
                if m:
                    w, h, swap = int(m.group(1)), int(m.group(2)), m.group(3) == "1"
                    collecting = began = True
                    continue
                if "[SCREENSHOT-END]" in s:
                    collecting = False
                    break
                if collecting and b64_re.match(s):
                    b64_lines.append(s)
            if began and not collecting:
                break
        if not began:
            raise RuntimeError("no screenshot response — is this a --debug build? (production has no screendump)")
        data = base64.b64decode("".join(b64_lines), validate=False)
        want = w * h * 2
        if len(data) < want:
            data = data + b"\x00" * (want - len(data))
        return w, h, _rgb565_to_rgb888(data[:want], swap)
    finally:
        ser.close()


def cmd_screenshot(args: argparse.Namespace) -> int:
    banner()
    port = args.port or _auto_port()
    if not port:
        bad("no serial port — plug in the recorder (debug build) or pass --port"); return 2
    try:
        import serial  # noqa: F401
    except ImportError:
        bad("pyserial not installed — `pip install pyserial`"); return 1
    info(f"requesting a screen dump from {port} …")
    try:
        w, h, rgb = capture_screen(port, args.timeout)
    except Exception as e:  # noqa: BLE001
        bad(str(e)); return 1
    _write_png(args.output, w, h, rgb)
    ok(green(f"saved {w}×{h} screenshot → {args.output}"))
    return 0


# Curated, grouped command overview for `sate help` (and bare `sate`). Purpose-first,
# grouped the same way as the published CLI reference; `sate <cmd> -h` has the flags.
_HELP_GROUPS = [
    ("Test & CI", [
        ("ci",         "the standard firmware gate — build + flash + full hands-off suite"),
        ("test",       "run the hardware-in-the-loop tests (--sim, --only, -t pendant)"),
        ("e2e",        "deep whole-system test: recorder → Supabase → Cloudflare → AI → done"),
        ("infra",      "connection test — probe every tier the audio depends on"),
    ]),
    ("Flash & firmware", [
        ("flash",      "build + flash firmware (recorder|pendant; --version, --image, --debug)"),
        ("firmware",   "list firmware images you can flash (local cache + releases)"),
    ]),
    ("Diagnose & monitor", [
        ("doctor",     "check the toolchain/environment (--device diagnoses the board)"),
        ("devices",    "list connected devices / serial ports (--ble scans the pendant)"),
        ("monitor",    "mirror the recorder's live state from its serial log"),
        ("screenshot", "capture the recorder's screen to a PNG (debug build only)"),
        ("provision",  "push Wi-Fi to the recorder over BLE (register/claim or change Wi-Fi)"),
    ]),
    ("Graphical tools", [
        ("debug",      "desktop Debugger app — screen mirror + remote control + flashing"),
        ("pipeline",   "live animated map of the audio pipeline (desktop window)"),
        ("gui",        "launch the native test window"),
        ("dashboard",  "launch the browser test dashboard"),
    ]),
    ("Info", [
        ("version",    "show CLI + firmware versions (or: sate --version)"),
        ("help",       "show this command list"),
    ]),
]


def cmd_help(args: argparse.Namespace) -> int:
    banner()
    print()
    print(dim("  Test, flash, and diagnose the SATE recorder & pendant from one command."))
    for title, cmds in _HELP_GROUPS:
        print()
        print("  " + bold(cyan(title)))
        for name, purpose in cmds:
            print(f"    {green(name.ljust(10))}  {purpose}")
    print()
    print(dim("  Run ") + bold("sate <command> -h") + dim(" for a command's flags   ·   install: pip install -e hwtest"))
    return 0


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
    t.add_argument("--mirror", help="write a screen snapshot to this file between scenarios (for the desktop app)")
    t.set_defaults(func=cmd_test)

    f = sub.add_parser("flash", help="build + flash firmware")
    f.add_argument("target", choices=["recorder", "pendant"])
    f.add_argument("-p", "--port", help="serial port (recorder; auto-detected if omitted)")
    f.add_argument("--compile-only", action="store_true", help="compile, do not upload")
    f.add_argument("--upload-only", action="store_true", help="upload the last build, skip compile")
    f.add_argument("--debug", action="store_true", help="recorder: build with CDC serial so `sate test` can read the log")
    f.add_argument("--version", help="flash a published build instead of the working tree, e.g. 1.5.12")
    f.add_argument("--image", help="flash a specific .bin (app or merged image)")
    f.set_defaults(func=cmd_flash)

    fw = sub.add_parser("firmware", help="list firmware images you can flash")
    fw.set_defaults(func=cmd_firmware)

    ci = sub.add_parser("ci", help="the standard firmware gate: build + flash + full hands-off suite")
    ci.add_argument("-c", "--config", help="path to config.toml")
    ci.add_argument("--port", help="serial port (default: config/auto-detect)")
    ci.add_argument("--no-flash", action="store_true",
                    help="gate the firmware already on the board instead of flashing the working tree")
    ci.set_defaults(func=cmd_ci)

    e2 = sub.add_parser("e2e", help="deep test: recorder → Supabase → Cloudflare → AI → done")
    e2.add_argument("-c", "--config", help="path to config.toml")
    e2.add_argument("--take", type=float, help="seconds to record (default: config take_s or 8)")
    e2.add_argument("--upload-timeout", type=float, default=180, dest="upload_timeout")
    e2.add_argument("--process-timeout", type=float, default=600, dest="process_timeout")
    e2.set_defaults(func=cmd_e2e)

    inf = sub.add_parser("infra", help="connection test: probe every tier the audio depends on")
    inf.add_argument("-c", "--config", help="path to config.toml")
    inf.set_defaults(func=cmd_infra)

    pl = sub.add_parser("pipeline", help="live animated map of the audio pipeline (desktop window)")
    pl.set_defaults(func=lambda a: __import__("subprocess").call(
        [sys.executable, str(REPO / "hwtest" / "pipeline_view.py")]))

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
    pr = sub.add_parser("provision", help="push Wi-Fi to the recorder over BLE (register/claim or change-wifi)")
    pr.add_argument("--wifi", help='Wi-Fi as "SSID:PASSWORD"')
    pr.add_argument("--ssid", help="Wi-Fi SSID (alternative to --wifi)")
    pr.add_argument("--password", help="Wi-Fi password (alternative to --wifi)")
    pr.add_argument("--server", help="device-api base URL (required with --claim-token)")
    pr.add_argument("--claim-token", help="account claim token → provision + register; omit to just change Wi-Fi")
    pr.add_argument("--address", help="BLE address (auto-found if omitted)")
    pr.set_defaults(func=cmd_provision)

    ss = sub.add_parser("screenshot", help="capture the recorder's screen (DEBUG build) → PNG")
    ss.add_argument("-o", "--output", default="screen.png", help="output PNG path (default: screen.png)")
    ss.add_argument("-p", "--port", help="serial port (auto-detected if omitted)")
    ss.add_argument("--timeout", type=float, default=12.0, help="seconds to wait for the frame")
    ss.set_defaults(func=cmd_screenshot)

    mon = sub.add_parser("monitor", help="mirror the recorder's live state from its serial log")
    mon.add_argument("-p", "--port", help="serial port (auto-detected if omitted)")
    mon.add_argument("--reset", action="store_true", help="reset the board first to capture the boot sequence")
    mon.add_argument("--seconds", type=float, default=0.0, help="stop after N seconds (default: run until Ctrl-C)")
    mon.set_defaults(func=cmd_monitor)

    sub.add_parser("debug", help="launch the native Debugger app (screen mirror + actions)").set_defaults(func=cmd_debug)
    sub.add_parser("gui", help="launch the native test window").set_defaults(func=cmd_gui)
    sub.add_parser("dashboard", help="launch the browser test dashboard").set_defaults(func=cmd_dashboard)
    sub.add_parser("version", help="show CLI + firmware versions").set_defaults(func=cmd_version)
    sub.add_parser("help", help="list every command and what it does").set_defaults(func=cmd_help)
    return ap


def main(argv: list[str] | None = None) -> int:
    # make the sibling `hwtest` package importable when run as a script
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    ap = build_parser()
    args = ap.parse_args(argv)
    if not getattr(args, "cmd", None):
        return cmd_help(args)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
