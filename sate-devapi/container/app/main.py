"""Container entrypoint.

The poll loop is the real program; this HTTP server exists only so the Worker's
`/health` fetch has something to hit, which is what resets the container's idle timer
and keeps it awake between cron ticks. No work is ever done in a request handler.
"""

import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import processor


class Health(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *args):
        pass  # the poll loop's own logging is the useful signal


if __name__ == "__main__":
    threading.Thread(target=processor.loop, daemon=True).start()
    port = int(os.environ.get("PORT", "8080"))
    HTTPServer(("0.0.0.0", port), Health).serve_forever()
