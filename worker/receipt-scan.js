/**
 * WeTab 小票识别 —— Cloudflare Worker
 *
 * 它只做一件事：接住前端传来的小票照片，代为调用 Anthropic 视觉模型，
 * 把结果整理成结构化账目返回。API key 存在 Worker 的 Secret 里，不进浏览器。
 *
 * ── 部署（全程网页操作，不需要 CLI，也不需要 Node）────────────────────────
 *   1. dash.cloudflare.com → Compute (Workers) → Create → Start with Hello World
 *      名字填 wetab-scan，Deploy
 *   2. 进去点 Edit code，把左边整份代码删掉，粘贴本文件全部内容，Deploy
 *   3. Settings → Variables and Secrets → Add
 *        Type   Secret
 *        Name   ANTHROPIC_API_KEY
 *        Value  你的 key（console.anthropic.com 生成）
 *      Deploy
 *   4. 复制 Worker 网址，形如 https://wetab-scan.<你的子域>.workers.dev
 *      填进项目根目录的 config.js → SCAN_ENDPOINT
 *
 * ── 可选的环境变量 ──────────────────────────────────────────────────────
 *   TALLY_MODEL      默认 claude-sonnet-5。小票识别用 Sonnet 足够，比 Opus 便宜很多。
 *                    遇到特别难认的手写单据可以改成 claude-opus-5。
 *   ALLOWED_ORIGINS  逗号分隔。默认只允许下面 DEFAULT_ORIGINS 里的地址。
 */

const DEFAULT_ORIGINS = [
  'https://chloelcy97.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;   // Anthropic 单图上限
const MAX_BODY_BYTES = 12 * 1024 * 1024;

const PROMPT = `你是一个记账助手。图片是一张消费小票、账单或支付截图。

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
%CATS%

注意：
- amount 要的是「实付总额」，不是小计、不是单项价格。
- 日元、韩元没有小数位，别自己加。
- 如果这张图根本不是消费凭证，amount 填 0，confidence 填 low。`;

/* -------------------------------------------------------------------------- */

function allowedOrigins(env) {
  return env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ORIGINS;
}

function corsHeaders(origin, env) {
  const list = allowedOrigins(env);
  const ok = origin && list.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : list[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

/** 模型偶尔会包一层 ``` 或多说一句话，这里稳妥地把 JSON 抠出来 */
function extractJson(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {}
  const start = t.indexOf('{');
  if (start < 0) throw new Error('模型没有返回 JSON');
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === '{') depth++;
    else if (t[i] === '}' && --depth === 0) return JSON.parse(t.slice(start, i + 1));
  }
  throw new Error('模型返回的 JSON 不完整');
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: '只接受 POST' }, 405, cors);

    // 只放行自己的站点，免得 Worker 地址被人捡去刷额度
    if (!allowedOrigins(env).includes(origin)) {
      return json({ error: '来源不允许' }, 403, cors);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'Worker 还没设置 ANTHROPIC_API_KEY' }, 500, cors);
    }

    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_BODY_BYTES) return json({ error: '图片太大了' }, 413, cors);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: '请求不是合法 JSON' }, 400, cors);
    }

    const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/s.exec(body.image || '');
    if (!m) return json({ error: '图片格式不对，需要 base64 data URL' }, 400, cors);

    let mediaType = m[1] === 'image/jpg' ? 'image/jpeg' : m[1];
    const b64 = m[2];
    if (Math.ceil(b64.length * 3 / 4) > MAX_IMAGE_BYTES) {
      return json({ error: '图片太大了，换一张小一点的' }, 413, cors);
    }

    const categories = Array.isArray(body.categories) ? body.categories : [];
    const catLines = categories.map((c) => `- ${c.id}：${c.label}`).join('\n');

    let payload;
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: env.TALLY_MODEL || 'claude-sonnet-5',
          max_tokens: 600,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
              { type: 'text', text: PROMPT.replace('%CATS%', catLines) },
            ],
          }],
        }),
      });
      const raw = await res.text();
      if (!res.ok) return json({ error: `Anthropic API ${res.status}: ${raw.slice(0, 300)}` }, 502, cors);
      payload = JSON.parse(raw);
    } catch (e) {
      return json({ error: `连不上 Anthropic API：${e.message}` }, 502, cors);
    }

    let out;
    try {
      const text = (payload.content || []).map((b) => b.text || '').join('');
      out = extractJson(text);
    } catch (e) {
      return json({ error: e.message }, 502, cors);
    }

    // 规整一下，别让脏数据进前端
    const n = Number(out.amount);
    out.amount = Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
    out.currency = String(out.currency || '').toUpperCase().slice(0, 3);
    const valid = new Set(categories.map((c) => c.id));
    if (!valid.has(out.category)) out.category = categories[0] ? categories[0].id : 'food';
    if (out.confidence !== 'high' && out.confidence !== 'low') out.confidence = 'low';

    return json(out, 200, cors);
  },
};
