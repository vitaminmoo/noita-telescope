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

Usage: python tools/dev_server.py [port] [--cache=MODE] [--latency-ms=N] [--root=DIR]
  port            default 8000; serves the repo root
  --root=DIR      serve DIR instead: a build of the site (tools/build_site.mjs).
                  Whatever is under /assets/ is content-hashed there and gets
                  a year, immutable, in every cache mode, as _headers deploys it
  --cache=MODE    which Cache-Control the files get. The load-time benchmark
                  uses it to stand in for a deployment:
                    no-cache   (default) revalidate everything, as _headers
                               deploys telescope today
                    immutable  a year, immutable: what content-hashed file
                               names allow (a return visit asks for nothing)
  --latency-ms=N  sleep N ms before answering a GET or HEAD, as a round trip
                  to an edge would cost. Over HTTP/1 the browser runs six of
                  these at a time, so it overstates a multiplexed connection.

GET /__stats returns {"requests", "notModified", "bytes", "paths"} since the
last GET /__stats?reset=1 -- page and worker requests alike; "paths" is how
often each path was asked for.
"""
import http.server
import json
import os
import sys
import threading
import time

FRAME_LOG = os.path.join('data', 'dumps', 'frame_log.ndjson')
FRAME_LOG_MAX_POST = 4 * 1024 * 1024

CACHE_CONTROL = {
    'no-cache': 'no-cache',
    'immutable': 'public, max-age=31536000, immutable',
}
cache_mode = 'no-cache'
latency_s = 0.0
stats = {'requests': 0, 'notModified': 0, 'bytes': 0, 'paths': {}}
stats_lock = threading.Lock()


class DevHandler(http.server.SimpleHTTPRequestHandler):
    def internal(self):
        """The server's own endpoints: never cached, counted or logged."""
        return getattr(self, 'path', '').startswith('/__')

    def end_headers(self):
        path = getattr(self, 'path', '')
        self.send_header('Cache-Control', 'no-cache' if self.internal()
                         else CACHE_CONTROL['immutable'] if path.startswith('/assets/')
                         else CACHE_CONTROL[cache_mode])
        super().end_headers()

    def send_response(self, code, message=None):
        if not self.internal():
            with stats_lock:
                stats['requests'] += 1
                path = self.path.split('?', 1)[0]
                stats['paths'][path] = stats['paths'].get(path, 0) + 1
                if code == 304:
                    stats['notModified'] += 1
        super().send_response(code, message)

    def send_header(self, keyword, value):
        if keyword.lower() == 'content-length' and not self.internal():
            with stats_lock:
                stats['bytes'] += int(value)
        super().send_header(keyword, value)

    def serve_stats(self):
        with stats_lock:
            body = json.dumps(stats).encode()
            if 'reset=1' in self.path:
                for k in stats:
                    stats[k] = {} if k == 'paths' else 0
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/__stats'):
            self.serve_stats()
            return
        if latency_s:
            time.sleep(latency_s)
        super().do_GET()

    def do_HEAD(self):
        if latency_s:
            time.sleep(latency_s)
        super().do_HEAD()

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
        if self.internal():
            return
        super().log_message(format, *args)


if __name__ == '__main__':
    port = 8000
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
    for arg in sys.argv[1:]:
        if arg.startswith('--cache='):
            cache_mode = arg.split('=', 1)[1]
            if cache_mode not in CACHE_CONTROL:
                sys.exit(f'unknown --cache mode {cache_mode!r}; one of {", ".join(CACHE_CONTROL)}')
        elif arg.startswith('--latency-ms='):
            latency_s = float(arg.split('=', 1)[1]) / 1000
        elif arg.startswith('--root='):
            root = os.path.abspath(arg.split('=', 1)[1])
        else:
            port = int(arg)
    os.chdir(root)
    http.server.ThreadingHTTPServer(('127.0.0.1', port), DevHandler).serve_forever()
