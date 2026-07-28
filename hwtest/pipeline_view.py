"""Live audio-pipeline map — the real system architecture, animated.

Drawn to match the SATE architecture diagram (and the truth of the code):

  Recorder ──Wi-Fi──▶ ┌────────── Supabase ──────────┐   claim    ┌──────────┐
  Pendant ┐           │  device-api · Edge Function   │ ─────────▶ │Cloudflare│──▶ AI
  Plaud   ┴─BLE─▶ app │  Storage · WAV object         │            │processor │◀── /process
                      │  Postgres · row + queue       │ ◀──────────└──────────┘
                      └───────────────┬───────────────┘   finalize-session
                                      ▼ reads
                                 Web frontend

Everything shown is SERVER truth, never inferred from the bench being idle:

* the flow lights up ONLY for a take that provably exists — the device heartbeat
  says recording/uploading, or a session row exists on the server;
* upload progress is the REAL byte count of the in-flight chunk parts
  (device-api ≥v16 `/sessions/upload-progress` sums the `_tmp` objects);
* the session being processed is named on the map (s31 · demo · 0.35 MB);
* each tier carries a health dot from live probes (`pipeline.probe_tiers`);
* when nothing is in flight the map is neutral — idle never fakes green.

The tester sets the record duration ("45", "1:30", "5m"/"5p"); the test records
exactly that long, and when the row lands the actual audio length
((bytes-44)/32000 for 16-kHz mono S16LE) is checked against the target.

Standalone: `python3 pipeline_view.py` / `sate pipeline`. From the Debugger:
open_pipeline() (pre-authenticated).
"""
from __future__ import annotations

import queue
import threading
import time
import tkinter as tk

from hwtest import pipeline as P

# ---- palette (debugger.py + the architecture diagram) ----
BG = "#eef1f5"
CARD = "#ffffff"
INK = "#16202e"
INK2 = "#7c8698"
ACCENT = "#2563eb"
HAIR = "#e3e7ec"
OKC = "#15803d"
WARNC = "#b45309"
BADC = "#b91c1c"
SUPA = "#3ecf8e"          # Supabase green
SUPA_BG = "#eefaf4"
SUPA_BOX = "#2f9e6e"
CF_ORANGE = "#f6821f"
AI_INK = "#1e2a44"
DIM = "#c6cdd6"
RECC = "#dc2626"

PCM_BPS = 32000.0          # 16 kHz mono S16LE — bytes per second of audio

CW, CH = 1150, 600


def _fmt_s(v):
    if v is None:
        return "—"
    if v >= 90:
        return f"{int(v // 60)}m{int(v % 60):02d}s"
    return f"{v:.0f}s" if v >= 9.5 else f"{v:.1f}s"


def _fmt_mb(b):
    return f"{b / 1e6:.2f} MB"


class PipelineView:
    POLL_S = 2.0
    DONE_BANNER_S = 12.0

    def __init__(self, root: tk.Misc, token: str, serial: str, device_id: str,
                 base_url: str, anon_key: str, *, own_root: bool = False):
        self.token, self.serial = token, serial
        self.device_id, self.base_url, self.anon = device_id, base_url, anon_key
        self.q: "queue.Queue[tuple]" = queue.Queue()
        self.snap: P.Snapshot | None = None
        self.infra: dict = {}
        self.upprog: dict | None = None
        self._up_hist: list = []          # (wall, bytes) for the rate
        self.testing = False
        self._closed = False
        self._dash = 0
        self._dot_t = 0.0
        self._rec_started = None          # wall when we first saw 'recording'
        self._expect_new = False          # a new row MUST land (we saw the take)
        self._expect_started = 0.0
        self._gap_started = None          # wall when the device went idle pre-row —
                                          # the give-up budget runs from HERE, not
                                          # from record start (a 6-min take is fine)
        self._poll_err = None             # (wall, msg) — surfaced, never painted over
        self._snap_at = 0.0               # wall of the last GOOD snapshot
        self._msg_until = 0.0             # sticky user message (e.g. bad duration)
        self._baseline = None             # newest row created-ts before the take
        self._last_done = None            # (SessionState, wall) — brief banner
        self._target_s = None             # tester-set duration for this test

        w = root if own_root else tk.Toplevel(root)
        self.win = w
        w.title(f"SATE — Audio pipeline · {serial}")
        w.configure(bg=BG)
        w.protocol("WM_DELETE_WINDOW", self._close)

        head = tk.Frame(w, bg=BG)
        head.pack(fill="x", padx=16, pady=(12, 4))
        tk.Label(head, text="AUDIO PIPELINE — LIVE", bg=BG, fg=INK,
                 font=("Helvetica Neue", 15, "bold")).pack(side="left")
        self.dev_lbl = tk.Label(head, text=f"{serial} · …", bg=BG, fg=INK2, font=("Menlo", 11))
        self.dev_lbl.pack(side="right")

        wrap = tk.Frame(w, bg=CARD, highlightbackground=HAIR, highlightthickness=1)
        wrap.pack(padx=16, pady=4)
        self.cv = tk.Canvas(wrap, width=CW, height=CH, bg=CARD, highlightthickness=0)
        self.cv.pack(padx=6, pady=6)
        self._build_map()

        act = tk.Frame(w, bg=CARD, highlightbackground=HAIR, highlightthickness=1)
        act.pack(fill="x", padx=16, pady=(4, 0))
        self.active_lbl = tk.Label(act, text="no take in flight", bg=CARD, fg=INK2,
                                   font=("Menlo", 11), anchor="w")
        self.active_lbl.pack(side="left", padx=12, pady=7)
        self.elapsed_lbl = tk.Label(act, text="", bg=CARD, fg=ACCENT, font=("Menlo", 11, "bold"))
        self.elapsed_lbl.pack(side="right", padx=12)

        hist = tk.Frame(w, bg=CARD, highlightbackground=HAIR, highlightthickness=1)
        hist.pack(fill="both", expand=True, padx=16, pady=(6, 4))
        tk.Label(hist, text="PAST RUNS · session — patient — size — audio-length — queue — processing — total",
                 bg=CARD, fg=INK2, font=("Menlo", 10, "bold"), anchor="w").pack(fill="x", padx=12, pady=(6, 0))
        self.hist_box = tk.Text(hist, bg=CARD, fg=INK, font=("Menlo", 11), height=7,
                                relief="flat", state="disabled", padx=12, pady=4)
        self.hist_box.pack(fill="both", expand=True)
        for tag, col in [("ok", OKC), ("bad", BADC), ("dim", INK2), ("avg", ACCENT), ("warn", WARNC)]:
            self.hist_box.tag_config(tag, foreground=col)

        bar = tk.Frame(w, bg=BG)
        bar.pack(fill="x", padx=16, pady=(2, 12))
        # A Label, not a Button: on macOS a native tk.Button ignores `bg`, so the
        # blue fill was dropped and white text landed on the light system button
        # (white-on-white). A Label honours bg, so the button stays readable.
        self._test_enabled = True
        self.test_btn = tk.Label(bar, text="▶  Run pipeline test", bg=ACCENT, fg="white",
                                 cursor="hand2", font=("Helvetica Neue", 12, "bold"), padx=16, pady=7)
        self.test_btn.pack(side="left")
        self.test_btn.bind("<Button-1>", lambda e: self._run_test() if self._test_enabled else None)
        self.test_btn.bind("<Enter>", lambda e: self.test_btn.config(bg="#1d4ed8") if self._test_enabled else None)
        self.test_btn.bind("<Leave>", lambda e: self.test_btn.config(bg=ACCENT) if self._test_enabled else None)
        tk.Label(bar, text="  record for", bg=BG, fg=INK2, font=("Menlo", 10)).pack(side="left", padx=(10, 4))
        self.dur_var = tk.StringVar(value="0:30")
        tk.Entry(bar, textvariable=self.dur_var, width=7, font=("Menlo", 12), justify="center",
                 relief="flat", highlightthickness=1, highlightbackground=HAIR,
                 highlightcolor=ACCENT).pack(side="left")
        tk.Label(bar, text='("45" · "1:30" · "5m"/"5p") — the recorder records exactly this long',
                 bg=BG, fg=INK2, font=("Menlo", 9)).pack(side="left", padx=(6, 0))
        tk.Label(bar, text="server rows + tier health · 2 s", bg=BG, fg=INK2,
                 font=("Menlo", 9)).pack(side="right")

        threading.Thread(target=self._poll_loop, daemon=True).start()
        self._tick()

    # ================================================================ the map
    def _rrect(self, x1, y1, x2, y2, r=12, **kw):
        pts = (x1 + r, y1, x2 - r, y1, x2, y1, x2, y1 + r, x2, y2 - r, x2, y2,
               x2 - r, y2, x1 + r, y2, x1, y2, x1, y2 - r, x1, y1 + r, x1, y1)
        return self.cv.create_polygon(pts, smooth=True, **kw)

    def _build_map(self):
        cv = self.cv
        self.nodes = {}     # key -> dict(shape items, label item, sub item, kind)

        def box(key, x1, y1, x2, y2, title, sub, *, fill=CARD, outline=DIM, dim=False, r=12):
            body = self._rrect(x1, y1, x2, y2, r=r, fill=fill, outline=outline, width=2)
            t = cv.create_text((x1 + x2) / 2, y1 + 20, text=title, fill=(INK2 if dim else INK),
                               font=("Helvetica Neue", 12, "bold"))
            sb = cv.create_text((x1 + x2) / 2, (y1 + y2) / 2 + 12, text=sub, fill=INK2,
                                font=("Menlo", 8), width=x2 - x1 - 18)
            self.nodes[key] = {"body": body, "title": t, "sub": sb, "base_outline": outline,
                               "cx": (x1 + x2) / 2, "cy": (y1 + y2) / 2, "box": (x1, y1, x2, y2)}
            return self.nodes[key]

        def circle(key, cx, cy, rr, title, sub, *, outline=DIM, dim=False):
            body = cv.create_oval(cx - rr, cy - rr, cx + rr, cy + rr, fill=CARD,
                                  outline=outline, width=3)
            # no width= on the title: it is pre-broken with \n — Tk re-wrapping it
            # is what produced "fronten\nd"
            t = cv.create_text(cx, cy - 2, text=title, fill=(INK2 if dim else INK),
                               font=("Helvetica Neue", 11, "bold"), justify="center")
            sb = cv.create_text(cx, cy + rr + 12, text=sub, fill=INK2, font=("Menlo", 8),
                                width=rr * 2 + 56, justify="center")
            self.nodes[key] = {"body": body, "title": t, "sub": sb, "base_outline": outline,
                               "cx": cx, "cy": cy, "box": (cx - rr, cy - rr, cx + rr, cy + rr)}
            return self.nodes[key]

        # --- Supabase container ---
        self._rrect(430, 34, 720, 428, r=18, fill=SUPA_BG, outline=SUPA, width=2)
        cv.create_text(575, 54, text="Supabase", fill="#1f9d64",
                       font=("Helvetica Neue", 14, "bold"))
        box("api", 455, 72, 695, 136, "device-api", "Edge Function · ingest + finalize",
            fill="#ffffff", outline=SUPA_BOX)
        box("storage", 455, 176, 695, 240, "Storage", "WAV objects · device-sessions",
            fill="#ffffff", outline=SUPA_BOX)
        box("db", 455, 280, 695, 344, "Postgres", "session rows · status queue",
            fill="#ffffff", outline=SUPA_BOX)
        cv.create_text(575, 408, text="RLS · the same rows the web app reads",
                       fill="#57a17f", font=("Menlo", 8))

        # --- devices (left) ---
        box("recorder", 28, 58, 214, 150, "SATE Recorder", "ESP32-S3 · SD + Wi-Fi")
        self.rec_chip = cv.create_text(121, 128, text="● idle", fill=INK2, font=("Menlo", 10, "bold"))
        box("pendant", 28, 262, 160, 316, "Pendant", "BLE · via mobile app", dim=True)
        box("plaud", 28, 348, 160, 402, "Plaud", "BLE SDK · via mobile app", dim=True)
        circle("mobile", 300, 330, 34, "Mobile\napp", "bridges BLE devices", dim=True)

        # --- right: Cloudflare + AI ---
        circle("cf", 815, 168, 42, "Cloudflare", "cf-processor · claims queue",
               outline=CF_ORANGE)
        circle("ai", 1045, 168, 42, "AI\n/process", "CUDA · transcribe",
               outline=AI_INK)
        cv.create_text(930, 262, text="retry ≤3 on 5xx · read ceiling 1 h · watchdog 45 m",
                       fill=INK2, font=("Menlo", 8))

        # --- bottom: web ---
        circle("web", 575, 512, 36, "Web\nfrontend", "clinician report")

        # --- edges ---
        self.edges = {}

        def edge(key, pts, label=None, lx=0, ly=0, *, dim=False, arrow="last"):
            line = cv.create_line(*pts, width=2.6 if not dim else 1.6,
                                  fill=DIM, dash=(6, 5), arrow=arrow,
                                  arrowshape=(11, 13, 5), smooth=len(pts) > 4)
            items = {"line": line, "pts": pts, "dim": dim}
            if label:
                items["label"] = cv.create_text(lx, ly, text=label, fill=INK2, font=("Menlo", 8))
            self.edges[key] = items
            return items

        edge("upload", (214, 100, 455, 100), "Wi-Fi · chunked HTTPS", 332, 86)
        self.up_prog_txt = cv.create_text(332, 114, text="", fill=ACCENT, font=("Menlo", 9, "bold"))
        edge("store", (575, 136, 575, 176), "WAV parts", 632, 156)
        edge("row", (575, 240, 575, 280), "row · queued", 645, 260)
        edge("claim", (695, 300, 786, 194), "claim (SKIP LOCKED)", 780, 316)
        edge("toai", (857, 152, 1003, 152), "audio (wait)", 930, 138)
        edge("fromai", (1003, 184, 857, 184), "transcript JSON", 930, 200)
        edge("fin", (779, 138, 695, 106), "finalize-session · mark done", 800, 96)
        edge("webread", (575, 344, 575, 474), "reads", 598, 452, dim=True)
        edge("ble1", (160, 289, 268, 318), dim=True)
        edge("ble2", (160, 375, 268, 342), dim=True)
        edge("blein", (330, 312, 455, 128), dim=True)

        # travelling dot
        self.dot = cv.create_oval(0, 0, 0, 0, fill=ACCENT, outline="")

        # --- tier-health dots ---
        self.tier_of_node = {"recorder": "recorder", "api": "api", "storage": "storage",
                             "db": "db", "cf": "worker", "ai": "ai"}
        self.health_dots = {}
        for nk in self.tier_of_node:
            n = self.nodes[nk]
            x2, y1 = n["box"][2], n["box"][1]
            self.health_dots[nk] = cv.create_oval(x2 - 16, y1 + 6, x2 - 6, y1 + 16,
                                                  fill=INK2, outline=CARD, width=1)
        cv.create_text(20, CH - 12, anchor="w", fill=INK2, font=("Menlo", 8),
                       text="corner dot = tier health, probed live · green up · amber degraded · red down")

    # ================================================================ data
    def _poll_loop(self):
        n = 0
        while not self._closed:
            try:
                snap = P.snapshot(self.token, self.serial)
                self.q.put(("snap", snap))
                # real upload progress — only meaningful while a take is in flight
                if snap.device_state == "uploading" or (self._expect_new and snap.device_state == "idle"):
                    try:
                        self.q.put(("upprog", P.upload_progress(self.token, self.base_url, self.serial)))
                    except Exception:  # noqa: BLE001
                        pass
            except Exception as e:  # noqa: BLE001
                self.q.put(("err", str(e)))
            if n % 6 == 0:
                try:
                    self.q.put(("infra", P.probe_tiers(self.token, self.base_url, self.serial)))
                except Exception:  # noqa: BLE001
                    pass
            n += 1
            time.sleep(self.POLL_S)

    @staticmethod
    def parse_duration(text):
        '''"45" → 45 s · "1:30" → 90 · "5m"/"5p" (phút) → 300.'''
        t = (text or "").strip().lower().replace(" ", "")
        if not t:
            raise ValueError("empty")
        if ":" in t:
            m, sec = t.split(":", 1)
            return int(m) * 60 + int(sec or 0)
        if t.endswith(("m", "p")):
            return int(float(t[:-1]) * 60)
        if t.endswith("s"):
            t = t[:-1]
        return int(float(t))

    def _say(self, msg, secs=4.0):
        """A user message that survives repaints (the strip is rewritten every tick)."""
        self._msg_until = time.time() + secs
        self.active_lbl.config(text=msg, fg=BADC)

    def _run_test(self):
        if self.testing:
            return
        try:
            dur = self.parse_duration(self.dur_var.get())
        except Exception:  # noqa: BLE001
            self._say('bad duration — use "45", "1:30" or "5m"')
            return
        if not 3 <= dur <= 3600:
            self._say("duration must be 3 s … 60 min")
            return
        self.testing = True
        self._target_s = dur
        self._test_enabled = False
        self.test_btn.config(bg="#6f97e6", cursor="arrow", text=f"▶  recording {_fmt_s(dur)} — watch the map…")

        def work():
            import json
            import urllib.request
            try:
                def cmd(body):
                    req = urllib.request.Request(
                        f"{self.base_url}/api/devices/{self.device_id}/commands",
                        data=json.dumps(body).encode(), method="POST",
                        headers={"Authorization": f"Bearer {self.token}", "apikey": self.anon,
                                 "Content-Type": "application/json"})
                    with urllib.request.urlopen(req, timeout=20):
                        pass
                # fw >=1.5.19: the device stops ITSELF at exactly `dur` seconds of
                # PCM — no stop race, sample-exact duration. The stop below is only
                # a safety net for older firmware / a wedged take.
                cmd({"op": "record", "seconds": dur})
                t0 = time.time()
                deadline = t0 + 40 + dur + 60
                started = False
                while time.time() < deadline:
                    try:
                        st = P.snapshot(self.token, self.serial).device_state
                        if st == "recording":
                            started = True
                        elif started and st != "recording":
                            break
                    except Exception:  # noqa: BLE001
                        pass
                    time.sleep(3)
                else:
                    cmd({"op": "stop"})
            except Exception as e:  # noqa: BLE001
                self.q.put(("err", f"pipeline test: {e}"))
            finally:
                self.q.put(("test_done", None))
        threading.Thread(target=work, daemon=True).start()

    # ================================================================ state
    def _flow(self):
        """(mode, take) — mode: idle|record|upload|queued|ai|done|error.

        Server-truth state machine: green never appears without a take to prove
        it, and the upload gap (device idle, row not landed yet) stays 'upload'.
        """
        snap = self.snap
        now = time.time()
        if snap is None:
            return "idle", None
        if snap.device_state == "recording":
            if self._rec_started is None:
                self._rec_started = now
                if not self._expect_new:   # keep the OLDER baseline if a previous
                    self._expect_new = True    # take's row hasn't landed yet
                    self._baseline = snap.history[0].created if snap.history else 0.0
                self._expect_started = now
            self._gap_started = None
            return "record", None
        self._rec_started = None
        if snap.device_state == "uploading":
            if not self._expect_new:      # take started outside this window
                self._expect_new = True
                self._expect_started = now
                self._baseline = snap.history[0].created if snap.history else 0.0
            self._gap_started = None
            return "upload", None
        new_row = None
        if self._expect_new:
            new_row = next((x for x in snap.history
                            if (x.created or 0) > (self._baseline or 0)), None)
            if new_row is None:
                # the gap: device done, row not landed. The give-up budget starts
                # HERE — measuring from record start wrongly zeroed out any take
                # longer than the budget itself.
                if self._gap_started is None:
                    self._gap_started = now
                if now - self._gap_started > 300:
                    self._expect_new = False
                    self._gap_started = None
                    return "idle", None
                return "upload", None
        # a finished take banners FIRST — a stale wedged row must not swallow it
        if new_row and new_row.status in ("done", "error"):
            self._expect_new = False
            self._gap_started = None
            self._last_done = (new_row, now)
        active = snap.active or (new_row if new_row and new_row.status in ("queued", "processing") else None)
        if self._last_done and now - self._last_done[1] < self.DONE_BANNER_S:
            row = self._last_done[0]
            return ("error" if row.status == "error" else "done"), row
        if self._last_done and now - self._last_done[1] >= self.DONE_BANNER_S:
            self._last_done = None
            self._target_s = None          # the verified target belongs to that take
        if active:
            return ("queued" if active.stage == "queued" else "ai"), active
        return "idle", None

    # ================================================================ draw
    FLOW_EDGES = ["upload", "store", "row", "claim", "toai", "fromai", "fin"]
    MODE_EDGE = {"record": None, "upload": "upload", "queued": None, "ai": "toai", "done": None}
    # how far along the chain each mode has PROVEN progress
    MODE_REACH = {"idle": -1, "record": -1, "upload": 0, "queued": 2, "ai": 4, "done": 6, "error": 4}

    def _paint(self, mode, take):
        cv = self.cv
        now = time.time()
        reach = self.MODE_REACH.get(mode, -1)
        if mode in ("done",):
            reach = len(self.FLOW_EDGES) - 1

        for i, ek in enumerate(self.FLOW_EDGES):
            e = self.edges[ek]
            if mode == "done" or i < reach or (mode == "ai" and ek in ("claim",)):
                cv.itemconfigure(e["line"], fill=OKC, dash=())
            elif mode == "ai" and ek in ("toai", "fromai"):
                cv.itemconfigure(e["line"], fill=CF_ORANGE)     # animated in _tick
            elif mode == "upload" and ek == "upload":
                cv.itemconfigure(e["line"], fill=ACCENT)
            else:
                cv.itemconfigure(e["line"], fill=DIM, dash=(6, 5))

        hl = {"record": ["recorder"], "upload": ["recorder", "api", "storage"],
              "queued": ["db"], "ai": ["cf", "ai"], "done": [], "error": ["cf", "ai"]}.get(mode, [])
        greens = {"upload": ["recorder"], "queued": ["recorder", "api", "storage"],
                  "ai": ["recorder", "api", "storage", "db"],
                  "done": ["recorder", "api", "storage", "db", "cf", "ai", "web"]}.get(mode, [])
        for nk in ("recorder", "api", "storage", "db", "cf", "ai", "web"):
            n = self.nodes[nk]
            if mode == "error" and nk in hl:
                cv.itemconfigure(n["body"], outline=BADC)
            elif nk in hl:
                cv.itemconfigure(n["body"], outline=ACCENT)
            elif nk in greens:
                cv.itemconfigure(n["body"], outline=OKC)
            else:
                cv.itemconfigure(n["body"], outline=n["base_outline"])

        # recorder chip + live sublabels
        st = self.snap.device_state if self.snap else "?"
        if mode == "record":
            dur = now - (self._rec_started or now)
            tgt = f" / {_fmt_s(self._target_s)}" if self._target_s else ""
            cv.itemconfigure(self.rec_chip, text=f"● REC {_fmt_s(dur)}{tgt}", fill=RECC)
        else:
            cv.itemconfigure(self.rec_chip, text=f"● {st}",
                             fill=(OKC if st == "idle" else (WARNC if st == "offline" else ACCENT)))

        who = f"s{take.session_number} · {take.patient_id or '—'} · {_fmt_mb(take.bytes)}" if take else ""
        cv.itemconfigure(self.nodes["db"]["sub"],
                         text=(f"{who} — waiting {_fmt_s(now - take.created)}" if take and mode == "queued"
                               else "sate_device_sessions · status queue"))
        cv.itemconfigure(self.nodes["cf"]["sub"],
                         text=(f"processing {who}" if take and mode == "ai"
                               else "cf-processor container · claims the queue"))
        cv.itemconfigure(self.nodes["ai"]["sub"],
                         text=(f"in flight {_fmt_s(now - take.started)}" if take and mode == "ai" and take.started
                               else "self-hosted CUDA · transcribe + annotate"))

        # upload progress (REAL bytes from the server, v16)
        if mode == "upload" and self.upprog and self.upprog.get("uploading"):
            u = self.upprog["uploads"][0]
            rate = ""
            self._up_hist.append((now, u["bytes"]))
            self._up_hist = self._up_hist[-8:]
            if len(self._up_hist) >= 2:
                (t0, b0), (t1, b1) = self._up_hist[0], self._up_hist[-1]
                if t1 > t0 and b1 >= b0:
                    rate = f" · {(b1 - b0) / (t1 - t0) / 1e6:.1f} MB/s"
            cv.itemconfigure(self.up_prog_txt,
                             text=f"▲ s{u['session_number']} · {u['parts']} parts · {_fmt_mb(u['bytes'])} on server{rate}")
        elif mode != "upload":
            cv.itemconfigure(self.up_prog_txt, text="")
            self._up_hist = []

        # active strip (skipped while a sticky message / poll error is showing)
        if time.time() < self._msg_until:
            return
        if mode == "record":
            self.active_lbl.config(fg=RECC, text="RECORDING on the device — audio is only on the SD card so far")
        elif mode == "upload":
            self.active_lbl.config(fg=INK, text="UPLOADING — chunked HTTPS into Supabase Storage (row lands on final)")
        elif mode == "queued" and take:
            self.active_lbl.config(fg=INK, text=f"QUEUED — {who} waiting for cf-processor")
        elif mode == "ai" and take:
            self.active_lbl.config(fg=INK, text=f"PROCESSING — {who} inside cf-processor → AI")
        elif mode == "done" and take:
            extra = ""
            if self._target_s:
                audio_s = max(0.0, (take.bytes - 44) / PCM_BPS)
                okd = abs(audio_s - self._target_s) <= max(3.0, self._target_s * 0.1)
                extra = f" · audio {_fmt_s(audio_s)} vs target {_fmt_s(self._target_s)} {'✓' if okd else '⚠'}"
            self.active_lbl.config(fg=OKC, text=(
                f"DONE — {who} · queue {_fmt_s(take.queue_wait_s)} · "
                f"processing {_fmt_s(take.processing_s)} · total {_fmt_s(take.total_s)}{extra}"))
        elif mode == "error" and take:
            self.active_lbl.config(fg=BADC, text=f"ERROR — {who}: {str(take.error)[:80]}")
        else:
            self.active_lbl.config(fg=INK2, text="no take in flight — the map lights up when audio is moving")

    def _apply_infra(self):
        col = {"ok": OKC, "warn": WARNC, "down": BADC}
        for nk, tier in self.tier_of_node.items():
            v = self.infra.get(tier)
            self.cv.itemconfigure(self.health_dots[nk], fill=col.get(v, INK2))

    def _apply_history(self, snap):
        self.hist_box.config(state="normal")
        self.hist_box.delete("1.0", "end")
        done_rows = [h for h in snap.history if h.status in ("done", "error")]
        fin = [h for h in done_rows if h.processing_s]
        for h in done_rows[:7]:
            audio = _fmt_s(max(0.0, (h.bytes - 44) / PCM_BPS)) if h.bytes > 44 else "—"
            tag = "ok" if h.status == "done" else "bad"
            self.hist_box.insert(
                "end",
                f"  s{h.session_number:<4}{(h.patient_id or '—')[:10]:<11}{_fmt_mb(h.bytes):>9}   "
                f"audio {audio:>7}   q {_fmt_s(h.queue_wait_s):>6}   p {_fmt_s(h.processing_s):>6}   "
                f"t {_fmt_s(h.total_s):>6}   {h.status}\n", (tag,))
        if fin:
            n = len(fin)
            self.hist_box.insert(
                "end",
                f"  avg of {n:<3}{'':11}{'':>9}   {'':13}   q {_fmt_s(sum(h.queue_wait_s or 0 for h in fin) / n):>6}"
                f"   p {_fmt_s(sum(h.processing_s for h in fin) / n):>6}"
                f"   t {_fmt_s(sum(h.total_s or 0 for h in fin) / n):>6}\n", ("avg",))
        self.hist_box.config(state="disabled")

    # ================================================================ tick
    def _tick(self):
        if self._closed:
            return
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == "snap":
                    self.snap = payload
                    self._poll_err = None
                    self._snap_at = time.time()
                    self.dev_lbl.config(text=f"{self.serial} · {payload.device_state}")
                    self._apply_history(payload)
                elif kind == "infra":
                    self.infra = payload
                    self._apply_infra()
                elif kind == "upprog":
                    self.upprog = payload
                elif kind == "err":
                    self._poll_err = (time.time(), str(payload))
                elif kind == "test_done":
                    self.testing = False
                    self._test_enabled = True
                    self.test_btn.config(bg=ACCENT, cursor="hand2", text="▶  Run pipeline test")
        except queue.Empty:
            pass

        mode, take = self._flow()
        self._paint(mode, take)
        # a failing poll must be VISIBLE (painted after _paint so nothing covers
        # it) — and the map must admit its data is stale, not render yesterday
        now0 = time.time()
        if self._poll_err and now0 - self._snap_at > 6:
            age = now0 - self._snap_at if self._snap_at else 0
            self.active_lbl.config(
                fg=BADC, text=f"POLL FAILING — data is {age:.0f}s stale · {self._poll_err[1][:70]}")
        elif now0 < self._msg_until:
            pass  # keep the sticky user message (set with _say) on screen

        # animation: ants + dot on the segment the audio is crossing right now
        anim = {"upload": "upload", "ai": None, "record": None}.get(mode, None)
        self._dash = (self._dash + 1) % 12
        if mode == "upload":
            e = self.edges["upload"]
            self.cv.itemconfigure(e["line"], dash=(7, 5), dashoffset=-self._dash)
            self._move_dot(e["pts"], forward=True)
        elif mode == "ai":
            # ping-pong: out on 'toai', back on 'fromai'
            for ek in ("toai", "fromai"):
                self.cv.itemconfigure(self.edges[ek]["line"], dash=(7, 5), dashoffset=-self._dash)
            self._dot_t = (self._dot_t + 0.025) % 1.0
            t = self._dot_t
            pts = self.edges["toai"]["pts"] if t < 0.5 else self.edges["fromai"]["pts"]
            tt = (t * 2) if t < 0.5 else ((t - 0.5) * 2)
            x = pts[0] + (pts[2] - pts[0]) * tt
            y = pts[1] + (pts[3] - pts[1]) * tt
            self.cv.coords(self.dot, x - 5, y - 5, x + 5, y + 5)
            self.cv.itemconfigure(self.dot, state="normal", fill=CF_ORANGE)
        elif mode == "queued":
            # pulse the db outline while waiting
            on = int(time.time() * 2) % 2 == 0
            self.cv.itemconfigure(self.nodes["db"]["body"], outline=(ACCENT if on else DIM))
            self.cv.itemconfigure(self.dot, state="hidden")
        else:
            self.cv.itemconfigure(self.dot, state="hidden")
        if anim != "upload" and mode != "ai":
            pass

        # elapsed readout
        now = time.time()
        if mode == "record" and self._rec_started:
            self.elapsed_lbl.config(text=f"REC {_fmt_s(now - self._rec_started)}")
        elif mode == "upload" and self._expect_started:
            self.elapsed_lbl.config(text=f"upload {_fmt_s(now - self._expect_started)}")
        elif take and take.created and mode in ("queued", "ai"):
            self.elapsed_lbl.config(text=f"elapsed {_fmt_s(now - take.created)}")
        else:
            self.elapsed_lbl.config(text="")

        self.win.after(80, self._tick)

    def _move_dot(self, pts, forward=True):
        self._dot_t = (self._dot_t + 0.03) % 1.0
        t = self._dot_t if forward else 1.0 - self._dot_t
        x = pts[0] + (pts[2] - pts[0]) * t
        y = pts[1] + (pts[3] - pts[1]) * t
        self.cv.coords(self.dot, x - 5, y - 5, x + 5, y + 5)
        self.cv.itemconfigure(self.dot, state="normal", fill=ACCENT)

    def _close(self):
        self._closed = True
        self.win.destroy()


def open_pipeline(root, *, token, serial, device_id, base_url, anon_key):
    """Debugger entry point: open the live map pre-authenticated."""
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
