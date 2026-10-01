#!/usr/bin/env python3
"""Dev server: python -m http.server, but with caching disabled.

Plain http.server sends no Cache-Control, so browsers heuristically cache
modules (10% of time-since-Last-Modified). Page modules get revalidated on
refresh, but WORKER subresources don't — after editing files, a worker can
load a mixed old/new module graph, fail to link, and die silently, taking
overlays / pixel scenes / edge decals with it (and "hard refresh doesn't
fix it"). no-cache forces revalidation on every fetch; 304s keep it fast.

POST /__frame_log appends the request body to data/dumps/frame_log.ndjson:
the page's frame log (js/frame_slo.js) sends every missed frame there, so a
session in a live browser can be read back from disk.

Usage: python tools/dev_server.py [port]   (default 8000, serves repo root)
"""
import http.server
import os
import sys

FRAME_LOG = os.path.join('data', 'dumps', 'frame_log.ndjson')
FRAME_LOG_MAX_POST = 4 * 1024 * 1024


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        if self.path != '/__frame_log' or not 0 < length <= FRAME_LOG_MAX_POST:
            self.send_error(404)
            return
        body = self.rfile.read(length)
        os.makedirs(os.path.dirname(FRAME_LOG), exist_ok=True)
        with open(FRAME_LOG, 'ab') as f:
            f.write(body if body.endswith(b'\n') else body + b'\n')
        self.send_response(204)
        self.end_headers()

    def log_message(self, format, *args):
        # One line per posted batch would bury the request log.
        if self.command == 'POST' and self.path == '/__frame_log':
            return
        super().log_message(format, *args)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(os.path.join(os.path.dirname(__file__), '..'))
    http.server.ThreadingHTTPServer(('127.0.0.1', port), NoCacheHandler).serve_forever()
