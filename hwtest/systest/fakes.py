"""Fake Supabase / Storage / AI / finalize, so cf-processor's REAL retry logic can be
driven against scripted faults.

The processor module (`cf-processor/app/processor.py`) talks to four things over HTTP:
Supabase RPC (the job state machine), Storage (download the WAV, upload the recording),
the AI service, and the finalize-session edge. This server impersonates all four and
records every call, so a test can say "the AI 500s once, then succeeds" and then assert
what the state machine actually did — attempts, retries, terminal status, and whether the
device audio was ever dropped.

Nothing here talks to production.
"""
from __future__ import annotations

import io
import json
import struct
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def make_wav(seconds: float, rate: int = 16000, tone: bool = False) -> bytes:
    """A real, parseable WAV — processor._wav_seconds() must be able to read it."""
    n = max(0, int(seconds * rate))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        if tone:
            import math
            frames = b"".join(
                struct.pack("<h", int(8000 * math.sin(2 * math.pi * 220 * i / rate)))
                for i in range(n)
            )
        else:
            frames = b"\x00\x00" * n
        w.writeframes(frames)
    return buf.getvalue()


def transcript(text: str = "session forty two begins now"):
    words = [{"word": w, "start": i * 0.3, "end": i * 0.3 + 0.25} for i, w in enumerate(text.split())]
    return {"segments": [{"start": 0.0, "end": 3.0, "text": text, "words": words}], "language": "en"}


EMPTY_TRANSCRIPT = {"segments": [{"start": 0.0, "end": 3.0, "text": "   ", "words": []}]}


class Plan:
    """What the fakes should do, and what they saw."""

    def __init__(self, wav: bytes, ai_script, finalize_script=None, storage_script=None):
        self.wav = wav
        self.ai_script = list(ai_script)
        self.finalize_script = list(finalize_script or [])
        self.storage_script = list(storage_script or [])
        self.lock = threading.Lock()
        # job state machine — mirrors sate_device_sessions
        self.session = {
            "id": "s-faketest", "user_id": "u-1", "device_serial": "SATE-TEST01",
            "session_number": 7, "bytes": len(wav), "storage_path": "u-1/SATE-TEST01/s-faketest.wav",
            "status": "queued", "attempts": 0, "process_error": None,
            "no_text": False, "recording_id": None,
        }
        self.calls = {"ai": 0, "finalize": 0, "rec_upload": 0, "download": 0,
                      "requeue": 0, "fail": 0, "claim": 0}
        self.finalize_payloads = []
        self.audio_deleted = False
        self.recordings_created = 0
        self.events = []

    def log(self, what):
        self.events.append(f"{time.time():.3f} {what}")

    def settled(self):
        return self.session["status"] in ("done", "error")

    def _next(self, script, default):
        if not script:
            return default
        return script.pop(0) if len(script) > 1 else script[0]


class _H(BaseHTTPRequestHandler):
    plan: Plan = None  # set on the server class

    def log_message(self, *a):
        pass

    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj).encode())

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    # ---- Storage ----------------------------------------------------------
    def do_GET(self):
        p = self.plan
        if self.path.startswith("/storage/v1/object/device-sessions/"):
            with p.lock:
                p.calls["download"] += 1
                if p.audio_deleted:
                    p.log("download AFTER audio deleted — data loss!")
                    return self._json(404, {"message": "Object not found"})
                d = p._next(p.storage_script, {"status": 200})
            if d.get("status", 200) != 200:
                return self._json(d["status"], {"message": "storage fault"})
            return self._send(200, p.wav, "audio/wav")
        self._json(404, {"message": "no route"})

    def do_POST(self):
        p = self.plan
        body = self._body()
        path = self.path

        # ---- Supabase RPC (the job state machine) -------------------------
        if path.startswith("/rest/v1/rpc/"):
            fn = path.rsplit("/", 1)[-1]
            with p.lock:
                s = p.session
                if fn == "claim_next_session":
                    p.calls["claim"] += 1
                    if s["status"] != "queued":
                        return self._json(200, None)
                    s["status"] = "processing"
                    s["attempts"] += 1
                    p.log(f"claim -> attempt {s['attempts']}")
                    return self._json(200, dict(s))
                if fn == "requeue_session":
                    p.calls["requeue"] += 1
                    s["status"] = "queued"
                    p.log("requeue")
                    return self._json(200, None)
                if fn == "fail_session":
                    p.calls["fail"] += 1
                    s["status"] = "error"
                    try:
                        s["process_error"] = json.loads(body or b"{}").get("p_msg")
                    except Exception:
                        pass
                    p.log(f"fail: {s['process_error']}")
                    return self._json(200, None)
                if fn == "requeue_stale_sessions":
                    return self._json(200, None)
            return self._json(404, {"message": "no rpc"})

        # ---- recordings bucket upload ------------------------------------
        if path.startswith("/storage/v1/object/recordings/"):
            with p.lock:
                p.calls["rec_upload"] += 1
                p.log("recordings upload")
            return self._json(200, {"Key": path})

        # ---- AI service ---------------------------------------------------
        if path.startswith("/ai"):
            with p.lock:
                p.calls["ai"] += 1
                d = p._next(p.ai_script, {"json": transcript()})
                p.log(f"AI call {p.calls['ai']} -> {list(d)}")
            if "sleep" in d:
                time.sleep(d["sleep"])
            if d.get("status", 200) != 200:
                return self._json(d["status"], {"error": "ai fault"})
            if "raw" in d:
                return self._send(200, d["raw"].encode())
            return self._json(200, d.get("json") or {})

        # ---- finalize-session edge ---------------------------------------
        if path.startswith("/finalize"):
            with p.lock:
                p.calls["finalize"] += 1
                try:
                    payload = json.loads(body or b"{}")
                except Exception:
                    payload = {}
                p.finalize_payloads.append(payload)
                d = p._next(p.finalize_script, {"status": 200})
                p.log(f"finalize {p.calls['finalize']} no_text={payload.get('no_text')} -> {d}")
                s = p.session
                if d.get("status", 200) != 200:
                    # "apply" = the write LANDED but the response was lost. This is the
                    # out-of-order/late case: the worker will retry a job the server
                    # already finalized.
                    if d.get("apply") and s["status"] != "done":
                        p.recordings_created += 1
                        s["status"] = "done"
                        s["recording_id"] = f"rec-{p.recordings_created}"
                        p.log("finalize applied server-side, then answered "
                              f"{d['status']} — response lost")
                    return self._json(d["status"], {"error": "finalize fault"})
                # Mirrors the DEPLOYED finalize-session edge fn, verified from source:
                #   1. status=='done'        -> already_done   (no write)
                #   2. no_text               -> done, no recording
                #   3. recording_id present  -> already_linked (no second insert)
                #   4. otherwise             -> insert recording, set done
                if s["status"] == "done":
                    p.log("LATE/DUPLICATE finalize on an already-done session -> already_done")
                    return self._json(200, {"status": "already_done",
                                            "recording_id": s["recording_id"]})
                if payload.get("no_text"):
                    s["status"] = "done"; s["no_text"] = True; s["recording_id"] = None
                    return self._json(200, {"status": "no_text"})
                if s["recording_id"]:
                    s["status"] = "done"
                    p.log("LATE/DUPLICATE finalize -> already_linked, no second recording")
                    return self._json(200, {"status": "already_linked",
                                            "recording_id": s["recording_id"]})
                p.recordings_created += 1
                s["status"] = "done"
                s["recording_id"] = f"rec-{p.recordings_created}"
                return self._json(200, {"recording_id": s["recording_id"]})

        self._json(404, {"message": "no route"})


def start(plan: Plan):
    _H.plan = plan
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _H)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"
