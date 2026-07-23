#!/usr/bin/env python3
"""SATE Debugger — a native desktop app (Tkinter).

Left: a live mirror of the recorder's screen (over USB, debug build).
Right: debugger actions — diagnose, screenshot, reboot, flash, run tests,
provision Wi-Fi — with a live log.

Launch:  sate debug        (or  python3 debugger.py)
Separate from the web dashboard (`sate dashboard`) by design.
"""
from __future__ import annotations

import os
import queue
import subprocess
import sys
import threading
import time
import tkinter as tk
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hwtest import cli as C  # noqa: E402

# ---- palette (light, SATE web-app-ish) ----
BG = "#eef1f5"
CARD = "#ffffff"
INK = "#16202e"
INK2 = "#7c8698"
ACCENT = "#2563eb"
HAIR = "#e3e7ec"
OKC = "#15803d"
WARNC = "#b45309"
BADC = "#b91c1c"
BEZEL = "#0c0f14"
LOGBG = "#0f1420"
LOGINK = "#d7dde7"


# Public client config (same trust level as the app's JS bundle / firmware) — pre-filled
# so you don't type them. The account claim token still comes from you (or the Supabase MCP).
DEFAULT_SERVER = "https://zlgdpivcbmaodgokkdvz.supabase.co/functions/v1/device-api"
DEFAULT_ANON = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
                "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpsZ2RwaXZjYm1hb2Rnb2trZHZ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk3NTY5NTgsImV4cCI6MjA2NTMzMjk1OH0."
                "x58hiBi5EeRwbedrsrBzRkw7y2tFBw5ztIdmujZoPMQ")


def _mix(a, b, t):
    a = a.lstrip("#"); b = b.lstrip("#")
    return "#" + "".join(f"{round(int(a[i:i+2],16)*(1-t)+int(b[i:i+2],16)*t):02x}" for i in (0, 2, 4))


class Btn(tk.Frame):
    """Flat clickable button (tk.Button ignores bg on macOS Aqua)."""
    def __init__(self, parent, text, command, *, primary=False, danger=False, parent_bg=CARD):
        base = ACCENT if primary else (CARD if not danger else CARD)
        fg = "#ffffff" if primary else (BADC if danger else INK)
        super().__init__(parent, bg=base, highlightbackground=HAIR if not primary else ACCENT,
                         highlightthickness=1, cursor="pointinghand")
        self._base, self._fg, self._cmd, self._on = base, fg, command, True
        self.lbl = tk.Label(self, text=text, bg=base, fg=fg, font=("Helvetica Neue", 12),
                            padx=14, pady=7)
        self.lbl.pack()
        for w in (self, self.lbl):
            w.bind("<Button-1>", self._click)
            w.bind("<Enter>", lambda e: self._paint(_mix(self._base, "#000000", 0.06)))
            w.bind("<Leave>", lambda e: self._paint(self._base))

    def _paint(self, c):
        if self._on:
            self.config(bg=c); self.lbl.config(bg=c)

    def _click(self, _e):
        if self._on and self._cmd:
            self._cmd()

    def set_enabled(self, on):
        self._on = on
        self.lbl.config(fg=self._fg if on else INK2)
        self.config(cursor="pointinghand" if on else "arrow")


class Debugger:
    def __init__(self, root: tk.Tk, cfg: dict):
        self.root = root
        self.cfg = cfg or {}
        self.q: "queue.Queue[tuple]" = queue.Queue()
        self.busy = False                # a serial action is running
        self.mirror_on = False
        self.screen_img = None           # keep a ref (Tk GC)
        cfgport = (self.cfg.get("serial", {}) or {}).get("port")
        # prefer a port that actually exists (config can be stale after a USB renumber)
        self.port = cfgport if (cfgport and Path(cfgport).exists()) else (C._auto_port() or cfgport or "")
        self.action_btns: list[Btn] = []
        self.mirror_file = Path(__file__).resolve().parent / ".mirror.ppm"
        self._mtime = 0.0
        self._mirror_fails = 0
        self.claim_token = ""
        # pre-fill the public server URL + anon key so you don't type them
        srv = self.cfg.setdefault("server", {})
        if not srv.get("base_url"):
            srv["base_url"] = DEFAULT_SERVER
        if not srv.get("anon_key"):
            srv["anon_key"] = DEFAULT_ANON
        self._build()
        self.root.after(80, self._poll)
        self._log("SATE Debugger ready. Plug in the recorder (debug build) and hit Diagnose.", "head")

    # ---------- UI ----------
    def _build(self):
        r = self.root
        r.title("SATE Debugger")
        r.configure(bg=BG)
        r.geometry("1060x700")
        r.minsize(940, 620)

        header = tk.Frame(r, bg=BG)
        header.pack(fill="x", padx=18, pady=(14, 6))
        tk.Label(header, text="SATE Debugger", bg=BG, fg=INK,
                 font=("Helvetica Neue", 17, "bold")).pack(side="left")
        self.status = tk.Label(header, text="● no device", bg=BG, fg=INK2,
                               font=("Menlo", 11))
        self.status.pack(side="right")

        body = tk.Frame(r, bg=BG)
        body.pack(fill="both", expand=True, padx=18, pady=(0, 16))

        # ---- LEFT: device / live screen mirror ----
        left = tk.Frame(body, bg=CARD, highlightbackground=HAIR, highlightthickness=1)
        left.pack(side="left", fill="y")
        pad = tk.Frame(left, bg=CARD)
        pad.pack(fill="both", expand=True, padx=18, pady=16)
        tk.Label(pad, text="SATE RECORDER", bg=CARD, fg=INK2,
                 font=("Menlo", 10, "bold")).pack(anchor="w")
        self.serial_lbl = tk.Label(pad, text="—", bg=CARD, fg=INK,
                                   font=("Helvetica Neue", 16, "bold"))
        self.serial_lbl.pack(anchor="w", pady=(2, 2))
        self.dev_state = tk.Label(pad, text="● unknown", bg=CARD, fg=WARNC, font=("Menlo", 11))
        self.dev_state.pack(anchor="w", pady=(0, 12))

        # screen inside a black bezel (240x320 native)
        bez = tk.Frame(pad, bg=BEZEL)
        bez.pack()
        self.screen = tk.Label(bez, bg=BEZEL, fg="#54607a",
                               text="\n\n  no mirror yet\n\n  hit  Mirror ▶\n  (needs a --debug build)\n\n",
                               font=("Menlo", 11), width=26, height=17, justify="center")
        self.screen.pack(padx=14, pady=14)

        mrow = tk.Frame(pad, bg=CARD)
        mrow.pack(fill="x", pady=(12, 0))
        self.mirror_btn = Btn(mrow, "Mirror ▶", self._toggle_mirror, primary=True)
        self.mirror_btn.pack(side="left")
        Btn(mrow, "Snap once", self._snap_once).pack(side="left", padx=(8, 0))
        Btn(mrow, "Save PNG", self._save_png).pack(side="left", padx=(8, 0))

        # ---- RIGHT: actions + log ----
        right = tk.Frame(body, bg=BG)
        right.pack(side="left", fill="both", expand=True, padx=(16, 0))

        acard = tk.Frame(right, bg=CARD, highlightbackground=HAIR, highlightthickness=1)
        acard.pack(fill="x")
        ap = tk.Frame(acard, bg=CARD)
        ap.pack(fill="x", padx=16, pady=14)
        tk.Label(ap, text="DEBUGGER", bg=CARD, fg=INK2, font=("Menlo", 10, "bold")).pack(anchor="w")
        self.info_lbl = tk.Label(ap, text="fw — · provisioned — · port —", bg=CARD, fg=INK2,
                                 font=("Menlo", 10))
        self.info_lbl.pack(anchor="w", pady=(2, 10))

        grid = tk.Frame(ap, bg=CARD)
        grid.pack(fill="x")
        actions = [
            ("Diagnose", lambda: self._run(["doctor", "--device"], "Diagnose"), False, False),
            ("Screenshot", self._snap_once, False, False),
            ("Reboot", self._reboot, False, False),
            ("Provision Wi-Fi…", self._provision_dialog, False, False),
            ("SATE credentials…", self._creds_dialog, False, False),
            ("Run tests (sim)", lambda: self._run(["test", "--sim"], "Tests (sim)"), False, False),
            ("Run tests (hw)", lambda: self._run(["test", "--only", "boot_health", "--mirror", str(self.mirror_file)], "boot_health"), False, False),
            ("Flash DEBUG", lambda: self._confirm_flash(True), True, False),
            ("Flash prod", lambda: self._confirm_flash(False), False, True),
        ]
        for i, (label, cmd, prim, dang) in enumerate(actions):
            b = Btn(grid, label, cmd, primary=prim, danger=dang)
            b.grid(row=i // 2, column=i % 2, sticky="ew", padx=4, pady=4)
            self.action_btns.append(b)
        grid.columnconfigure(0, weight=1)
        grid.columnconfigure(1, weight=1)

        # log console
        lc = tk.Frame(right, bg=BG)
        lc.pack(fill="both", expand=True, pady=(12, 0))
        tk.Label(lc, text="LOG", bg=BG, fg=INK2, font=("Menlo", 10, "bold")).pack(anchor="w")
        self.log = tk.Text(lc, bg=LOGBG, fg=LOGINK, font=("Menlo", 11), wrap="word",
                           relief="flat", padx=12, pady=10, highlightthickness=1,
                           highlightbackground=HAIR, state="disabled")
        self.log.pack(fill="both", expand=True)
        self.log.tag_config("head", foreground="#7db3ff")
        self.log.tag_config("ok", foreground="#4ade80")
        self.log.tag_config("bad", foreground="#f87171")
        self.log.tag_config("dim", foreground=INK2)

    # ---------- helpers ----------
    def _log(self, text, tag=None):
        self.log.config(state="normal")
        self.log.insert("end", text + "\n", (tag,) if tag else ())
        self.log.see("end")
        self.log.config(state="disabled")

    def _set_busy(self, on):
        self.busy = on
        for b in self.action_btns:
            b.set_enabled(not on)

    # ---------- actions (subprocess to the sate CLI) ----------
    def _run(self, argv, label):
        if self.busy:
            return
        self._set_busy(True)
        self._log(f"\n$ sate {' '.join(argv)}", "head")

        def work():
            try:
                env = {**os.environ, "NO_COLOR": "1"}
                p = subprocess.Popen([sys.executable, "-m", "hwtest.cli", *argv],
                                     cwd=str(Path(__file__).resolve().parent),
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, env=env)
                for line in p.stdout:
                    self.q.put(("log", line.rstrip("\n"), None))
                p.wait()
                self.q.put(("log", f"[{label}] exit {p.returncode}", "ok" if p.returncode == 0 else "bad"))
            except Exception as e:  # noqa: BLE001
                self.q.put(("log", f"[{label}] error: {e}", "bad"))
            finally:
                self.q.put(("done", None, None))

        threading.Thread(target=work, daemon=True).start()

    def _reboot(self):
        if self.busy:
            return
        self._log("\nrebooting device over BLE…", "head")
        self._set_busy(True)

        def work():
            try:
                import asyncio
                from hwtest.recorder_ble import RecorderBle
                async def go():
                    addr = await RecorderBle.find("SATE-", timeout=8)
                    if not addr:
                        return "no recorder advertising over BLE"
                    async with RecorderBle(addr) as r:
                        return "reboot ack" if await r.reboot() else "no ack (op may be unsupported)"
                msg = asyncio.run(go())
                self.q.put(("log", f"  {msg}", "ok" if "ack" in msg else "bad"))
            except Exception as e:  # noqa: BLE001
                self.q.put(("log", f"  reboot failed: {e}", "bad"))
            finally:
                self.q.put(("done", None, None))
        threading.Thread(target=work, daemon=True).start()

    def _confirm_flash(self, debug):
        if self.busy:
            return
        kind = "DEBUG (screen mirror + serial log)" if debug else "PRODUCTION (no debug serial)"
        if not _confirm(self.root, f"Flash {kind}?",
                        "This overwrites the recorder firmware (a few minutes to compile).\nContinue?"):
            return
        argv = ["flash", "recorder"] + (["--debug"] if debug else [])
        self._run(argv, "Flash " + ("debug" if debug else "prod"))

    def _provision_dialog(self):
        if self.busy:
            return
        _ProvisionDialog(self.root, self._do_provision, (self.cfg.get("server", {}) or {}).get("base_url", ""))

    def _creds_dialog(self):
        _CredsDialog(self.root, self.cfg.get("server", {}) or {}, self._save_creds)

    def _save_creds(self, vals):
        srv = self.cfg.setdefault("server", {})
        for k in ("base_url", "anon_key", "device_key", "device_serial"):
            if vals.get(k) is not None:
                srv[k] = vals[k]
        self.claim_token = vals.get("claim_token", "")
        try:
            cfgpath = Path(__file__).resolve().parent / "config.toml"
            cfgpath.write_text(_toml_dump(self.cfg))
            self._log("SATE credentials saved to config.toml (tests + provisioning will use them)", "ok")
        except Exception as e:  # noqa: BLE001
            self._log(f"could not save config.toml: {e}", "bad")

    def _do_provision(self, ssid, pw, server, token):
        self._log(f"\nprovisioning Wi-Fi over BLE: {ssid}", "head")
        self._set_busy(True)

        def work():
            try:
                import asyncio
                from hwtest.recorder_ble import RecorderBle
                async def go():
                    addr = await RecorderBle.find("SATE-", timeout=10)
                    if not addr:
                        return {"state": "error", "msg": "no recorder advertising"}
                    async with RecorderBle(addr, log=lambda m: self.q.put(("log", m, "dim"))) as r:
                        if token and server:
                            return await r.provision(ssid, pw, server, token)
                        return await r.change_wifi(ssid, pw)
                res = asyncio.run(go())
                st = res.get("state")
                self.q.put(("log", f"  → {st}  {res.get('msg','') or ('ip='+res['ip'] if res.get('ip') else '')}",
                            "ok" if st in ("registered", "wifi_saved") else "bad"))
            except Exception as e:  # noqa: BLE001
                self.q.put(("log", f"  provision failed: {e}", "bad"))
            finally:
                self.q.put(("done", None, None))
        threading.Thread(target=work, daemon=True).start()

    # ---------- screen mirror ----------
    def _toggle_mirror(self):
        self.mirror_on = not self.mirror_on
        self.mirror_btn.lbl.config(text="Mirror ⏸" if self.mirror_on else "Mirror ▶")
        if self.mirror_on:
            self._log("live mirror on (~2.5s refresh)", "dim")
            threading.Thread(target=self._mirror_loop, daemon=True).start()

    def _mirror_loop(self):
        # ~2 FPS live mirror (within the 1-3 FPS the device tolerates). Paused
        # automatically while a serial action (test/flash/diagnose) is running —
        # during those, the mirror instead follows the test's --mirror file.
        while self.mirror_on:
            if not self.busy:
                self._capture_to_screen()
            time.sleep(0.5)

    def _snap_once(self):
        if self.busy:
            return
        threading.Thread(target=self._capture_to_screen, daemon=True).start()

    def _resolve_port(self):
        if self.port and Path(self.port).exists():
            return self.port
        p = C._auto_port()
        if p:
            self.port = p
        return self.port

    def _capture_to_screen(self):
        port = self._resolve_port()
        if not port:
            self.q.put(("mirror_fail", "no serial port", None)); return
        try:
            w, h, rgb = C.capture_screen(port, timeout=10)
            ppm = Path(__file__).resolve().parent / ".screen.ppm"
            with open(ppm, "wb") as f:
                f.write(b"P6\n%d %d\n255\n" % (w, h))
                f.write(rgb)
            self.q.put(("screen", str(ppm), None))
            self._mirror_fails = 0
        except Exception as e:  # noqa: BLE001
            self.q.put(("mirror_fail", str(e), None))

    def _save_png(self):
        if self.busy:
            return
        out = os.path.join(os.getcwd(), "sate-screen.png")
        threading.Thread(target=lambda: self._run(["screenshot", "-o", out], "Save PNG"), daemon=True).start()

    # ---------- poll loop ----------
    def _poll(self):
        try:
            while True:
                kind, a, b = self.q.get_nowait()
                if kind == "log":
                    self._log("  " + a if not a.startswith("[") and not a.startswith("$") else a, b)
                    self._scan_state(a)
                elif kind == "screen":
                    try:
                        img = tk.PhotoImage(file=a)
                        self.screen_img = img
                        self.screen.config(image=img, text="", width=img.width(), height=img.height())
                    except Exception as e:  # noqa: BLE001
                        self._log(f"render failed: {e}", "bad")
                elif kind == "mirror_fail":
                    self._mirror_fails += 1
                    if self._mirror_fails == 1:
                        self._log(f"mirror: {a}", "bad")
                    if self._mirror_fails >= 3 and self.mirror_on:
                        self.mirror_on = False
                        self.mirror_btn.lbl.config(text="Mirror ▶")
                        self._log("mirror paused — capture failing (check the port, or flash a --debug build)", "dim")
                elif kind == "done":
                    self._set_busy(False)
        except queue.Empty:
            pass
        # follow the test's --mirror file (updated between scenarios during a run)
        try:
            if self.mirror_file.exists():
                mt = self.mirror_file.stat().st_mtime
                if mt != self._mtime:
                    self._mtime = mt
                    img = tk.PhotoImage(file=str(self.mirror_file))
                    self.screen_img = img
                    self.screen.config(image=img, text="", width=img.width(), height=img.height())
        except Exception:
            pass
        self.root.after(80, self._poll)

    def _scan_state(self, line):
        # keep the header/device labels fresh from streamed doctor/serial output
        import re
        m = re.search(r"serial[=:]\s*(SATE-[0-9A-Fa-f]+)", line)
        if m:
            self.serial_lbl.config(text=m.group(1))
        if "device:" in line and "provisioned" in line:
            self.info_lbl.config(text=line.split("device:", 1)[1].strip())
        if "provisioned=1" in line or "claimed / provisioned" in line:
            self.dev_state.config(text="● provisioned", fg=OKC)
            self.status.config(text="● online", fg=OKC)
        elif "provisioned=0" in line or "UNCLAIMED" in line or "Ready for setup" in line:
            self.dev_state.config(text="● setup mode", fg=WARNC)
            self.status.config(text="● setup", fg=WARNC)
        if "no hardware faults" in line:
            self.status.config(text="● healthy", fg=OKC)
        if "fault(s) detected" in line:
            self.status.config(text="● FAULT", fg=BADC)


def _confirm(root, title, msg):
    from tkinter import messagebox
    return messagebox.askyesno(title, msg, parent=root)


def _toml_dump(cfg: dict) -> str:
    """Minimal TOML writer for the flat config structure the app manages."""
    def val(v):
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, (int, float)):
            return str(v)
        return '"' + str(v).replace("\\", "\\\\").replace('"', '\\"') + '"'
    lines = [f"{k} = {val(v)}" for k, v in cfg.items() if not isinstance(v, dict)]
    for sect, vals in cfg.items():
        if isinstance(vals, dict):
            lines.append(f"\n[{sect}]")
            lines += [f"{k} = {val(v)}" for k, v in vals.items()]
    return "\n".join(lines) + "\n"


class _CredsDialog(tk.Toplevel):
    def __init__(self, parent, server, on_submit):
        super().__init__(parent)
        self.title("SATE credentials")
        self.configure(bg=CARD)
        self.on_submit = on_submit
        self.resizable(False, False)
        rows = [("device-api base URL", "base_url"), ("Supabase anon key", "anon_key"),
                ("device key (SATE-xxxx)", "device_key"), ("device serial", "device_serial"),
                ("claim token (for register)", "claim_token")]
        tk.Label(self, text="Used by Run tests (server scenarios) and Provision + register.",
                 bg=CARD, fg=INK2, font=("Menlo", 10)).grid(row=0, column=0, columnspan=2,
                                                            sticky="w", padx=12, pady=(12, 6))
        self.vars = {}
        for i, (label, key) in enumerate(rows, start=1):
            tk.Label(self, text=label, bg=CARD, fg=INK2, font=("Menlo", 10)).grid(
                row=i, column=0, sticky="w", padx=12, pady=3)
            v = tk.StringVar(value=str(server.get(key, "")))
            self.vars[key] = v
            tk.Entry(self, textvariable=v, width=40, font=("Menlo", 11), relief="flat",
                     highlightthickness=1, highlightbackground=HAIR).grid(row=i, column=1, padx=12, pady=3)
        br = tk.Frame(self, bg=CARD)
        br.grid(row=len(rows) + 1, column=0, columnspan=2, pady=12)
        Btn(br, "Save", self._go, primary=True).pack(side="left", padx=6)
        Btn(br, "Cancel", self.destroy).pack(side="left", padx=6)

    def _go(self):
        self.on_submit({k: self.vars[k].get().strip() for k in self.vars})
        self.destroy()


class _ProvisionDialog(tk.Toplevel):
    def __init__(self, parent, on_submit, server_prefill=""):
        super().__init__(parent)
        self.title("Provision Wi-Fi (BLE)")
        self.configure(bg=CARD)
        self.on_submit = on_submit
        self.resizable(False, False)
        self._q = queue.Queue()

        top = tk.Frame(self, bg=CARD)
        top.grid(row=0, column=0, columnspan=2, sticky="ew", padx=12, pady=(12, 4))
        Btn(top, "Scan networks (BLE)", self._scan, primary=True).pack(side="left")
        self._status = tk.Label(top, text="the recorder scans Wi-Fi and lists them — you just pick + type the password",
                                bg=CARD, fg=INK2, font=("Menlo", 9), wraplength=280, justify="left")
        self._status.pack(side="left", padx=8)

        self.netbox = tk.Listbox(self, height=5, width=42, font=("Menlo", 11), relief="flat",
                                 highlightthickness=1, highlightbackground=HAIR, activestyle="none",
                                 selectbackground=_mix(CARD, ACCENT, 0.18))
        self.netbox.grid(row=1, column=0, columnspan=2, padx=12, pady=4, sticky="ew")
        self.netbox.bind("<<ListboxSelect>>", self._pick)

        rows = [("Wi-Fi SSID", "ssid", ""), ("Wi-Fi password", "pw", ""),
                ("device-api URL", "server", server_prefill or DEFAULT_SERVER),
                ("claim token (register)", "token", "")]
        self.vars = {}
        for i, (label, key, default) in enumerate(rows, start=2):
            tk.Label(self, text=label, bg=CARD, fg=INK2, font=("Menlo", 10)).grid(
                row=i, column=0, sticky="w", padx=12, pady=3)
            v = tk.StringVar(value=default)
            self.vars[key] = v
            tk.Entry(self, textvariable=v, width=34, show="•" if key == "pw" else "",
                     font=("Menlo", 11), relief="flat", highlightthickness=1,
                     highlightbackground=HAIR).grid(row=i, column=1, padx=12, pady=3)
        br = tk.Frame(self, bg=CARD)
        br.grid(row=len(rows) + 2, column=0, columnspan=2, pady=12)
        Btn(br, "Provision", self._go, primary=True).pack(side="left", padx=6)
        Btn(br, "Cancel", self.destroy).pack(side="left", padx=6)
        self.after(120, self._poll)

    def _scan(self):
        self._status.config(text="scanning over BLE… (~20s)")
        self.netbox.delete(0, "end")

        def work():
            try:
                import asyncio
                from hwtest.recorder_ble import RecorderBle
                async def go():
                    addr = await RecorderBle.find("SATE-", timeout=10)
                    if not addr:
                        return None
                    async with RecorderBle(addr) as r:
                        return await r.scan_wifi(timeout=25)
                self._q.put(asyncio.run(go()))
            except Exception as e:  # noqa: BLE001
                self._q.put(e)

        threading.Thread(target=work, daemon=True).start()

    def _poll(self):
        try:
            while True:
                item = self._q.get_nowait()
                if isinstance(item, Exception):
                    self._status.config(text=f"scan failed: {item}")
                elif item is None:
                    self._status.config(text="no recorder in BLE/setup mode")
                else:
                    ssids = sorted({n.get("ssid", "") for n in item if n.get("ssid")})
                    for s in ssids:
                        self.netbox.insert("end", s)
                    self._status.config(text=f"{len(ssids)} network(s) — click one, then type the password")
        except queue.Empty:
            pass
        try:
            self.after(150, self._poll)
        except tk.TclError:
            pass

    def _pick(self, _e):
        sel = self.netbox.curselection()
        if sel:
            self.vars["ssid"].set(self.netbox.get(sel[0]))

    def _go(self):
        v = {k: self.vars[k].get().strip() for k in self.vars}
        if not v["ssid"]:
            self._status.config(text="pick a network (or type an SSID) first")
            return
        self.destroy()
        self.on_submit(v["ssid"], v["pw"], v["server"], v["token"])


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="SATE Debugger — native desktop app")
    ap.add_argument("-c", "--config", help="path to config.toml")
    args = ap.parse_args()
    cfg = {}
    if args.config and Path(args.config).exists():
        try:
            import tomllib
        except ModuleNotFoundError:
            import tomli as tomllib  # type: ignore
        cfg = tomllib.load(open(args.config, "rb"))
    root = tk.Tk()
    Debugger(root, cfg)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
