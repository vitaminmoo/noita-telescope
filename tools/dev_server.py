#!/usr/bin/env python3
"""Dev server: python -m http.server, but with caching disabled.

Plain http.server sends no Cache-Control, so browsers heuristically cache
modules (10% of time-since-Last-Modified). Page modules get revalidated on
refresh, but WORKER subresources don't — after editing files, a worker can
load a mixed old/new module graph, fail to link, and die silently, taking
overlays / pixel scenes / edge decals with it (and "hard refresh doesn't
fix it"). no-cache forces revalidation on every fetch; 304s keep it fast.

Usage: python tools/dev_server.py [port]   (default 8000, serves repo root)
"""
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(os.path.join(os.path.dirname(__file__), '..'))
    http.server.ThreadingHTTPServer(('127.0.0.1', port), NoCacheHandler).serve_forever()
