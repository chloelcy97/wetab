#!/usr/bin/env python3
"""
WeTab 本地服务 —— 只用 Python 标准库，不需要 pip install。

  python3 server.py            # http://localhost:5173
  python3 server.py --port 8080

提供三件事：
  1. 托管仓库根目录下的静态文件
  2. GET  /api/rates  欧洲央行实时汇率（前端现在直连 frankfurter，这个端点仅作备用）
  3. POST /api/scan   把小票照片交给 Claude 视觉模型，返回结构化账目

小票识别需要 Anthropic API key：
  export ANTHROPIC_API_KEY=sk-ant-...
没有 key 时 /api/scan 会返回一条带 mock:true 的演示数据，界面照常跑通。
"""

import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import date
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
MODEL = os.environ.get("TALLY_MODEL", "claude-opus-5")

RATES_URL = (
    "https://api.frankfurter.dev/v1/latest?base=EUR&symbols="
    "HKD,GBP,CNY,USD,JPY,KRW,SGD,AUD,CAD,CHF,NZD,THB,MYR,IDR,PHP,INR"
)

_rates_cache = {"day": None, "payload": None}

SCAN_PROMPT = """你是一个记账助手。图片是一张消费小票、账单或支付截图。

请只输出一个 JSON 对象，不要有任何解释文字、不要用 markdown 代码块包裹。字段如下：

{
  "merchant":   "商家名称。用小票上的原文，最多 40 字。看不出来就填空字符串",
  "amount":     实付总金额的数字（不带货币符号、不带千分位）。含税含小费的最终应付金额,
  "currency":   "ISO 4217 三字母代码，例如 HKD/GBP/CNY/USD/JPY。根据货币符号、语言、地址、税种（VAT→GBP、增值税→CNY 等）判断",
  "date":       "小票上的消费日期，YYYY-MM-DD。看不到就填空字符串",
  "category":   "从下面的分类里选最贴切的一个 id",
  "note":       "一句话说明买了什么，最多 15 字。可留空",
  "confidence": "high 或 low。金额或币种任何一个不确定就填 low"
}

可选分类：
%s

注意：
- amount 要的是「实付总额」，不是小计、不是单项价格。
- 日元、韩元没有小数位，别自己加。
- 如果这张图根本不是消费凭证，amount 填 0，confidence 填 low。"""

MOCK = {
    "merchant": "Pret A Manger",
    "amount": 14.85,
    "currency": "GBP",
    "date": date.today().isoformat(),
    "category": "food",
    "note": "三明治同咖啡",
    "confidence": "high",
    "mock": True,
}


def fetch_rates():
    today = date.today().isoformat()
    if _rates_cache["day"] == today and _rates_cache["payload"]:
        return _rates_cache["payload"]
    req = urllib.request.Request(RATES_URL, headers={"User-Agent": "tally/1.0"})
    with urllib.request.urlopen(req, timeout=10) as r:
        payload = json.loads(r.read())
    payload["rates"]["EUR"] = 1.0
    _rates_cache.update(day=today, payload=payload)
    return payload


def extract_json(text):
    """模型偶尔会包一层 ``` 或加一句话，这里稳妥地把 JSON 抠出来。"""
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.S)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start, depth = text.find("{"), 0
    if start < 0:
        raise ValueError("模型没有返回 JSON")
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return json.loads(text[start:i + 1])
    raise ValueError("模型返回的 JSON 不完整")


def scan_receipt(data_url, categories):
    if not API_KEY:
        return MOCK

    m = re.match(r"^data:(image/[a-zA-Z+]+);base64,(.+)$", data_url, re.S)
    if not m:
        raise ValueError("图片格式不对，需要 base64 data URL")
    media_type, b64 = m.group(1), m.group(2)
    if media_type == "image/jpg":
        media_type = "image/jpeg"

    # 5MB 是 API 的单图上限，前端已经压过一次，这里兜底
    if len(base64.b64decode(b64)) > 5 * 1024 * 1024:
        raise ValueError("图片太大了，换一张小一点的")

    cat_lines = "\n".join(f'- {c["id"]}：{c["label"]}' for c in categories)
    body = {
        "model": MODEL,
        "max_tokens": 600,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image", "source": {
                    "type": "base64", "media_type": media_type, "data": b64}},
                {"type": "text", "text": SCAN_PROMPT % cat_lines},
            ],
        }],
    }

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode(),
        headers={
            "content-type": "application/json",
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            payload = json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:400]
        raise ValueError(f"Anthropic API {e.code}: {detail}")
    except urllib.error.URLError as e:
        raise ValueError(f"连不上 Anthropic API：{e.reason}")

    text = "".join(b.get("text", "") for b in payload.get("content", []))
    out = extract_json(text)

    # 规整一下，别让脏数据进前端
    try:
        out["amount"] = round(float(out.get("amount") or 0), 2)
    except (TypeError, ValueError):
        out["amount"] = 0
    out["currency"] = str(out.get("currency") or "").upper()[:3]
    valid = {c["id"] for c in categories}
    if out.get("category") not in valid:
        out["category"] = "other"
    if out.get("confidence") not in ("high", "low"):
        out["confidence"] = "low"
    return out


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

    def do_POST(self):
        if not self.path.startswith("/api/scan"):
            return self._json(404, {"error": "no such endpoint"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 12 * 1024 * 1024:
                return self._json(413, {"error": "图片太大了"})
            req = json.loads(self.rfile.read(n))
            result = scan_receipt(req.get("image", ""), req.get("categories") or [])
            return self._json(200, result)
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        except Exception as e:
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=5173)
    args = p.parse_args()

    print(f"\n  WeTab  →  http://localhost:{args.port}")
    print(f"  小票识别：{'已启用 · ' + MODEL if API_KEY else '演示模式（未设置 ANTHROPIC_API_KEY）'}")
    print("  Ctrl+C 停止\n")

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止\n")
        srv.server_close()


if __name__ == "__main__":
    main()
