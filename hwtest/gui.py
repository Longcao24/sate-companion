#!/usr/bin/env python3
"""SATE hardware test — native desktop window (Tkinter).

Same job as dashboard.py but a real OS window instead of a browser tab: pick
scenarios, watch the device's serial log live, and answer bench prompts ("press
RECORD", "cut power") with a button.

    python3 gui.py --config config.toml    # real hardware
    python3 gui.py                          # sim-only (no board attached)

The test runs on a background thread; it talks to the Tk main thread through a
queue (Tk is not thread-safe). Bench prompts block the worker on an Event that the
"Done ▸" button sets.
"""
from __future__ import annotations

import argparse
import queue
import threading
from pathlib import Path
import sys

import tkinter as tk
from tkinter import font as tkfont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hwtest.runner import run  # noqa: E402
from hwtest.scenarios import ALL  # noqa: E402
from hwtest.pendant import PENDANT_SCENARIOS, run_pendant  # noqa: E402

# palette (matches the audit dashboard's dark theme)
BG, PANEL, INK, INK2, HAIR = "#0f1417", "#161d21", "#e7eeea", "#a9b6bc", "#26302f"
LOGBG, ACCENT = "#0b0f11", "#2fb39c"
SEV = {"PASS": "#5cc183", "FAIL": "#e8695b", "SKIP": "#e0a23c", "ERROR": "#a395c9"}
AMBER = "#e0a23c"


def _mix(a, b, t):
    a, b = a.lstrip("#"), b.lstrip("#")
    c = [round(int(a[i:i + 2], 16) + (int(b[i:i + 2], 16) - int(a[i:i + 2], 16)) * t)
         for i in (0, 2, 4)]
    return "#%02x%02x%02x" % tuple(c)


class Btn(tk.Frame):
    """A themed button drawn from a Frame+Label — because tk.Button ignores bg on
    macOS (Aqua) and renders washed-out. Full color + hover + enabled control."""

    def __init__(self, parent, text, command, *, primary=False, fill=None,
                 fg=None, parent_bg=BG):
        base = fill or (ACCENT if primary else PANEL)
        self.txt = fg or ("#0b0f11" if (primary or fill) else INK)
        border = base if (primary or fill) else _mix(PANEL, INK, 0.25)
        super().__init__(parent, bg=base, highlightthickness=1,
                         highlightbackground=border, highlightcolor=border)
        self.base, self.command, self._on = base, command, True
        self.lbl = tk.Label(self, text=text, bg=base, fg=self.txt,
                            font=("Menlo", 12), padx=16, pady=7, cursor="pointinghand")
        self.lbl.pack()
        for w in (self, self.lbl):
            w.bind("<Button-1>", self._click)
            w.bind("<Enter>", self._enter)
            w.bind("<Leave>", self._leave)

    def _paint(self, c):
        self.config(bg=c)
        self.lbl.config(bg=c)

    def _click(self, _e):
        if self._on and self.command:
            self.command()

    def _enter(self, _e):
        if self._on:
            self._paint(_mix(self.base, "#ffffff", 0.14))

    def _leave(self, _e):
        if self._on:
            self._paint(self.base)

    def set_enabled(self, on):
        self._on = on
        self._paint(self.base if on else PANEL)
        self.lbl.config(fg=self.txt if on else INK2, cursor="pointinghand" if on else "arrow")


class Dropdown(tk.Frame):
    """A themed dropdown — tk.OptionMenu renders white-on-white on macOS (Aqua), so
    this draws its own value box and a borderless popup list."""

    def __init__(self, parent, var, width=26):
        super().__init__(parent, bg=PANEL, highlightthickness=1, highlightbackground=HAIR)
        self.var = var
        self.options = []
        self.lbl = tk.Label(self, textvariable=var, bg=PANEL, fg=INK, font=("Menlo", 11),
                            padx=10, pady=5, anchor="w", width=width, cursor="pointinghand")
        self.lbl.pack(side="left")
        self.caret = tk.Label(self, text="▾", bg=PANEL, fg=INK2, font=("Menlo", 11),
                              padx=6, cursor="pointinghand")
        self.caret.pack(side="left")
        for w in (self.lbl, self.caret):
            w.bind("<Button-1>", self._open)

    def set_options(self, opts):
        self.options = list(opts)

    def _open(self, _e):
        if not self.options:
            return
        top = tk.Toplevel(self)
        top.overrideredirect(True)
        top.configure(bg=HAIR)
        top.geometry("+%d+%d" % (self.winfo_rootx(), self.winfo_rooty() + self.winfo_height()))
        for opt in self.options:
            row = tk.Label(top, text=opt, bg=PANEL, fg=INK, font=("Menlo", 11),
                           anchor="w", padx=10, pady=5, width=max(30, len(opt) + 2),
                           cursor="pointinghand")
            row.pack(fill="x", padx=1, pady=1)
            row.bind("<Enter>", lambda e, w=row: w.config(bg=_mix(PANEL, "#ffffff", 0.14)))
            row.bind("<Leave>", lambda e, w=row: w.config(bg=PANEL))
            row.bind("<Button-1>", lambda e, o=opt, t=top: (self.var.set(o), t.destroy()))
        top.bind("<FocusOut>", lambda e: top.destroy())
        top.focus_set()


class App:
    def __init__(self, root: tk.Tk, cfg: dict):
        self.root = root
        self.cfg = cfg
        self.q: queue.Queue = queue.Queue()
        self.ack = threading.Event()
        self.running = False
        self.vars: dict[str, tk.BooleanVar] = {}
        self._build()
        self.root.after(80, self._poll)

    # ---------- layout ----------
    def _build(self):
        r = self.root
        r.title("SATE hardware-in-the-loop test")
        r.configure(bg=BG)
        r.geometry("1000x640")
        mono = tkfont.Font(family="Menlo", size=12)
        monosm = tkfont.Font(family="Menlo", size=11)
        bold = tkfont.Font(family="Menlo", size=13, weight="bold")

        header = tk.Frame(r, bg=BG)
        header.pack(fill="x", padx=18, pady=(14, 8))
        tk.Label(header, text="🩺  SATE hardware-in-the-loop test", bg=BG, fg=INK,
                 font=bold).pack(side="left")
        self.status = tk.Label(header, text="idle", bg=BG, fg=INK2, font=monosm)
        self.status.pack(side="right")

        body = tk.Frame(r, bg=BG)
        body.pack(fill="both", expand=True, padx=18, pady=(0, 16))

        # left column
        side = tk.Frame(body, bg=BG, width=330)
        side.pack(side="left", fill="y")
        side.pack_propagate(False)

        self.monosm = monosm
        # device selector — recorder (USB serial) or pendant (BLE)
        self.target = tk.StringVar(value="recorder")
        self.trow = tk.Frame(side, bg=BG)
        self.trow.pack(fill="x", pady=(0, 6))
        tk.Label(self.trow, text="DEVICE", bg=BG, fg=ACCENT, font=monosm).pack(side="left")
        for label, val in (("Recorder (USB)", "recorder"), ("Pendant (BLE)", "pendant")):
            tk.Radiobutton(self.trow, text=label, value=val, variable=self.target,
                           command=self._on_target, bg=BG, fg=INK, selectcolor=PANEL,
                           activebackground=BG, activeforeground=INK,
                           highlightthickness=0, bd=0, font=("Menlo", 10)).pack(side="left", padx=(6, 0))

        # serial-port picker (recorder only) — auto-scans /dev/cu.usbmodem*
        self.port_row = tk.Frame(side, bg=BG)
        tk.Label(self.port_row, text="PORT", bg=BG, fg=ACCENT, font=monosm).pack(side="left")
        self.port_var = tk.StringVar(value="—")
        self.port_dd = Dropdown(self.port_row, self.port_var)
        self.port_dd.pack(side="left", padx=(6, 0))
        Btn(self.port_row, "⟳", self._scan_ports).pack(side="left", padx=(6, 0))

        # pendant picker (BLE only) — Scan lists nearby pendants
        self.ble_row = tk.Frame(side, bg=BG)
        tk.Label(self.ble_row, text="PENDANT", bg=BG, fg=ACCENT, font=monosm).pack(side="left")
        self.ble_var = tk.StringVar(value="— tap Scan —")
        self.ble_map = {}
        self.ble_dd = Dropdown(self.ble_row, self.ble_var)
        self.ble_dd.pack(side="left", padx=(6, 0))
        Btn(self.ble_row, "Scan", self._scan_ble).pack(side="left", padx=(6, 0))

        tk.Label(side, text="SCENARIOS", bg=BG, fg=ACCENT, font=monosm).pack(anchor="w")
        self.scen_frame = tk.Frame(side, bg=BG)
        self.scen_frame.pack(fill="x")

        # actions + results (side) — MUST be created here in _build, not in a scan
        # callback, or they never appear.
        btns = tk.Frame(side, bg=BG)
        btns.pack(fill="x", pady=(16, 4))
        self.b_sim = Btn(btns, "▶  Run (sim)", lambda: self._start(True), primary=True)
        self.b_sim.pack(side="left")
        self.b_hw = Btn(btns, "Run (hardware)", lambda: self._start(False))
        self.b_hw.pack(side="left", padx=(8, 0))

        self.prompt_frame = tk.Frame(side, bg="#3a2e12", highlightbackground=AMBER,
                                     highlightthickness=1)
        self.prompt_msg = tk.Label(self.prompt_frame, text="", bg="#3a2e12", fg=INK,
                                   font=monosm, wraplength=290, justify="left")
        self.prompt_msg.pack(anchor="w", padx=10, pady=(8, 6))
        Btn(self.prompt_frame, "Done ▸", self._ack, fill=AMBER, fg="#0b0f11",
            parent_bg="#3a2e12").pack(anchor="w", padx=10, pady=(0, 8))

        tk.Label(side, text="RESULTS", bg=BG, fg=ACCENT, font=monosm).pack(anchor="w", pady=(14, 2))
        self.results = tk.Frame(side, bg=BG)
        self.results.pack(fill="x")

        # right column — live serial log
        right = tk.Frame(body, bg=BG)
        right.pack(side="left", fill="both", expand=True, padx=(16, 0))
        self.log = tk.Text(right, bg=LOGBG, fg=INK, font=mono, wrap="word",
                           insertbackground=INK, relief="flat", padx=12, pady=10,
                           highlightthickness=1, highlightbackground=HAIR)
        self.log.pack(fill="both", expand=True)
        sb = tk.Scrollbar(self.log, command=self.log.yview)
        sb.pack(side="right", fill="y")
        self.log.config(yscrollcommand=sb.set, state="disabled")
        self.log.tag_config("head", foreground=ACCENT, font=("Menlo", 12, "bold"))
        self.log.tag_config("pass", foreground=SEV["PASS"], font=("Menlo", 12, "bold"))
        self.log.tag_config("fail", foreground=SEV["FAIL"], font=("Menlo", 12, "bold"))
        self.log.tag_config("prompt", foreground=AMBER, font=("Menlo", 12, "bold"))
        self.log.tag_config("dim", foreground=INK2)
        self.log.tag_config("guard", foreground=_mix(INK2, BG, 0.15))

        self._scan_ports()
        self._on_target()

    def _on_target(self):
        self._populate()
        if self.target.get() == "recorder":
            self.ble_row.pack_forget()
            self.port_row.pack(fill="x", pady=(0, 6), after=self.trow)
        else:
            self.port_row.pack_forget()
            self.ble_row.pack(fill="x", pady=(0, 6), after=self.trow)

    def _scan_ports(self):
        ports = []
        try:
            from serial.tools import list_ports
            ports = [p.device for p in list_ports.comports()
                     if any(k in p.device for k in ("usbmodem", "usbserial", "wchusb", "SLAB"))]
        except Exception:
            import glob
            ports = sorted(glob.glob("/dev/cu.usbmodem*") + glob.glob("/dev/cu.usbserial*")
                           + glob.glob("/dev/cu.wchusbserial*"))
        if not ports:
            self.port_dd.set_options([])
            self.port_var.set("— no board detected —")
            return
        cfgport = (self.cfg.get("serial", {}) or {}).get("port")
        default = cfgport if cfgport in ports else ports[0]
        self.port_dd.set_options(ports)
        self.port_var.set(default)

    def _scan_ble(self):
        self.ble_var.set("scanning… (~6s)")

        def w():
            try:
                import asyncio
                from bleak import BleakScanner
                SVC = "19b10000-e8f2-537e-4f6c-d104768a1214"
                want = ((self.cfg.get("pendant", {}) or {}).get("name", "SATE Pendant")).lower()

                async def go():
                    res = await BleakScanner.discover(timeout=6.0, return_adv=True)
                    out = []
                    for d, adv in res.values():
                        name = d.name or getattr(adv, "local_name", "") or ""
                        uuids = [u.lower() for u in (getattr(adv, "service_uuids", None) or [])]
                        hit = want in name.lower() or SVC in uuids
                        if name or hit:
                            out.append((hit, name or "(unknown)", d.address))
                    out.sort(key=lambda x: (not x[0], x[1]))     # pendant matches first
                    return [(n, a) for _, n, a in out]

                found = asyncio.run(go())
            except Exception as e:
                found = [(f"scan failed: {type(e).__name__}", "")]
            self.q.put(("ble", found))

        threading.Thread(target=w, daemon=True).start()

    def _fill_ble(self, found):
        self.ble_map = {}
        if not found:
            self.ble_dd.set_options([])
            self.ble_var.set("— none found —")
            return
        labels = []
        for name, addr in found:
            label = f"{name}  {addr}" if addr else name
            self.ble_map[label] = addr
            labels.append(label)
        self.ble_dd.set_options(labels)
        self.ble_var.set(labels[0])

    def _populate(self):
        for w in self.scen_frame.winfo_children():
            w.destroy()
        self.vars = {}
        if self.target.get() == "pendant":
            items = [(k, k, "BLE stream / control check") for k in PENDANT_SCENARIOS]
        else:
            items = [(s.key, s.title, s.bug) for s in ALL]
        for key, title, bug in items:
            v = tk.BooleanVar(value=True)
            self.vars[key] = v
            row = tk.Frame(self.scen_frame, bg=BG)
            row.pack(fill="x", pady=(6, 0))
            tk.Checkbutton(row, variable=v, bg=BG, fg=INK, selectcolor=PANEL,
                           activebackground=BG, activeforeground=INK,
                           highlightthickness=0, bd=0).pack(side="left", anchor="n")
            txt = tk.Frame(row, bg=BG)
            txt.pack(side="left", fill="x")
            tk.Label(txt, text=title, bg=BG, fg=INK, font=self.monosm,
                     wraplength=270, justify="left").pack(anchor="w")
            tk.Label(txt, text="↳ " + bug, bg=BG, fg=INK2, font=("Menlo", 9),
                     wraplength=270, justify="left").pack(anchor="w")

    # ---------- run control ----------
    def _selected(self):
        return [k for k, v in self.vars.items() if v.get()] or None

    def _start(self, sim: bool):
        if self.running:
            return
        self.running = True
        self.b_sim.set_enabled(False)
        self.b_hw.set_enabled(False)
        self.status.config(text="running (sim)" if sim else "running (hardware)")
        self._clear_log()
        for w in self.results.winfo_children():
            w.destroy()
        target = self.target.get()
        cfg = dict(self.cfg)
        if sim and target == "recorder":
            rec = dict(cfg.get("record", {}))
            rec.update({"take_s": 1, "resume_hold_s": 0, "trim_watch_s": 0.3,
                        "gap_wait_s": 0.3, "upload_wait_s": 3, "delete_target": 1})
            cfg["record"] = rec
        if target == "recorder" and self.port_var.get().startswith("/dev/"):
            ser = dict(cfg.get("serial", {}))
            ser["port"] = self.port_var.get()          # the port picked in the UI wins
            cfg["serial"] = ser
        if target == "pendant":
            addr = self.ble_map.get(self.ble_var.get())
            if addr:
                pd = dict(cfg.get("pendant", {}))
                pd["address"] = addr                    # the pendant picked in the UI wins
                cfg["pendant"] = pd
        keys = self._selected()

        def worker():
            def log_fn(line):
                self.q.put(("log", line))

            def prompt_fn(msg):
                self.q.put(("prompt", msg))
                self.ack.clear()
                self.ack.wait()
                self.q.put(("prompt", None))

            try:
                if target == "pendant":
                    res = run_pendant(cfg, keys, sim=sim, log=log_fn, prompt=prompt_fn)
                else:
                    res = run(cfg, keys, sim=sim, log=log_fn, color=False, prompt_fn=prompt_fn)
                self.q.put(("results", [(r.status, r.title, r.detail) for r in res]))
            except Exception as e:
                self.q.put(("log", f"[harness error] {type(e).__name__}: {e}"))
            self.q.put(("done", None))

        threading.Thread(target=worker, daemon=True).start()

    def _ack(self):
        self.ack.set()

    # ---------- queue drain (main thread) ----------
    def _poll(self):
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == "log":
                    self._append(payload)
                elif kind == "prompt":
                    self._show_prompt(payload)
                elif kind == "ble":
                    self._fill_ble(payload)
                elif kind == "results":
                    self._show_results(payload)
                elif kind == "done":
                    self.running = False
                    self.b_sim.set_enabled(True)
                    self.b_hw.set_enabled(True)
                    self.status.config(text="done")
        except queue.Empty:
            pass
        self.root.after(80, self._poll)

    def _append(self, line: str):
        s = line.strip()
        tag = ()
        if s.startswith("──"):
            tag = "head"
        elif "PASS" in line:
            tag = "pass"
        elif "FAIL" in line or "ERROR" in line:
            tag = "fail"
        elif s.startswith("▸") or s.startswith("⚠") or "→ SKIP" in line:
            tag = "prompt"
        elif s.startswith("guards:"):
            tag = "guard"
        elif line.startswith("      │") or s.startswith("["):
            tag = "dim"
        self.log.config(state="normal")
        self.log.insert("end", line + "\n", tag)
        self.log.see("end")
        self.log.config(state="disabled")

    def _clear_log(self):
        self.log.config(state="normal")
        self.log.delete("1.0", "end")
        self.log.config(state="disabled")

    def _show_prompt(self, msg):
        if msg:
            self.prompt_msg.config(text="⚠ Bench step\n" + msg)
            self.prompt_frame.pack(fill="x", pady=(12, 0))
        else:
            self.prompt_frame.pack_forget()

    def _show_results(self, rows):
        for status, title, detail in rows:
            row = tk.Frame(self.results, bg=BG)
            row.pack(fill="x", pady=2)
            tk.Label(row, text=status, bg=BG, fg=SEV.get(status, INK),
                     font=("Menlo", 11, "bold"), width=6, anchor="w").pack(side="left")
            tk.Label(row, text=title, bg=BG, fg=INK, font=("Menlo", 11),
                     wraplength=240, justify="left").pack(side="left")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", "-c")
    args = ap.parse_args()
    cfg: dict = {}
    if args.config:
        import tomllib
        with open(args.config, "rb") as f:
            cfg = tomllib.load(f)
    root = tk.Tk()
    App(root, cfg)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
