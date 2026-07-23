#!/usr/bin/env python3
"""SATE hardware test harness — CLI.

Real hardware (default):
    python3 run.py --config config.toml
    python3 run.py --config config.toml --only reboot_resume,byte_match

Self-test the harness with no board attached:
    python3 run.py --sim

List what it can check:
    python3 run.py --list
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from hwtest.runner import run  # noqa: E402
from hwtest.scenarios import ALL  # noqa: E402


def load_config(path: str | None) -> dict:
    if not path:
        return {}
    p = Path(path)
    if not p.exists():
        print(f"config not found: {path}", file=sys.stderr)
        sys.exit(2)
    try:
        import tomllib  # py3.11+
    except ModuleNotFoundError:  # pragma: no cover
        import tomli as tomllib  # type: ignore
    with p.open("rb") as f:
        return tomllib.load(f)


def main() -> int:
    ap = argparse.ArgumentParser(description="SATE hardware-in-the-loop test harness")
    ap.add_argument("--config", "-c", help="path to a config.toml (see config.example.toml)")
    ap.add_argument("--target", "-t", choices=["recorder", "pendant"], default="recorder",
                    help="which device to test (recorder = USB serial; pendant = BLE)")
    ap.add_argument("--sim", action="store_true", help="run against the in-memory device (no hardware)")
    ap.add_argument("--only", help="comma-separated scenario keys (default: all)")
    ap.add_argument("--list", action="store_true", help="list scenarios and exit")
    ap.add_argument("--no-color", action="store_true")
    args = ap.parse_args()

    if args.list:
        from hwtest.pendant import PENDANT_SCENARIOS
        print("Recorder scenarios (USB serial + device-api):\n")
        for s in ALL:
            need = f"  [needs: {', '.join(s.requires)}]" if s.requires else ""
            print(f"  {s.key:22} {s.title}{need}")
            print(f"  {'':22} ↳ {s.bug}")
        print("\nPendant scenarios (BLE — `--target pendant`):\n")
        for k in PENDANT_SCENARIOS:
            print(f"  {k}")
        return 0

    cfg = load_config(args.config)
    keys = [k.strip() for k in args.only.split(",")] if args.only else None

    if args.target == "pendant":
        from hwtest.pendant import run_pendant
        from hwtest.scenarios import PASS, FAIL, ERROR, SKIP
        C = {PASS: "\033[32m", FAIL: "\033[31m", SKIP: "\033[33m", ERROR: "\033[35m"}
        results = run_pendant(cfg, keys, sim=args.sim)
        print("\n═════════════ SUMMARY (pendant) ═════════════")
        for r in results:
            tag = (f"{C[r.status]}{r.status:5}\033[0m" if not args.no_color else f"{r.status:5}")
            print(f"  {tag}  {r.title}: {r.detail}")
        return 1 if any(r.status in (FAIL, ERROR) for r in results) else 0

    if args.sim:
        # fast, deterministic sim timings so a self-test finishes in seconds
        cfg.setdefault("record", {}).update({"take_s": 1, "resume_hold_s": 0,
                                             "trim_watch_s": 0.3, "gap_wait_s": 0.3,
                                             "upload_wait_s": 3, "delete_target": 1})
    results = run(cfg, keys, sim=args.sim, color=not args.no_color)
    failed = any(r.status in ("FAIL", "ERROR") for r in results)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
