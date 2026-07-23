#!/usr/bin/env python3
"""SATE hardware test — desktop dashboard.

A local web control panel (stdlib only, no Tkinter/Electron needed): run the
scenarios, watch the device's serial log live, and answer bench prompts ("press
RECORD", "cut power") with a button instead of the terminal.

    python3 dashboard.py --config config.toml     # real hardware
    python3 dashboard.py                           # sim-only (no board)

Then open http://127.0.0.1:8765 (it also opens automatically).
"""
from __future__ import annotations

import argparse
import json
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hwtest.runner import run  # noqa: E402
from hwtest.scenarios import ALL  # noqa: E402


class Job:
    def __init__(self):
        self.lock = threading.Lock()
        self.log: list[str] = []
        self.running = False
        self.done = False
        self.results: list[dict] = []
        self.pending_prompt: str | None = None
        self._ack = threading.Event()

    def log_fn(self, line: str) -> None:
        with self.lock:
            self.log.append(line)

    def prompt_fn(self, message: str) -> None:
        with self.lock:
            self.pending_prompt = message
            self._ack.clear()
        self._ack.wait()  # block the scenario until the operator clicks Done
        with self.lock:
            self.pending_prompt = None

    def ack(self) -> None:
        self._ack.set()

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "running": self.running, "done": self.done,
                "log": self.log[-400:], "pending_prompt": self.pending_prompt,
                "results": self.results,
            }

    def start(self, cfg: dict, keys, sim: bool) -> None:
        with self.lock:
            if self.running:
                return
            self.running, self.done = True, False
            self.log, self.results = [], []

        def target():
            try:
                res = run(cfg, keys, sim=sim, log=self.log_fn,
                          color=False, prompt_fn=self.prompt_fn)
                results = [{"title": r.title, "status": r.status,
                            "detail": r.detail, "bug": r.bug} for r in res]
            except Exception as e:  # pragma: no cover
                self.log_fn(f"[harness error] {type(e).__name__}: {e}")
                results = []
            with self.lock:
                self.results = results
                self.running, self.done = False, True

        threading.Thread(target=target, daemon=True).start()


JOB = Job()
CFG: dict = {}

PAGE = """<!doctype html><html><head><meta charset=utf-8>
<title>SATE hardware test</title><style>
:root{color-scheme:dark}body{margin:0;font:14px/1.5 ui-monospace,Menlo,monospace;
background:#0f1417;color:#e7eeea}header{padding:16px 22px;border-bottom:1px solid #26302f}
h1{font-size:16px;margin:0;letter-spacing:.02em}main{display:grid;grid-template-columns:300px 1fr;gap:0;height:calc(100vh - 54px)}
.side{border-right:1px solid #26302f;padding:16px;overflow:auto}.log{padding:12px 16px;overflow:auto;background:#0b0f11;white-space:pre-wrap}
label{display:block;margin:6px 0;font-size:12.5px}button{font:inherit;background:#16211d;color:#e7eeea;border:1px solid #2b5;border-radius:8px;padding:8px 12px;cursor:pointer;margin:6px 4px 6px 0}
button.sec{border-color:#3a4}button:disabled{opacity:.4;cursor:default}
.line{font-size:12px}.PASS{color:#5cc183}.FAIL{color:#e8695b}.SKIP{color:#e0a23c}.ERROR{color:#a395c9}
#prompt{display:none;background:#3a2e12;border:1px solid #e0a23c;border-radius:8px;padding:10px 14px;margin:6px 0}
.res{border-top:1px solid #26302f;margin-top:12px;padding-top:8px}.res div{font-size:12px;margin:3px 0}
small{color:#74838a}</style></head><body>
<header><h1>🩺 SATE hardware-in-the-loop test</h1></header><main>
<div class=side>
<div id=scen></div>
<div><button onclick=runSel(true)>Run (sim)</button><button class=sec onclick=runSel(false)>Run (hardware)</button></div>
<div id=prompt><b>Bench step</b><br><span id=pmsg></span><br><button onclick=ack()>Done ▸</button></div>
<div class=res id=res></div>
</div>
<div class=log id=log></div></main>
<script>
let scen=%SCEN%;
let el=document.getElementById('scen');
scen.forEach(s=>{el.innerHTML+=`<label><input type=checkbox checked value="${s.key}"> ${s.title}<br><small>${s.bug}</small></label>`});
function sel(){return [...document.querySelectorAll('#scen input:checked')].map(i=>i.value)}
async function runSel(sim){await fetch('/api/run',{method:'POST',body:JSON.stringify({only:sel(),sim})});}
async function ack(){await fetch('/api/ack',{method:'POST'});}
function poll(){fetch('/api/state').then(r=>r.json()).then(s=>{
 document.getElementById('log').innerText=s.log.join('\\n');
 document.getElementById('log').scrollTop=1e9;
 let p=document.getElementById('prompt');
 if(s.pending_prompt){p.style.display='block';document.getElementById('pmsg').innerText=s.pending_prompt;}else{p.style.display='none';}
 let r=document.getElementById('res');r.innerHTML=s.results.map(x=>`<div><span class=${x.status}>${x.status}</span> ${x.title}<br><small>${x.detail}</small></div>`).join('');
});}
setInterval(poll,400);poll();
</script></body></html>"""


class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):  # silence access logs
        pass

    def do_GET(self):
        if self.path == "/":
            scen = json.dumps([{"key": s.key, "title": s.title, "bug": s.bug} for s in ALL])
            self._send(200, PAGE.replace("%SCEN%", scen), "text/html; charset=utf-8")
        elif self.path == "/api/state":
            self._send(200, json.dumps(JOB.snapshot()))
        else:
            self._send(404, "{}")

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(n) if n else b"{}"
        if self.path == "/api/run":
            data = json.loads(raw or b"{}")
            JOB.start(CFG, data.get("only") or None, bool(data.get("sim", True)))
            self._send(200, "{\"ok\":true}")
        elif self.path == "/api/ack":
            JOB.ack()
            self._send(200, "{\"ok\":true}")
        else:
            self._send(404, "{}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", "-c")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    global CFG
    if args.config:
        import tomllib
        with open(args.config, "rb") as f:
            CFG = tomllib.load(f)
    url = f"http://127.0.0.1:{args.port}"
    print(f"SATE hardware test dashboard → {url}  (Ctrl-C to stop)")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    ThreadingHTTPServer(("127.0.0.1", args.port), H).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
