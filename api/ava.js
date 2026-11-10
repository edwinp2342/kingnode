// Ava through the server: the browser sends a Messages API request body, the server adds its own Anthropic key and forwards it, streaming
// the answer back. The key never leaves the process. On any host that is not loopback the caller must present ASK_KEY (header x-ask-key
// or body.key) — the password entered in ⚙ Settings → Server access key — so nobody else spends the key.
//   GET  /api/ava              → { configured, locked, local }        (the app decides whether to route Ava here)
//   POST /api/ava { key, body } → the Messages API response, streamed when body.stream is true
const MAX_BODY = 1.5e6;
const ALLOWED_MODEL = /^claude-[a-z0-9.-]{2,60}$/;

export default async function handler(req, res) {
  const key = process.env.ANTHROPIC_API_KEY || "";
  const host = String(req.headers?.host || ""); const local = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host) && !req.headers?.["x-forwarded-for"] && !req.headers?.["x-forwarded-host"]; // loopback with no proxy in front: the desktop app
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return res.status(200).json({ configured: !!key, locked: !local && !!process.env.ASK_KEY, local, model: process.env.MODEL || null });
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (!key) return res.status(503).json({ error: "not_configured", hint: "set ANTHROPIC_API_KEY on the server" });
  const body = typeof req.body === "string" ? safeParse(req.body) : (req.body || {});
  if (!local) {
    if (!process.env.ASK_KEY) return res.status(401).json({ error: "locked", hint: "set ASK_KEY on the server and enter it in ⚙ Settings → Server access key" });
    const given = String(req.headers?.["x-ask-key"] || body.key || "");
    if (!given || !timingSafeEqualStr(given, process.env.ASK_KEY)) return res.status(401).json({ error: "bad_key" });
  }
  const m = body.body; if (!m || typeof m !== "object" || !Array.isArray(m.messages) || !m.messages.length) return res.status(400).json({ error: "bad_request", hint: "body.body must be a Messages API request" });
  if (JSON.stringify(m).length > MAX_BODY) return res.status(413).json({ error: "too_large" });
  // only the fields a chat needs are forwarded; the model is the server's unless the page asks for a valid Claude model
  const fwd = { model: ALLOWED_MODEL.test(String(m.model || "")) ? m.model : (process.env.MODEL || "claude-sonnet-5"), max_tokens: Math.max(1, Math.min(8192, Number(m.max_tokens) || 2400)), messages: m.messages, stream: !!m.stream };
  if (m.system != null) fwd.system = m.system; if (Array.isArray(m.tools) && m.tools.length) fwd.tools = m.tools; if (m.tool_choice) fwd.tool_choice = m.tool_choice; if (typeof m.temperature === "number") fwd.temperature = m.temperature;
  let up;
  try { up = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(fwd), signal: AbortSignal.timeout(fwd.stream ? 300000 : 120000) }); }
  catch (e) { return res.status(502).json({ error: "upstream_unreachable", detail: String(e.message || e).slice(0, 160) }); }
  res.setHeader("Content-Type", up.headers.get("content-type") || "application/json");
  if (fwd.stream && up.ok && up.body) { res.status(200); for await (const chunk of up.body) res.write(Buffer.from(chunk)); return res.end(); }
  return res.status(up.status).send(await up.text());
}
function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
function timingSafeEqualStr(a, b) { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
