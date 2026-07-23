"""Find, fetch, and flash a SPECIFIC recorder firmware image.

`sate flash recorder` always builds and flashes the working tree. This module covers
the other half of bench work: putting a *known older* build back on a board — to
reproduce a field bug on the version that shipped, or to walk a regression back to
the release that introduced it.

Where images come from, in the order they are offered:

  1. **Local cache** — `~/.sate/firmware/*.bin`. Anything downloaded or built before;
     also where you can drop a hand-built image.
  2. **GitHub releases** of this repo — assets named `*.app.bin` / `*.merged.bin`
     (uses the `gh` CLI, so it works on a private repo with no token plumbing).
  3. **An explicit path** the caller passes.

Two image kinds, and mixing them up is the classic "dead black screen":

  * **app** (~1.7 MB) is the OTA payload — the application slot only. It has to go at
    the app offset, and `otadata` must be reset (by rewriting `boot_app0.bin`) or the
    bootloader keeps running whichever OTA slot was last marked valid, so the flash
    appears to do nothing.
  * **merged** (16 MB) is the entire flash — bootloader + partition table + app — and
    goes at 0x0.

Manual esptool flashing also needs **DIO** flash mode: `qio` on this board gives a
dead black screen. (`arduino-cli upload` picks the mode itself; here we must not.)
"""
from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Callable, List, Optional

CACHE = Path.home() / ".sate" / "firmware"
CHIP = "esp32s3"
# Offsets for PartitionScheme=default_8MB (the mandatory dual-OTA layout).
APP_OFFSET = "0x10000"
OTADATA_OFFSET = "0xe000"
FLASH_ARGS = ["--flash_mode", "dio", "--flash_freq", "80m", "--flash_size", "16MB"]

_VER_RE = re.compile(r"(\d+\.\d+\.\d+)")


# --------------------------------------------------------------------- toolchain
def esptool_cmd() -> Optional[List[str]]:
    """The esptool bundled with the ESP32 core (newest), else a pip/PATH one."""
    hits = sorted(glob.glob(str(Path.home() / "Library/Arduino15/packages/esp32/tools/esptool_py/*/esptool")))
    if hits:
        return [hits[-1]]
    if shutil.which("esptool.py"):
        return [shutil.which("esptool.py")]
    if shutil.which("esptool"):
        return [shutil.which("esptool")]
    return None


def boot_app0() -> Optional[str]:
    """`boot_app0.bin` resets otadata so the bootloader runs the slot we just wrote."""
    hits = sorted(glob.glob(str(Path.home() / "Library/Arduino15/packages/esp32/hardware/esp32/*/tools/partitions/boot_app0.bin")))
    return hits[-1] if hits else None


# ------------------------------------------------------------------- discovery
def classify(path_or_name: str, size: int = 0) -> str:
    """"merged" (whole flash, 0x0) vs "app" (OTA payload, app offset)."""
    name = str(path_or_name).lower()
    if "merged" in name:
        return "merged"
    if "app" in name:
        return "app"
    return "merged" if size > 4_000_000 else "app"


def _version_of(name: str) -> str:
    m = _VER_RE.search(name)
    return m.group(1) if m else name


def list_cached() -> List[dict]:
    CACHE.mkdir(parents=True, exist_ok=True)
    out = []
    for p in sorted(CACHE.glob("*.bin")):
        sz = p.stat().st_size
        out.append({"version": _version_of(p.name), "kind": classify(p.name, sz),
                    "name": p.name, "size": sz, "source": "cache", "path": str(p)})
    return out


def list_releases(repo_dir: str = ".") -> List[dict]:
    """Firmware `.bin` assets across this repo's GitHub releases (via `gh`)."""
    if not shutil.which("gh"):
        return []
    try:
        tags = subprocess.run(["gh", "release", "list", "--json", "tagName", "-q", ".[].tagName"],
                              cwd=repo_dir, capture_output=True, text=True, timeout=30).stdout.split()
    except Exception:  # noqa: BLE001
        return []
    out = []
    for tag in tags:
        try:
            raw = subprocess.run(["gh", "release", "view", tag, "--json", "assets"],
                                 cwd=repo_dir, capture_output=True, text=True, timeout=30).stdout
            assets = json.loads(raw or "{}").get("assets", [])
        except Exception:  # noqa: BLE001
            continue
        for a in assets:
            if not a.get("name", "").endswith(".bin"):
                continue
            out.append({"version": _version_of(a["name"]) or _version_of(tag), "kind": classify(a["name"], a.get("size", 0)),
                        "name": a["name"], "size": a.get("size", 0), "source": "github", "tag": tag})
    return out


def list_available(repo_dir: str = ".") -> List[dict]:
    """Everything flashable, cache first, newest version first, no duplicates."""
    seen, out = set(), []
    for e in list_cached() + list_releases(repo_dir):
        k = (e["version"], e["kind"])
        if k in seen:
            continue
        seen.add(k)
        out.append(e)
    out.sort(key=lambda e: [int(x) for x in e["version"].split(".")] if _VER_RE.fullmatch(e["version"]) else [0],
             reverse=True)
    return out


def fetch(entry: dict, repo_dir: str = ".", log: Callable[[str], None] = print) -> str:
    """Return a local path for an entry, downloading from the release if needed."""
    if entry.get("path") and Path(entry["path"]).exists():
        return entry["path"]
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / entry["name"]
    if dest.exists() and dest.stat().st_size == entry.get("size", dest.stat().st_size):
        return str(dest)
    log(f"  downloading {entry['name']} ({entry.get('size', 0) / 1e6:.1f} MB) from {entry['tag']}…")
    subprocess.run(["gh", "release", "download", entry["tag"], "-p", entry["name"], "-D", str(CACHE), "--clobber"],
                   cwd=repo_dir, check=True, timeout=600)
    if not dest.exists():
        raise RuntimeError(f"download did not produce {dest}")
    return str(dest)


# ----------------------------------------------------------------------- flash
def flash_image(port: str, image: str, *, kind: str = "", baud: int = 921600,
                log: Callable[[str], None] = print) -> bool:
    """Flash one image with esptool. Returns True on success.

    An app image also rewrites `boot_app0.bin`; without that otadata reset the
    bootloader may keep booting the *other* OTA slot and the flash looks like a no-op.
    """
    tool = esptool_cmd()
    if not tool:
        log("  esptool not found — install the ESP32 core (arduino-cli core install esp32:esp32)")
        return False
    p = Path(image)
    if not p.exists():
        log(f"  image not found: {image}")
        return False
    kind = kind or classify(p.name, p.stat().st_size)
    cmd = tool + ["--chip", CHIP, "-p", port, "-b", str(baud), "write_flash"] + FLASH_ARGS
    if kind == "merged":
        cmd += ["0x0", str(p)]
    else:
        b0 = boot_app0()
        if b0:
            cmd += [OTADATA_OFFSET, b0]
        else:
            log("  warning: boot_app0.bin not found — otadata not reset, the board may keep the old slot")
        cmd += [APP_OFFSET, str(p)]
    log(f"  flashing {p.name} as a {kind} image at {'0x0' if kind == 'merged' else APP_OFFSET}…")
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    tail = (r.stdout or "").strip().splitlines()[-6:] + (r.stderr or "").strip().splitlines()[-4:]
    for line in tail:
        log(f"    {line}")
    if r.returncode != 0:
        log("  flash FAILED")
        return False
    log("  flashed — the board reboots into this build")
    return True


def flash_version(port: str, version: str, *, repo_dir: str = ".", prefer: str = "merged",
                  log: Callable[[str], None] = print) -> bool:
    """Flash a published version by number, e.g. "1.5.12"."""
    cands = [e for e in list_available(repo_dir) if e["version"] == version]
    if not cands:
        have = ", ".join(sorted({e["version"] for e in list_available(repo_dir)})) or "none"
        log(f"  no image for {version}. Available: {have}")
        return False
    cands.sort(key=lambda e: 0 if e["kind"] == prefer else 1)
    entry = cands[0]
    return flash_image(port, fetch(entry, repo_dir, log), kind=entry["kind"], log=log)


__all__ = ["list_available", "list_cached", "list_releases", "fetch", "flash_image",
           "flash_version", "classify", "CACHE"]
