#!/usr/bin/env python3
"""
WeTab 本地开发服务 —— 只用 Python 标准库，不需要 pip install。

  python3 server.py            # http://localhost:5173
  python3 server.py --port 8080

做两件事：
  1. 托管仓库根目录下的静态文件
  2. GET /api/rates  欧洲央行汇率

前端其实直连 frankfurter（那边 CORS 是 *），所以 /api/rates 只是个备用出口，
本机网络挡了第三方域名时能顶上。线上（GitHub Pages）不需要这个服务。
"""

import argparse
import json
import sys
import urllib.request
from datetime import date
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent

RATES_URL = (
    "https://api.frankfurter.dev/v1/latest?base=EUR&symbols="
    "HKD,GBP,CNY,USD,JPY,KRW,SGD,AUD,CAD,CHF,NZD,THB,MYR,IDR,PHP,INR"
)

_rates_cache = {"day": None, "payload": None}


def fetch_rates():
    today = date.today().isoformat()
    if _rates_cache["day"] == today and _rates_cache["payload"]:
        return _rates_cache["payload"]
    req = urllib.request.Request(RATES_URL, headers={"User-Agent": "wetab/1.0"})
    with urllib.request.urlopen(req, timeout=10) as r:
        payload = json.loads(r.read())
    payload["rates"]["EUR"] = 1.0
    _rates_cache.update(day=today, payload=payload)
    return payload


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
        ".js": "text/javascript",
    }

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write("  %s %s\n" % (self.command, self.path))

    def _json(self, code, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def end_headers(self):
        # 本地开发：改完文件刷新就生效，不要缓存
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/api/rates"):
            try:
                return self._json(200, fetch_rates())
            except Exception as e:
                return self._json(502, {"error": str(e)})
        return super().do_GET()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=5173)
    args = p.parse_args()

    print(f"\n  WeTab  →  http://localhost:{args.port}")
    print("  Ctrl+C 停止\n")

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止\n")
        srv.server_close()


if __name__ == "__main__":
    main()
