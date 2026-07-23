"""Orchestrate a run: build the context (real or sim), run scenarios, report."""
from __future__ import annotations

import sys
from typing import Callable, List, Optional

from .context import BenchActions, Ctx
from .link import SerialLink
from .scenarios import ERROR, FAIL, PASS, SKIP, Result, Scenario, by_key
from .server import DeviceApiServer
from .sim import SimBackend

RESET = "\033[0m"
COLOR = {PASS: "\033[32m", FAIL: "\033[31m", SKIP: "\033[33m", ERROR: "\033[35m"}


def build_context(cfg: dict, *, sim: bool, log: Callable[[str], None],
                  prompt_fn=None) -> Ctx:
    if sim:
        backend = SimBackend(cfg, log=log)
        return Ctx(link=backend.link, server=backend, act=backend, cfg=cfg, log=log)

    scfg = cfg.get("serial", {})
    link = SerialLink(scfg.get("port", "/dev/cu.usbmodem101"), int(scfg.get("baud", 115200)))
    svcfg = cfg.get("server", {})
    server = DeviceApiServer(
        svcfg.get("base_url", ""), svcfg.get("device_key", ""),
        svcfg.get("device_serial", ""), svcfg.get("anon_key"),
    )
    acfg = cfg.get("actions", {})
    act = BenchActions(
        link,
        record_mode=acfg.get("record_mode", "manual"),
        reboot_mode=acfg.get("reboot_mode", "reset"),
        unattended=bool(acfg.get("unattended", False)),
        prompt_wait=float(acfg.get("prompt_wait_s", 6)),
        log=log,
        prompt_fn=prompt_fn,
    )
    return Ctx(link=link, server=server, act=act, cfg=cfg, log=log)


def run(cfg: dict, keys: Optional[List[str]] = None, *, sim: bool = False,
        log: Callable[[str], None] = print, color: bool = True, prompt_fn=None,
        mirror: Optional[str] = None) -> List[Result]:
    ctx = build_context(cfg, sim=sim, log=log, prompt_fn=prompt_fn)
    scenarios: List[Scenario] = by_key(keys)
    results: List[Result] = []

    def _snap():
        # Snap the device screen BETWEEN scenarios (never mid-step) so the desktop
        # app can mirror it during a run. One cheap lv_snapshot; ignored if the
        # firmware isn't a --debug build. No effect on the scenarios themselves.
        if not mirror or sim:
            return
        try:
            import os
            w, h, rgb = ctx.link.screendump(timeout=6)
            tmp = mirror + ".tmp"
            with open(tmp, "wb") as f:
                f.write(b"P6\n%d %d\n255\n" % (w, h))
                f.write(rgb)
            os.replace(tmp, mirror)
        except Exception:
            pass

    try:
        _snap()
        for sc in scenarios:
            log("")
            log(f"── {sc.title}")
            log(f"   guards: {sc.bug}")
            ctx.lines.clear()
            if "server" in sc.requires and not ctx.server.available():
                res = Result(sc.key, sc.title, sc.bug, SKIP, "no server configured (base_url/device_key)")
            else:
                try:
                    res = sc.run(ctx)
                except Exception as e:  # a harness/hardware error, not a device verdict
                    res = Result(sc.key, sc.title, sc.bug, ERROR, f"{type(e).__name__}: {e}", list(ctx.lines))
            results.append(res)
            tag = f"{COLOR[res.status]}{res.status}{RESET}" if color else res.status
            log(f"   → {tag}: {res.detail}")
            _snap()          # refresh the mirror after each scenario
    finally:
        ctx.link.close()

    log("")
    log("═════════════ SUMMARY ═════════════")
    for r in results:
        tag = f"{COLOR[r.status]}{r.status:5}{RESET}" if color else f"{r.status:5}"
        log(f"  {tag}  {r.title}")
    npass = sum(1 for r in results if r.status == PASS)
    nfail = sum(1 for r in results if r.status in (FAIL, ERROR))
    log(f"\n  {npass} passed, {nfail} failed/errored, "
        f"{sum(1 for r in results if r.status == SKIP)} skipped")
    return results
