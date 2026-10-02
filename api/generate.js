// Serverless proxy: keeps your Anthropic API key on the server, never in the browser.
// Env vars: ANTHROPIC_API_KEY (required), APP_SECRET (required, signs Pro tokens),
//           MODEL (default claude-sonnet-5), QUICK_MODEL (default claude-haiku-4-5-20251001),
//           FREE_BUILDS_PER_DAY (default 2 per visitor IP)
import { readToken } from "./_lib/auth.js";

const MODEL = process.env.MODEL || "claude-sonnet-5";
const QUICK_MODEL = process.env.QUICK_MODEL || "claude-haiku-4-5-20251001";
const MAX_PROMPT = 120000; // characters

// Light per-instance throttles. The hard cap on cost is the spend limit in the Anthropic Console.
const hits = new Map(), free = new Map();
function throttled(ip) {
  const now = Date.now(), win = 60_000, max = 20;
  const list = (hits.get(ip) || []).filter(t => now - t < win);
  list.push(now); hits.set(ip, list);
  return list.length > max;
}
// A free build is 3 requests (brand kit, ads, website). Count requests per day per IP.
function freeExhausted(ip) {
  const perDay = Number(process.env.FREE_BUILDS_PER_DAY || 2) * 3;
  const now = Date.now(), list = (free.get(ip) || []).filter(t => now - t < 86_400_000);
  if (list.length >= perDay) return true;
  list.push(now); free.set(ip, list);
  return false;
}

export default async function handler(req, res) {
  const key = process.env.ANTHROPIC_API_KEY;

  if (req.method === "GET") {
    return res.status(200).json({ configured: !!key, payments: !!process.env.STRIPE_SECRET_KEY });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (!key) return res.status(500).json({ error: "not_configured" });

  const body = typeof req.body === "string" ? safeParse(req.body) : (req.body || {});
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (throttled(ip)) return res.status(429).json({ error: "rate_limited" });
  // personal build: no gating

  const prompt = body.prompt;
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT) {
    return res.status(400).json({ error: "prompt_too_large" });
  }
  const model = body.tier === "quick" ? QUICK_MODEL : MODEL;

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return res.status(502).json({ error: "upstream_error" });
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    console.error("Anthropic API error", upstream.status, detail.slice(0, 500));
    return res.status(upstream.status === 429 ? 429 : 502)
      .json({ error: upstream.status === 429 ? "rate_limited" : "upstream_error" });
  }

  // Stream plain text back to the browser so long website builds don't time out.
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const ev = safeParse(line.slice(5));
        if (!ev) continue;
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") res.write(ev.delta.text);
        else if (ev.type === "error") {
          res.write("\n[[SHOPFRONT_ERROR]] " + (ev.error?.type === "overloaded_error" ? "rate_limited" : "upstream"));
        }
      }
    }
  } catch {
    res.write("\n[[SHOPFRONT_ERROR]] upstream");
  }
  res.end();
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
