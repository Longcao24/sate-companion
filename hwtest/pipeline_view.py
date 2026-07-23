"""Live audio-pipeline window — WHERE the take is, right now, end to end.

An animated map of the whole system:

    Recorder → device-api → Storage+DB → Queue
                                            ↓
       Done ← Finalize ← AI service ← Cloudflare

Green segments are behind the audio; the current hop pulses and carries a moving
dot with marching-ants dashes, so a glance shows exactly which tier is holding the
take. Timings are live (elapsed ticks every frame) and historic (each finished
session's queue / processing / total, with the running average) — the same numbers
`sate e2e` prints, drawn instead of printed.

All data comes from `hwtest.pipeline` (the rows the web app reads + the device
heartbeat), polled every 2 s on a worker thread. Tk work stays on the main thread.

Standalone:  python3 pipeline_view.py   (or `sate pipeline`) — logs in from
config.toml. From the Debugger it opens pre-authenticated via open_pipeline().
"""
from __future__ import annotations

import queue
import threading
import time
import tkinter as tk

from hwtest import pipeline as P

# palette — matches debugger.py
BG = "#eef1f5"
CARD = "#ffffff"
INK = "#16202e"
INK2 = "#7c8698"
ACCENT = "#2563eb"
HAIR = "#e3e7ec"
OKC = "#15803d"
WARNC = "#b45309"
BADC = "#b91c1c"
NODE_IDLE = "#f2f4f8"
NODE_EDGE = "#cfd6df"

# canvas layout: serpentine, 4 nodes per row
NODE_W, NODE_H = 170, 64
GAP_X, GAP_Y = 52, 76
MARGIN = 26

# graph node index per pipeline stage key
STAGE_NODE = {"record": 0, "upload": 1, "stored": 2, "queued": 3,
              "claimed": 4, "ai": 5, "finalize": 6, "done": 7, "error": 5}


def _fmt_s(v):
    if v is None:
        return "—"
    return f"{v:.0f}s" if v >= 9.5 else f"{v:.1f}s"


class PipelineView:
    POLL_S = 2.0

    def __init__(self, root: tk.Misc, token: str, serial: str, device_id: str,
                 base_url: str, anon_key: str, *, own_root: bool = False):
        self.token, self.serial = token, serial
        self.device_id, self.base_url, self.anon = device_id, base_url, anon_key
        self.own_root = own_root
        self.q: "queue.Queue[tuple]" = queue.Queue()
        self.snap: P.Snapshot | None = None
        self.testing = False
        self._closed = False
        self._dash = 0
        self._dot_t = 0.0

        w = root if own_root else tk.Toplevel(root)
        self.win = w
        w.title(f"SATE — Audio pipeline · {serial}")
        w.configure(bg=BG)
        w.protocol("WM_DELETE_WINDOW", self._close)

        head = tk.Frame(w, bg=BG)
        head.pack(fill="x", padx=18, pady=(14, 4))
        tk.Label(head, text="AUDIO PIPELINE — LIVE", bg=BG, fg=INK,
                 font=("Helvetica Neue", 15, "bold")).pack(side="left")
        self.dev_lbl = tk.Label(head, text=f"{serial} · …", bg=BG, fg=INK2, font=("Menlo", 11))
        self.dev_lbl.pack(side="right")

        cw = 4 * NODE_W + 3 * GAP_X + 2 * MARGIN
        ch = 2 * NODE_H + GAP_Y + 2 * MARGIN
        cvwrap = tk.Frame(w, bg=CARD, highlightbackground=HAIR, highlightthickness=1)
        cvwrap.pack(padx=18, pady=6)
        self.cv = tk.Canvas(cvwrap, width=cw, height=ch, bg=CARD, highlightthickness=0)
        self.cv.pack(padx=8, pady=8)
        self._layout(cw, ch)

        # active-take strip
        act = tk.Frame(w, bg=CARD, highlightbackground=HAIR, highlightthickness=1)
        act.pack(fill="x", padx=18, pady=(6, 0))
        self.active_lbl = tk.Label(act, text="no take in flight", bg=CARD, fg=INK2,
                                   font=("Menlo", 11), anchor="w")
        self.active_lbl.pack(side="left", padx=12, pady=8)
        self.elapsed_lbl = tk.Label(act, text="", bg=CARD, fg=ACCENT,
                                    font=("Menlo", 11, "bold"))
        self.elapsed_lbl.pack(side="right", padx=12)

        # history: how long past runs took
        hist = tk.Frame(w, bg=CARD, highlightbackground=HAIR, highlightthickness=1)
        hist.pack(fill="both", expand=True, padx=18, pady=(8, 6))
        tk.Label(hist, text="PAST RUNS  ·  session — size — queue — processing — total",
                 bg=CARD, fg=INK2, font=("Menlo", 10, "bold"), anchor="w") \
            .pack(fill="x", padx=12, pady=(8, 2))
        self.hist_box = tk.Text(hist, bg=CARD, fg=INK, font=("Menlo", 11), height=8,
                                relief="flat", state="disabled", padx=12, pady=4)
        self.hist_box.pack(fill="both", expand=True)
        for tag, col in [("ok", OKC), ("bad", BADC), ("dim", INK2), ("avg", ACCENT)]:
            self.hist_box.tag_config(tag, foreground=col)

        bar = tk.Frame(w, bg=BG)
        bar.pack(fill="x", padx=18, pady=(2, 14))
        self.test_btn = tk.Button(bar, text="▶  Run pipeline test (record 8s → follow it through)",
                                  command=self._run_test, relief="flat", bg=ACCENT, fg="white",
                                  activebackground="#1d4ed8", activeforeground="white",
                                  font=("Helvetica Neue", 12, "bold"), padx=14, pady=6)
        self.test_btn.pack(side="left")
        tk.Label(bar, text="polls every 2 s — data is the same rows the web app reads",
                 bg=BG, fg=INK2, font=("Menlo", 9)).pack(side="right")

        threading.Thread(target=self._poll_loop, daemon=True).start()
        self._tick()

    # ---------------------------------------------------------------- layout
    def _layout(self, cw, ch):
        self.centers = []
        top_y = MARGIN + NODE_H / 2
        bot_y = MARGIN + NODE_H + GAP_Y + NODE_H / 2
        for i in range(4):     # row 1, left → right
            x = MARGIN + NODE_W / 2 + i * (NODE_W + GAP_X)
            self.centers.append((x, top_y))
        for i in range(4):     # row 2, right → left (serpentine)
            x = cw - MARGIN - NODE_W / 2 - i * (NODE_W + GAP_X)
            self.centers.append((x, bot_y))

        self.seg_items = []
        for i in range(7):
            x1, y1 = self.centers[i]
            x2, y2 = self.centers[i + 1]
            if i == 3:  # the wrap from Queue down to Cloudflare
                pts = (x1 + NODE_W / 2 - 8, y1, x1 + NODE_W / 2 + 26, y1,
                       x2 + NODE_W / 2 + 26, y2, x2 + NODE_W / 2 - 8, y2)
                item = self.cv.create_line(*pts, smooth=True, width=3, fill=NODE_EDGE,
                                           arrow="last", arrowshape=(12, 14, 5))
            else:
                sx = x1 + NODE_W / 2 if x2 > x1 else x1 - NODE_W / 2
                ex = x2 - NODE_W / 2 if x2 > x1 else x2 + NODE_W / 2
                item = self.cv.create_line(sx, y1, ex, y2, width=3, fill=NODE_EDGE,
                                           arrow="last", arrowshape=(12, 14, 5))
            self.seg_items.append(item)

        self.node_items = []
        for i, (key, name, blurb) in enumerate(P.STAGES):
            x, y = self.centers[i]
            r = self.cv.create_rectangle(x - NODE_W / 2, y - NODE_H / 2,
                                         x + NODE_W / 2, y + NODE_H / 2,
                                         fill=NODE_IDLE, outline=NODE_EDGE, width=2)
            t = self.cv.create_text(x, y - 12, text=name, fill=INK,
                                    font=("Helvetica Neue", 12, "bold"))
            sub = self.cv.create_text(x, y + 10, text=blurb, fill=INK2,
                                      font=("Menlo", 8), width=NODE_W - 16)
            self.node_items.append((r, t, sub))

        self.dot = self.cv.create_oval(0, 0, 0, 0, fill=ACCENT, outline="")

    # ----------------------------------------------------------------- data
    def _poll_loop(self):
        while not self._closed:
            try:
                snap = P.snapshot(self.token, self.serial)
                self.q.put(("snap", snap))
            except Exception as e:  # noqa: BLE001
                self.q.put(("err", str(e)))
            time.sleep(self.POLL_S)

    def _run_test(self):
        if self.testing:
            return
        self.testing = True
        self.test_btn.config(state="disabled", text="▶  test running — watch the graph…")

        def work():
            import json
            import urllib.request
            try:
                def cmd(op):
                    req = urllib.request.Request(
                        f"{self.base_url}/api/devices/{self.device_id}/commands",
                        data=json.dumps({"op": op}).encode(), method="POST",
                        headers={"Authorization": f"Bearer {self.token}", "apikey": self.anon,
                                 "Content-Type": "application/json"})
                    with urllib.request.urlopen(req, timeout=20):
                        pass
                cmd("record")
                time.sleep(14)     # queue latency + ~8 s of audio
                cmd("stop")        # the poll loop takes it from here
            except Exception as e:  # noqa: BLE001
                self.q.put(("err", f"pipeline test: {e}"))
            finally:
                self.q.put(("test_done", None))
        threading.Thread(target=work, daemon=True).start()

    # ------------------------------------------------------------------ draw
    def _apply(self, snap: P.Snapshot):
        self.snap = snap
        self.dev_lbl.config(text=f"{self.serial} · {snap.device_state}")
        stage = snap.live_stage
        cur = STAGE_NODE.get(stage, 7)
        err = snap.active.status == "error" if snap.active else False

        for i, (r, t, sub) in enumerate(self.node_items):
            if err and i == cur:
                self.cv.itemconfigure(r, fill="#fdecec", outline=BADC)
            elif i < cur or (stage == "done" and not snap.active):
                self.cv.itemconfigure(r, fill="#e9f7ee", outline=OKC)
            elif i == cur:
                self.cv.itemconfigure(r, fill="#e8efff", outline=ACCENT)
            else:
                self.cv.itemconfigure(r, fill=NODE_IDLE, outline=NODE_EDGE)
        for i, seg in enumerate(self.seg_items):
            if i < cur:
                self.cv.itemconfigure(seg, fill=OKC, dash=())
            elif i == cur and cur < 7:
                self.cv.itemconfigure(seg, fill=ACCENT)
            else:
                self.cv.itemconfigure(seg, fill=NODE_EDGE, dash=())

        # live node sublabels
        subs = {i: b for i, (_, _, b) in enumerate(P.STAGES)}
        if snap.active:
            a = snap.active
            now = time.time()
            if a.stage == "queued" and a.created:
                subs[3] = f"waiting {now - a.created:.0f}s"
            if a.stage == "ai" and a.started:
                subs[4] = "job claimed"
                subs[5] = f"in flight {now - a.started:.0f}s"
            subs[2] = f"{a.bytes / 1e6:.2f} MB stored"
        hist_done = [h for h in (self.snap.history if self.snap else []) if h.processing_s]
        if hist_done:
            avg = sum(h.processing_s for h in hist_done) / len(hist_done)
            subs[6] = f"avg process {_fmt_s(avg)}"
        for i, (_, _, sub) in enumerate(self.node_items):
            self.cv.itemconfigure(sub, text=subs[i])

        # active strip
        if snap.active:
            a = snap.active
            self.active_lbl.config(
                fg=(BADC if err else INK),
                text=(f"session {a.session_number} · {a.bytes / 1e6:.2f} MB · "
                      f"{'ERROR: ' + str(a.error)[:60] if err else 'stage: ' + a.stage}"))
        elif snap.device_state in ("recording", "uploading"):
            self.active_lbl.config(fg=INK, text=f"device is {snap.device_state} — row lands after the upload")
        else:
            self.active_lbl.config(fg=INK2, text="no take in flight — history below")

        # history
        self.hist_box.config(state="normal")
        self.hist_box.delete("1.0", "end")
        done_rows = [h for h in snap.history if h.status in ("done", "error")]
        for h in done_rows[:8]:
            tag = "ok" if h.status == "done" else "bad"
            self.hist_box.insert(
                "end",
                f"  s{h.session_number:<4} {h.bytes / 1e6:7.2f} MB   queue {_fmt_s(h.queue_wait_s):>6}   "
                f"process {_fmt_s(h.processing_s):>6}   total {_fmt_s(h.total_s):>6}   {h.status}\n", (tag,))
        if hist_done:
            n = len(hist_done)
            aq = sum(h.queue_wait_s or 0 for h in hist_done) / n
            ap = sum(h.processing_s for h in hist_done) / n
            at = sum(h.total_s or 0 for h in hist_done) / n
            self.hist_box.insert(
                "end", f"  avg ({n} runs)        queue {_fmt_s(aq):>6}   "
                       f"process {_fmt_s(ap):>6}   total {_fmt_s(at):>6}\n", ("avg",))
        self.hist_box.config(state="disabled")

    def _tick(self):
        if self._closed:
            return
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == "snap":
                    self._apply(payload)
                elif kind == "err":
                    self.active_lbl.config(text=f"poll error: {payload}", fg=WARNC)
                elif kind == "test_done":
                    self.testing = False
                    self.test_btn.config(state="normal",
                                         text="▶  Run pipeline test (record 8s → follow it through)")
        except queue.Empty:
            pass

        # animation: marching ants + a dot travelling the active segment
        snap = self.snap
        if snap:
            cur = STAGE_NODE.get(snap.live_stage, 7)
            active = cur < 7 and not (snap.active and snap.active.status == "error")
            if active:
                self._dash = (self._dash + 1) % 12
                self.cv.itemconfigure(self.seg_items[cur], dash=(7, 5), dashoffset=-self._dash)
                self._dot_t = (self._dot_t + 0.03) % 1.0
                x1, y1 = self.centers[cur]
                x2, y2 = self.centers[cur + 1]
                x = x1 + (x2 - x1) * self._dot_t
                y = y1 + (y2 - y1) * self._dot_t
                self.cv.coords(self.dot, x - 6, y - 6, x + 6, y + 6)
                self.cv.itemconfigure(self.dot, state="normal")
            else:
                self.cv.itemconfigure(self.dot, state="hidden")

            # live elapsed readout
            a = snap.active
            if a and a.created and a.status in ("queued", "processing"):
                self.elapsed_lbl.config(text=f"elapsed {time.time() - a.created:5.0f}s")
            elif snap.device_state in ("recording", "uploading"):
                self.elapsed_lbl.config(text=snap.device_state + "…")
            else:
                self.elapsed_lbl.config(text="")

        self.win.after(70, self._tick)

    def _close(self):
        self._closed = True
        self.win.destroy()


def open_pipeline(root, *, token, serial, device_id, base_url, anon_key):
    """Debugger entry point: open the live view pre-authenticated."""
    return PipelineView(root, token, serial, device_id, base_url, anon_key)


def main() -> int:
    import tomllib
    from pathlib import Path

    from hwtest import sate_account as A
    cfgp = Path(__file__).resolve().parent / "config.toml"
    cfg = tomllib.loads(cfgp.read_text()) if cfgp.exists() else {}
    acc = cfg.get("account", {})
    srv = cfg.get("server", {})
    if not (acc.get("email") and acc.get("password")):
        print("config.toml needs [account] email/password")
        return 2
    tok = A.login(acc["email"], acc["password"])
    root = tk.Tk()
    PipelineView(root, tok, str(srv.get("device_serial", "")),
                 str(srv.get("device_id", "")), str(srv.get("base_url", "")),
                 A.ANON_KEY, own_root=True)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
