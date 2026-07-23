#!/usr/bin/env python3
"""SATE Debugger — a native desktop app (Tkinter).

Flow mirrors the mobile app: log in → see your device → connect it → record/test.
Left panel is a live mirror of the recorder's screen; the right side walks you
through Connect → Test, with Tools and Firmware below. Launch: `sate debug`.
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
from hwtest.scenarios import ALL as SCENARIOS  # noqa: E402

# Public client config (same trust level as the app bundle / firmware).
DEFAULT_SERVER = "https://zlgdpivcbmaodgokkdvz.supabase.co/functions/v1/device-api"
DEFAULT_ANON = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
                "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpsZ2RwaXZjYm1hb2Rnb2trZHZ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk3NTY5NTgsImV4cCI6MjA2NTMzMjk1OH0."
                "x58hiBi5EeRwbedrsrBzRkw7y2tFBw5ztIdmujZoPMQ")

# palette (light, SATE web-app-ish)
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


def _mix(a, b, t):
    a = a.lstrip("#"); b = b.lstrip("#")
    return "#" + "".join(f"{round(int(a[i:i+2],16)*(1-t)+int(b[i:i+2],16)*t):02x}" for i in (0, 2, 4))


class Btn(tk.Frame):
    """Flat clickable button (tk.Button ignores bg on macOS Aqua)."""
    def __init__(self, parent, text, command, *, primary=False, danger=False, small=False):
        base = ACCENT if primary else CARD
        fg = "#ffffff" if primary else (BADC if danger else INK)
        super().__init__(parent, bg=base, highlightbackground=ACCENT if primary else HAIR,
                         highlightthickness=1, cursor="pointinghand")
        self._base, self._fg, self._cmd, self._on = base, fg, command, True
        self.lbl = tk.Label(self, text=text, bg=base, fg=fg,
                            font=("Helvetica Neue", 11 if small else 12), padx=12, pady=6 if small else 8)
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
    # Since fw 1.5.16/1.5.17 the reboot-resume case is hands-off too: remote record,
    # remote reboot, remote stop. Only the delete cases still need a human on the
    # Sessions screen (there is no remote "delete session" command).
    MANUAL = ("delete_journal", "delete_during_upload")
    AUTO = ("boot_health", "byte_match", "verified_trim", "reboot_resume")

    def __init__(self, root: tk.Tk, cfg: dict):
        self.root = root
        self.cfg = cfg or {}
        self.q: "queue.Queue[tuple]" = queue.Queue()
        self.busy = False
        self.mirror_on = False
        self.screen_img = None
        self.access_token = ""          # set on login
        self.email = ""
        self.serial = ""
        self.device_key = ""
        self.device_id = ""
        self.ack = threading.Event()
        self._pending_title = ""
        self._mirror_fails = 0
        self._mtime = 0.0
        self.action_btns: list[Btn] = []
        cfgport = (self.cfg.get("serial", {}) or {}).get("port")
        self.port = cfgport if (cfgport and Path(cfgport).exists()) else (C._auto_port() or cfgport or "")
        self.mirror_file = Path(__file__).resolve().parent / ".mirror.ppm"
        srv = self.cfg.setdefault("server", {})
        srv.setdefault("base_url", srv.get("base_url") or DEFAULT_SERVER)
        srv.setdefault("anon_key", srv.get("anon_key") or DEFAULT_ANON)

        root.title("SATE Debugger")
        root.configure(bg=BG)
        root.geometry("1080x720")
        root.minsize(960, 640)
        self._build_login()
        root.after(80, self._poll)

    # ======================================================= LOGIN SCREEN
    def _build_login(self):
        self.login = tk.Frame(self.root, bg=BG)
        self.login.pack(fill="both", expand=True)
        card = tk.Frame(self.login, bg=CARD, highlightbackground=HAIR, highlightthickness=1)
        card.place(relx=0.5, rely=0.44, anchor="center")
        pad = tk.Frame(card, bg=CARD)
        pad.pack(padx=42, pady=34)
        tk.Label(pad, text="SATE Debugger", bg=CARD, fg=INK, font=("Helvetica Neue", 20, "bold")).pack()
        tk.Label(pad, text="Log in with your SATE account", bg=CARD, fg=INK2,
                 font=("Menlo", 11)).pack(pady=(4, 18))
        acct = self.cfg.get("account", {}) or {}     # default creds from git-ignored config.toml
        self._login_vars = {}
        for label, key, show in [("Email", "email", ""), ("Password", "password", "•")]:
            tk.Label(pad, text=label, bg=CARD, fg=INK2, font=("Menlo", 10)).pack(anchor="w")
            v = tk.StringVar(value=str(acct.get(key, ""))); self._login_vars[key] = v
            e = tk.Entry(pad, textvariable=v, width=30, show=show, font=("Menlo", 12), relief="flat",
                         highlightthickness=1, highlightbackground=HAIR)
            e.pack(fill="x", pady=(2, 12), ipady=4)
            if key == "email":
                e.focus_set()
        self.login_err = tk.Label(pad, text="", bg=CARD, fg=BADC, font=("Menlo", 10), wraplength=300)
        self.login_err.pack()
        self.login_btn = Btn(pad, "Log in", self._submit_login, primary=True)
        self.login_btn.pack(fill="x", pady=(8, 6))
        tk.Label(pad, text="Use offline tools (flash / diagnose) without logging in →",
                 bg=CARD, fg=ACCENT, font=("Menlo", 9), cursor="pointinghand").pack()
        pad.winfo_children()[-1].bind("<Button-1>", lambda e: self._enter_main(offline=True))
        self.root.bind("<Return>", lambda e: self._submit_login())

    def _submit_login(self):
        email = self._login_vars["email"].get().strip()
        pw = self._login_vars["password"].get()
        if not email or not pw:
            self.login_err.config(text="enter your email and password"); return
        self.login_err.config(text="signing in…", fg=INK2)
        self.login_btn.set_enabled(False)

        def work():
            try:
                from hwtest import sate_account as A
                tok = A.login(email, pw)
                self.q.put(("login_ok", (email, tok), None))
            except Exception as e:  # noqa: BLE001
                self.q.put(("login_err", str(e), None))
        threading.Thread(target=work, daemon=True).start()

    def _enter_main(self, offline=False):
        self.root.unbind("<Return>")
        self.login.destroy()
        self._build_main(offline=offline)

    # ======================================================= MAIN SCREEN
    def _build_main(self, offline=False):
        r = self.root
        header = tk.Frame(r, bg=BG)
        header.pack(fill="x", padx=18, pady=(14, 6))
        tk.Label(header, text="SATE Debugger", bg=BG, fg=INK,
                 font=("Helvetica Neue", 17, "bold")).pack(side="left")
        who = self.email if not offline else "offline tools"
        tk.Label(header, text=f"  ·  {who}", bg=BG, fg=INK2, font=("Menlo", 11)).pack(side="left")
        self.status = tk.Label(header, text="● no device", bg=BG, fg=INK2, font=("Menlo", 11))
        self.status.pack(side="right")

        body = tk.Frame(r, bg=BG)
        body.pack(fill="both", expand=True, padx=18, pady=(0, 16))

        # ---- LEFT: device / live screen ----
        left = tk.Frame(body, bg=CARD, highlightbackground=HAIR, highlightthickness=1)
        left.pack(side="left", fill="y")
        pad = tk.Frame(left, bg=CARD)
        pad.pack(fill="both", expand=True, padx=18, pady=16)
        tk.Label(pad, text="SATE RECORDER", bg=CARD, fg=INK2, font=("Menlo", 10, "bold")).pack(anchor="w")
        self.serial_lbl = tk.Label(pad, text="—", bg=CARD, fg=INK, font=("Helvetica Neue", 16, "bold"))
        self.serial_lbl.pack(anchor="w", pady=(2, 2))
        self.dev_state = tk.Label(pad, text="● unknown", bg=CARD, fg=WARNC, font=("Menlo", 11))
        self.dev_state.pack(anchor="w", pady=(0, 12))
        bez = tk.Frame(pad, bg=BEZEL)
        bez.pack()
        self.screen = tk.Label(bez, bg=BEZEL, fg="#54607a",
                               text="\n\n  live screen\n\n  press  Mirror\n\n", font=("Menlo", 11),
                               width=26, height=17, justify="center")
        self.screen.pack(padx=14, pady=14)
        mrow = tk.Frame(pad, bg=CARD)
        mrow.pack(fill="x", pady=(12, 0))
        self.mirror_btn = Btn(mrow, "Mirror", self._toggle_mirror, primary=True, small=True)
        self.mirror_btn.pack(side="left")
        Btn(mrow, "Snap", self._snap_once, small=True).pack(side="left", padx=(6, 0))
        Btn(mrow, "Save PNG", self._save_png, small=True).pack(side="left", padx=(6, 0))

        # ---- RIGHT: guided actions + results + log ----
        right = tk.Frame(body, bg=BG)
        right.pack(side="left", fill="both", expand=True, padx=(16, 0))
        acard = tk.Frame(right, bg=CARD, highlightbackground=HAIR, highlightthickness=1)
        acard.pack(fill="x")
        ap = tk.Frame(acard, bg=CARD)
        ap.pack(fill="x", padx=16, pady=(12, 14))
        self.info_lbl = tk.Label(ap, text="fw —  ·  port —", bg=CARD, fg=INK2, font=("Menlo", 10))
        self.info_lbl.pack(anchor="w")

        self.action_btns = []

        def section(title):
            tk.Label(ap, text=title, bg=CARD, fg=INK2, font=("Menlo", 10, "bold")).pack(anchor="w", pady=(12, 4))
            f = tk.Frame(ap, bg=CARD)
            f.pack(fill="x")
            return f

        def add(frame, text, cmd, *, primary=False, danger=False, wide=False):
            b = Btn(frame, text, cmd, primary=primary, danger=danger)
            b.pack(side="top", fill="x", pady=3) if wide else b.pack(side="left", fill="x", expand=True, padx=(0, 6), pady=3)
            self.action_btns.append(b)
            return b

        # 1) DEVICE — connect / set up (mobile-app step 1)
        f = section("1 · DEVICE")
        add(f, "Connect / set up device…", self._connect_dialog, primary=not offline, wide=True)
        row = tk.Frame(ap, bg=CARD); row.pack(fill="x")
        add(row, "Diagnose", lambda: self._run(["doctor", "--device"], "Diagnose"))
        add(row, "Live status", self._refresh_status)

        # 2) TEST — record & verify (mobile-app step 2)
        f = section("2 · TEST RECORDING")
        add(f, "▶  Run automatic tests", lambda: self._run_tests_inproc(self.AUTO, sim=False),
            primary=True, wide=True)

        # Every scenario the harness ships, individually selectable — so a bench run
        # can be narrowed to the one case you are chasing instead of the whole suite.
        self.scn_vars = {}
        box = tk.Frame(ap, bg=CARD, highlightbackground=HAIR, highlightthickness=1)
        box.pack(fill="x", pady=(6, 2))
        for sc in SCENARIOS:
            manual = sc.key in self.MANUAL
            v = tk.BooleanVar(value=not manual)
            self.scn_vars[sc.key] = v
            r = tk.Frame(box, bg=CARD); r.pack(fill="x", padx=8, pady=1)
            tk.Checkbutton(r, variable=v, bg=CARD, activebackground=CARD, highlightthickness=0,
                           bd=0).pack(side="left")
            tk.Label(r, text=sc.key, bg=CARD, fg=INK, font=("Menlo", 10, "bold"),
                     width=20, anchor="w").pack(side="left")
            tk.Label(r, text=("needs a tap on the device" if manual else "hands-off"),
                     bg=CARD, fg=(WARNC if manual else INK2), font=("Menlo", 9),
                     anchor="w").pack(side="left")
        row = tk.Frame(ap, bg=CARD); row.pack(fill="x")
        add(row, "Run selected", self._run_selected)
        add(row, "All", lambda: self._select_scn("all"))
        add(row, "Hands-off only", lambda: self._select_scn("auto"))
        row = tk.Frame(ap, bg=CARD); row.pack(fill="x")
        add(row, "Try in simulator", lambda: self._run_tests_inproc(None, sim=True))
        add(row, "Take screenshot", self._snap_once)

        # 3) REMOTE CONTROL — the device-api command channel (fw >=1.5.17)
        f = section("3 · REMOTE CONTROL")
        row = tk.Frame(ap, bg=CARD); row.pack(fill="x")
        add(row, "● Record", lambda: self._remote("record"))
        add(row, "■ Stop", lambda: self._remote("stop"))
        add(row, "↻ Reboot", lambda: self._remote("reboot"))
        row = tk.Frame(ap, bg=CARD); row.pack(fill="x")
        add(row, "Sync now", lambda: self._remote("sync_now"))
        add(row, "Re-sync all", lambda: self._remote("resync_all"))

        # 4) TOOLS
        f = section("TOOLS")
        row = tk.Frame(ap, bg=CARD); row.pack(fill="x")
        add(row, "Reboot over BLE", self._reboot)
        add(row, "Move Wi-Fi…", self._connect_dialog)

        # 5) FIRMWARE
        f = section("FIRMWARE")
        row = tk.Frame(ap, bg=CARD); row.pack(fill="x")
        add(row, "Flash debug build", lambda: self._confirm_flash(True))
        add(row, "Flash production", lambda: self._confirm_flash(False), danger=True)
        add(f, "Flash an older version…", self._flash_old_dialog, wide=True)

        # results
        rc = tk.Frame(right, bg=BG); rc.pack(fill="x", pady=(12, 0))
        tk.Label(rc, text="RESULTS", bg=BG, fg=INK2, font=("Menlo", 10, "bold")).pack(anchor="w")
        self.results_frame = tk.Frame(rc, bg=BG); self.results_frame.pack(fill="x")

        # bench prompt
        self.prompt_frame = tk.Frame(right, bg="#fff7e6", highlightbackground=WARNC, highlightthickness=1)
        self.prompt_msg = tk.Label(self.prompt_frame, text="", bg="#fff7e6", fg="#7a4b00",
                                   font=("Menlo", 11), wraplength=520, justify="left")
        self.prompt_msg.pack(side="left", padx=12, pady=8)
        Btn(self.prompt_frame, "Done ▸", self._ack, primary=True).pack(side="right", padx=10, pady=8)

        # log
        lc = tk.Frame(right, bg=BG); lc.pack(fill="both", expand=True, pady=(12, 0))
        tk.Label(lc, text="LOG", bg=BG, fg=INK2, font=("Menlo", 10, "bold")).pack(anchor="w")
        self.log = tk.Text(lc, bg=LOGBG, fg=LOGINK, font=("Menlo", 11), wrap="word", relief="flat",
                           padx=12, pady=10, highlightthickness=1, highlightbackground=HAIR, state="disabled")
        self.log.pack(fill="both", expand=True)
        for tag, col in [("head", "#7db3ff"), ("ok", "#4ade80"), ("bad", "#f87171"), ("dim", INK2)]:
            self.log.tag_config(tag, foreground=col)

        msg = "Ready." if offline else f"Logged in as {self.email}."
        self._log(msg + "  Start with 1 · Connect / set up device, then 2 · Run recording tests.", "head")
        self._refresh_status()

    # ======================================================= helpers
    def _log(self, text, tag=None):
        self.log.config(state="normal")
        self.log.insert("end", text + "\n", (tag,) if tag else ())
        self.log.see("end")
        self.log.config(state="disabled")

    def _set_busy(self, on):
        self.busy = on
        for b in self.action_btns:
            b.set_enabled(not on)

    def _resolve_port(self):
        if self.port and Path(self.port).exists():
            return self.port
        p = C._auto_port()
        if p:
            self.port = p
        return self.port

    # ---- account/device connect (mobile-app flow) ----
    def _connect_dialog(self):
        if self.busy:
            return
        if not self.access_token:
            self._log("log in first (restart and sign in) to connect a device to your account.", "bad")
            return
        _ConnectDialog(self.root, self._do_connect)

    def _do_connect(self, ssid, wifipw):
        self._log(f"\nConnecting device to your account (Wi-Fi: {ssid}) …", "head")
        self._set_busy(True)

        def work():
            try:
                import asyncio
                from hwtest import sate_account as A
                from hwtest.recorder_ble import RecorderBle
                server = (self.cfg.get("server", {}) or {}).get("base_url") or DEFAULT_SERVER

                async def peek():
                    addr = await RecorderBle.find("SATE-", timeout=8)
                    if not addr:
                        return None, None, None
                    async with RecorderBle(addr) as r:
                        info = await r.read_info()
                        return addr, info.get("serial"), info.get("provisioned")
                addr, serial, provisioned = asyncio.run(peek())
                if serial:
                    self.serial = serial

                if addr and provisioned is False:
                    self.q.put(("log", "  device unclaimed → registering + claiming…", "dim"))
                    token = A.claim_token(self.access_token)

                    async def prov():
                        async with RecorderBle(addr, log=lambda m: self.q.put(("log", m, "dim"))) as r:
                            return await r.provision(ssid, wifipw, server, token)
                    res = asyncio.run(prov())
                    if (res or {}).get("state") != "registered":
                        self.q.put(("log", f"  ✗ {(res or {}).get('state')} {(res or {}).get('msg', '')}", "bad")); return
                    dev_id = res.get("device_id", "")
                    self.device_id = dev_id
                    self.device_key = ("key-" + dev_id) if dev_id else ""
                    self.q.put(("log", f"  ✓ connected — registered + claimed (device_id={dev_id}, ip={res.get('ip', '?')})", "ok"))
                else:
                    self.q.put(("log", "  device already claimed — keeping the account", "ok"))
                    if not self.serial:
                        self.serial = (self.cfg.get("server", {}) or {}).get("device_serial") or ""
                    if self.serial:
                        self.device_key, self.device_id = A.device_key_for(self.access_token, self.serial)
                    if ssid and addr:
                        async def chg():
                            async with RecorderBle(addr, log=lambda m: self.q.put(("log", m, "dim"))) as r:
                                return await r.change_wifi(ssid, wifipw)
                        r2 = asyncio.run(chg())
                        self.q.put(("log", f"  Wi-Fi → {r2.get('state')}", "ok" if r2.get("state") == "wifi_saved" else "bad"))

                # write creds so the tests can run (incl. automatic remote recording)
                srv = self.cfg.setdefault("server", {})
                if self.device_key:
                    srv["device_key"] = self.device_key
                if self.serial:
                    srv["device_serial"] = self.serial
                if self.device_id:
                    srv["device_id"] = self.device_id
                srv["access_token"] = self.access_token
                self.cfg.setdefault("actions", {})["record_mode"] = "remote"
                try:
                    (Path(__file__).resolve().parent / "config.toml").write_text(_toml_dump(self.cfg))
                except Exception:  # noqa: BLE001
                    pass
                self.q.put(("log", "  ✓ device ready — recordings will run automatically (except reboot-resume)", "ok"))
            except Exception as e:  # noqa: BLE001
                self.q.put(("log", f"  connect failed: {e}", "bad"))
            finally:
                self.q.put(("done", None, None))
        threading.Thread(target=work, daemon=True).start()

    # ---- subprocess actions ----
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
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
                for line in p.stdout:
                    self.q.put(("log", line.rstrip("\n"), None))
                p.wait()
                self.q.put(("log", f"[{label}] exit {p.returncode}", "ok" if p.returncode == 0 else "bad"))
            except Exception as e:  # noqa: BLE001
                self.q.put(("log", f"[{label}] error: {e}", "bad"))
            finally:
                self.q.put(("done", None, None))
        threading.Thread(target=work, daemon=True).start()

    def _refresh_status(self):
        if self.busy:
            return
        threading.Thread(target=self._probe_status, daemon=True).start()

    def _probe_status(self):
        port = self._resolve_port()
        self.q.put(("info", f"port {port or '—'}", None))

    # ---- results / prompt ----
    def _clear_results(self):
        self._pending_title = ""
        for w in self.results_frame.winfo_children():
            w.destroy()

    def _add_result(self, title, status):
        colors = {"PASS": OKC, "FAIL": BADC, "ERROR": "#7c3aed", "SKIP": WARNC}
        c = colors.get(status, INK2)
        row = tk.Frame(self.results_frame, bg=CARD, highlightbackground=HAIR, highlightthickness=1)
        row.pack(fill="x", pady=2)
        tk.Label(row, text=status, bg=CARD, fg=c, font=("Menlo", 10, "bold"), width=6).pack(side="left", padx=(8, 4), pady=5)
        tk.Label(row, text=title, bg=CARD, fg=INK, font=("Helvetica Neue", 11), anchor="w",
                 wraplength=500, justify="left").pack(side="left", fill="x", expand=True, pady=5)

    def _scan_result(self, line):
        import re
        s = line.strip()
        if s.startswith("── "):
            self._pending_title = s[3:].strip(); return
        m = re.match(r"→\s+(PASS|FAIL|SKIP|ERROR):", s)
        if m and self._pending_title:
            self._add_result(self._pending_title, m.group(1))
            self._pending_title = ""

    def _ack(self):
        self.ack.set()

    def _show_prompt(self, msg):
        if msg:
            self.prompt_msg.config(text=msg)
            self.prompt_frame.pack(fill="x", pady=(10, 0))
        else:
            self.prompt_frame.pack_forget()

    # ---- tests (in-process, with prompts + mirror) ----
    def _run_tests_inproc(self, keys=None, sim=False):
        if self.busy:
            return
        # enable automatic remote recording when logged in: fetch the device key/id
        # from the account and set record_mode=remote (reboot_resume still prompts).
        if not sim and self.access_token:
            srv = self.cfg.setdefault("server", {})
            srv["access_token"] = self.access_token
            if self.serial and not srv.get("device_id"):
                from hwtest import sate_account as A
                try:
                    dk, did = A.device_key_for(self.access_token, self.serial)
                    if dk:
                        srv["device_key"] = self.device_key = dk
                    if did:
                        srv["device_id"] = self.device_id = did
                except Exception:  # noqa: BLE001
                    pass
            self.cfg.setdefault("actions", {})["record_mode"] = "remote"
        self._set_busy(True)
        self._clear_results()
        self._log(f"\nRunning {'simulator' if sim else 'recording'} tests…", "head")
        cfg = dict(self.cfg)
        port = self._resolve_port()
        if port and not sim:
            cfg["serial"] = {**cfg.get("serial", {}), "port": port}
        if sim:
            cfg["record"] = {**cfg.get("record", {}), "take_s": 1, "resume_hold_s": 0,
                             "trim_watch_s": 0.3, "gap_wait_s": 0.3, "upload_wait_s": 3, "delete_target": 1}

        def worker():
            from hwtest.runner import run
            def log_fn(l):
                self.q.put(("log", l, None))
            def prompt_fn(msg):
                self.q.put(("prompt", msg, None)); self.ack.clear(); self.ack.wait(); self.q.put(("prompt", None, None))
            try:
                run(cfg, keys, sim=sim, log=log_fn, color=False, prompt_fn=prompt_fn,
                    mirror=None if sim else str(self.mirror_file))
            except Exception as e:  # noqa: BLE001
                self.q.put(("log", f"[harness error] {e}", "bad"))
            finally:
                self.q.put(("done", None, None))
        threading.Thread(target=worker, daemon=True).start()

    def _select_scn(self, which):
        for k, v in self.scn_vars.items():
            v.set(True if which == "all" else (k not in self.MANUAL))

    def _run_selected(self):
        keys = [k for k, v in self.scn_vars.items() if v.get()]
        if not keys:
            self._log("  tick at least one scenario first.", "bad"); return
        if any(k in self.MANUAL for k in keys):
            self._log("  note: a selected scenario needs you to delete a session on the device screen.", "dim")
        self._run_tests_inproc(keys, sim=False)

    def _ensure_device_id(self):
        """Resolve this bench device's device-api id from the signed-in account."""
        if self.device_id or not (self.access_token and self.serial):
            return self.device_id
        try:
            from hwtest import sate_account as A
            dk, did = A.device_key_for(self.access_token, self.serial)
            self.device_key = dk or self.device_key
            self.device_id = did or self.device_id
        except Exception:  # noqa: BLE001
            pass
        return self.device_id

    def _remote(self, op):
        """Queue a device-api command (record / stop / reboot / sync_now / resync_all).

        Note this is the ONLY reliable way to reboot a unit that is mid-take: the
        debug build's Serial is USB-CDC and its DTR/RTS reset is handled in software,
        which the capture loop never services, so a serial reset is ignored while
        recording. The command channel lives on the core-0 net task and keeps running.
        """
        if self.busy:
            return
        if not self.access_token:
            self._log("  sign in first — remote commands go through your account.", "bad"); return
        if not self._ensure_device_id():
            self._log("  no device selected — run 1 · Connect / set up device first.", "bad"); return
        self._log(f"\nsending remote command: {op}", "head")
        self._set_busy(True)

        def work():
            import json, urllib.request
            srv = self.cfg.get("server", {})
            url = f"{srv.get('base_url', DEFAULT_SERVER)}/api/devices/{self.device_id}/commands"
            try:
                req = urllib.request.Request(
                    url, data=json.dumps({"op": op}).encode(), method="POST",
                    headers={"Authorization": f"Bearer {self.access_token}",
                             "apikey": srv.get("anon_key", DEFAULT_ANON),
                             "Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=20):
                    pass
                self.q.put(("log", f"  queued — the device runs it on its next poll (<10s)", "ok"))
            except Exception as e:  # noqa: BLE001
                self.q.put(("log", f"  failed: {e}", "bad"))
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

    def _flash_old_dialog(self):
        """Pick a published build and put it back on the board.

        Used to reproduce a field bug on the version that actually shipped, or to
        bisect a regression. Prefers the *merged* image: it rewrites the whole flash
        (bootloader + partitions + app), so the board lands in a known state no
        matter which OTA slot it was running.
        """
        if self.busy:
            return
        self._log("\nlooking for flashable firmware images…", "head")
        self._set_busy(True)

        def work():
            try:
                from hwtest import firmware as FW
                rows = FW.list_available(str(C.REPO))
                self.q.put(("fwlist", rows, None))
            except Exception as e:  # noqa: BLE001
                self.q.put(("log", f"  could not list firmware: {e}", "bad"))
                self.q.put(("done", None, None))
        threading.Thread(target=work, daemon=True).start()

    def _show_fw_list(self, rows):
        self._set_busy(False)
        if not rows:
            self._log("  no images found — cut a GitHub release with a .bin asset, "
                      "or drop one in ~/.sate/firmware/.", "bad")
            return
        win = tk.Toplevel(self.root); win.title("Flash an older version"); win.configure(bg=BG)
        win.transient(self.root); win.grab_set()
        tk.Label(win, text="Flash an older firmware", bg=BG, fg=INK,
                 font=("Menlo", 13, "bold")).pack(anchor="w", padx=18, pady=(16, 2))
        tk.Label(win, text="This replaces what is on the board. 'merged' rewrites the whole\n"
                           "flash; 'app' writes the OTA slot and resets otadata.",
                 bg=BG, fg=INK2, font=("Menlo", 10), justify="left").pack(anchor="w", padx=18)
        lb = tk.Listbox(win, bg=CARD, fg=INK, font=("Menlo", 11), height=min(10, len(rows)),
                        relief="flat", highlightthickness=1, highlightbackground=HAIR,
                        activestyle="none", width=54)
        for e in rows:
            lb.insert("end", f"  {e['version']:9} {e['kind']:7} {e['size']/1e6:6.1f} MB   {e['source']}")
        lb.selection_set(0)
        lb.pack(fill="x", padx=18, pady=12)
        bar = tk.Frame(win, bg=BG); bar.pack(fill="x", padx=18, pady=(0, 16))

        def go():
            sel = lb.curselection()
            if not sel:
                return
            entry = rows[sel[0]]
            win.destroy()
            if not _confirm(self.root, "Flash older firmware",
                            f"Flash {entry['version']} ({entry['kind']}) onto the board?\n\n"
                            "Whatever is on it now is overwritten."):
                return
            self._do_flash_entry(entry)

        Btn(bar, "Flash it", go, primary=True).pack(side="right")
        Btn(bar, "Cancel", win.destroy).pack(side="right", padx=(0, 8))

    def _do_flash_entry(self, entry):
        port = self._resolve_port()
        if not port:
            self._log("  no serial port — plug the board in.", "bad"); return
        self._log(f"\nflashing firmware {entry['version']} ({entry['kind']})…", "head")
        self._set_busy(True)

        def work():
            try:
                from hwtest import firmware as FW
                path = FW.fetch(entry, str(C.REPO), log=lambda l: self.q.put(("log", l, None)))
                okd = FW.flash_image(port, path, kind=entry["kind"],
                                     log=lambda l: self.q.put(("log", l, None)))
                self.q.put(("log", f"  {'done' if okd else 'flash failed'}", "ok" if okd else "bad"))
            except Exception as e:  # noqa: BLE001
                self.q.put(("log", f"  flash failed: {e}", "bad"))
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
        self._run(["flash", "recorder"] + (["--debug"] if debug else []), "Flash " + ("debug" if debug else "prod"))

    # ---- mirror ----
    def _toggle_mirror(self):
        self.mirror_on = not self.mirror_on
        self.mirror_btn.lbl.config(text="Stop mirror" if self.mirror_on else "Mirror")
        if self.mirror_on:
            self._log("live mirror on (~2 FPS)", "dim")
            threading.Thread(target=self._mirror_loop, daemon=True).start()

    def _mirror_loop(self):
        while self.mirror_on:
            if not self.busy:
                self._capture_to_screen()
            time.sleep(0.5)

    def _snap_once(self):
        if self.busy:
            return
        threading.Thread(target=self._capture_to_screen, daemon=True).start()

    def _capture_to_screen(self):
        port = self._resolve_port()
        if not port:
            self.q.put(("mirror_fail", "no serial port", None)); return
        try:
            w, h, rgb = C.capture_screen(port, timeout=10)
            ppm = Path(__file__).resolve().parent / ".screen.ppm"
            with open(ppm, "wb") as f:
                f.write(b"P6\n%d %d\n255\n" % (w, h)); f.write(rgb)
            self.q.put(("screen", str(ppm), None))
            self._mirror_fails = 0
        except Exception as e:  # noqa: BLE001
            self.q.put(("mirror_fail", str(e), None))

    def _save_png(self):
        if self.busy:
            return
        self._run(["screenshot", "-o", os.path.join(os.getcwd(), "sate-screen.png")], "Save PNG")

    # ======================================================= poll loop
    def _poll(self):
        try:
            while True:
                kind, a, b = self.q.get_nowait()
                if kind == "login_ok":
                    self.email, self.access_token = a
                    self._enter_main(offline=False)
                elif kind == "login_err":
                    self.login_err.config(text=a, fg=BADC)
                    self.login_btn.set_enabled(True)
                elif kind == "log":
                    self._log("  " + a if not a.startswith(("[", "$", "══")) else a, b)
                    self._scan_state(a); self._scan_result(a)
                elif kind == "fwlist":
                    self._show_fw_list(a)
                elif kind == "info":
                    if hasattr(self, "info_lbl"):
                        self.info_lbl.config(text=a)
                elif kind == "screen":
                    try:
                        img = tk.PhotoImage(file=a)
                        self.screen_img = img
                        self.screen.config(image=img, text="", width=img.width(), height=img.height())
                    except Exception:  # noqa: BLE001
                        pass
                elif kind == "clear_results":
                    self._clear_results()
                elif kind == "prompt":
                    self._show_prompt(a)
                elif kind == "mirror_fail":
                    self._mirror_fails += 1
                    if self._mirror_fails == 1:
                        self._log(f"mirror: {a}", "bad")
                    if self._mirror_fails >= 3 and self.mirror_on:
                        self.mirror_on = False
                        self.mirror_btn.lbl.config(text="Mirror")
                        self._log("mirror paused — check the port / flash a --debug build", "dim")
                elif kind == "done":
                    self._set_busy(False)
        except queue.Empty:
            pass
        # follow the test's mirror file during a run
        try:
            if hasattr(self, "screen") and self.mirror_file.exists():
                mt = self.mirror_file.stat().st_mtime
                if mt != self._mtime:
                    self._mtime = mt
                    img = tk.PhotoImage(file=str(self.mirror_file))
                    self.screen_img = img
                    self.screen.config(image=img, text="", width=img.width(), height=img.height())
        except Exception:  # noqa: BLE001
            pass
        self.root.after(80, self._poll)

    def _scan_state(self, line):
        import re
        m = re.search(r"serial[=:]\s*(SATE-[0-9A-Fa-f]+)", line)
        if m and hasattr(self, "serial_lbl"):
            self.serial = m.group(1)
            self.serial_lbl.config(text=self.serial)
        if not hasattr(self, "dev_state"):
            return
        if "provisioned=1" in line or "claimed / provisioned" in line or "Online (Wi-Fi)" in line:
            self.dev_state.config(text="● connected", fg=OKC); self.status.config(text="● online", fg=OKC)
        elif "provisioned=0" in line or "Ready for setup" in line:
            self.dev_state.config(text="● needs setup", fg=WARNC); self.status.config(text="● setup", fg=WARNC)
        if "no hardware faults" in line:
            self.status.config(text="● healthy", fg=OKC)
        if "fault(s) detected" in line:
            self.status.config(text="● FAULT", fg=BADC)


def _confirm(root, title, msg):
    from tkinter import messagebox
    return messagebox.askyesno(title, msg, parent=root)


def _toml_dump(cfg: dict) -> str:
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


class _ConnectDialog(tk.Toplevel):
    """Connect a device: scan Wi-Fi over BLE, pick a network, type the password."""
    def __init__(self, parent, on_submit):
        super().__init__(parent)
        self.title("Connect device — Wi-Fi")
        self.configure(bg=CARD)
        self.on_submit = on_submit
        self.resizable(False, False)
        self._q = queue.Queue()
        self.vars = {"ssid": tk.StringVar(), "pw": tk.StringVar()}
        tk.Label(self, text="The recorder scans Wi-Fi — pick your network and type the password.",
                 bg=CARD, fg=INK2, font=("Menlo", 10), wraplength=400, justify="left").grid(
            row=0, column=0, columnspan=2, sticky="w", padx=12, pady=(12, 6))
        top = tk.Frame(self, bg=CARD)
        top.grid(row=1, column=0, columnspan=2, sticky="ew", padx=12, pady=2)
        Btn(top, "Scan Wi-Fi", self._scan, primary=True, small=True).pack(side="left")
        self._status = tk.Label(top, text="", bg=CARD, fg=INK2, font=("Menlo", 9),
                                wraplength=250, justify="left"); self._status.pack(side="left", padx=8)
        self.netbox = tk.Listbox(self, height=5, width=42, font=("Menlo", 11), relief="flat",
                                 highlightthickness=1, highlightbackground=HAIR, activestyle="none",
                                 selectbackground=_mix(CARD, ACCENT, 0.18))
        self.netbox.grid(row=2, column=0, columnspan=2, padx=12, pady=4, sticky="ew")
        self.netbox.bind("<<ListboxSelect>>", self._pick)
        for i, (label, key, show) in enumerate([("Wi-Fi SSID", "ssid", ""), ("Wi-Fi password", "pw", "•")], start=3):
            tk.Label(self, text=label, bg=CARD, fg=INK2, font=("Menlo", 10)).grid(row=i, column=0, sticky="w", padx=12, pady=3)
            tk.Entry(self, textvariable=self.vars[key], width=32, show=show, font=("Menlo", 11), relief="flat",
                     highlightthickness=1, highlightbackground=HAIR).grid(row=i, column=1, padx=12, pady=3)
        br = tk.Frame(self, bg=CARD); br.grid(row=6, column=0, columnspan=2, pady=12)
        Btn(br, "Connect", self._go, primary=True).pack(side="left", padx=6)
        Btn(br, "Cancel", self.destroy).pack(side="left", padx=6)
        self.after(120, self._poll)

    def _scan(self):
        self._status.config(text="scanning… (~20s)"); self.netbox.delete(0, "end")

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
                    for s in sorted({n.get("ssid", "") for n in item if n.get("ssid")}):
                        self.netbox.insert("end", s)
                    self._status.config(text=f"{self.netbox.size()} network(s) — click one")
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
        ssid = self.vars["ssid"].get().strip()
        pw = self.vars["pw"].get()
        if not ssid:
            self._status.config(text="pick a network first"); return
        self.destroy()
        self.on_submit(ssid, pw)


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
