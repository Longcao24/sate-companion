"""Container entrypoint.

Starts the poll loop in a background thread and serves a tiny HTTP endpoint on
$PORT so the Worker can boot / keep-warm the container (any request resets the
container's idle timer). The loop is where all the real work happens.
"""

import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from processor import loop


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *args):  # silence default request logging
        pass


def main():
    t = threading.Thread(target=loop, daemon=True)
    t.start()
    port = int(os.environ.get("PORT", "8080"))
    HTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
