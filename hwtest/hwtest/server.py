"""device-api client — the ground truth for "did the server actually get the take?"

Uses ONLY the device key (Bearer key-...) and stdlib urllib, so no user login and
no extra deps. The core check is GET /sessions/verify, the endpoint the recorder
itself calls before freeing SD audio: it returns stored:true only when a row with
the exact (patient, session_number, bytes) exists AND its storage object is really
there. That is exactly the byte-match a pre-release test wants.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional


class BaseServer:
    def verify(self, patient_id: str, session_number: int, byte_count: int) -> bool:
        raise NotImplementedError

    def available(self) -> bool:
        return True


class DeviceApiServer(BaseServer):
    def __init__(self, base_url: str, device_key: str, device_serial: str,
                 anon_key: Optional[str] = None, timeout: float = 15.0):
        self.base = base_url.rstrip("/")
        self.key = device_key
        self.serial = device_serial
        self.anon = anon_key
        self.timeout = timeout

    def available(self) -> bool:
        return bool(self.base and self.key)

    def _get(self, path: str, params: Optional[dict] = None):
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, method="GET")
        req.add_header("Authorization", f"Bearer {self.key}")
        if self.anon:
            req.add_header("apikey", self.anon)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                body = r.read().decode("utf-8", "replace")
                return r.status, json.loads(body) if body else {}
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(body) if body else {}
            except Exception:
                return e.code, {"error": body}

    def verify(self, patient_id: str, session_number: int, byte_count: int) -> bool:
        status, data = self._get("/sessions/verify", {
            "patient_id": patient_id,
            "session_number": session_number,
            "bytes": byte_count,
            "device_serial": self.serial,
        })
        return status == 200 and bool(data.get("stored"))
