// Forwards flow/level alerts from the terminal to your Discord (or any) webhook. Pro token or NOTIFY_OPEN=true required.
import { body } from "./_lib/auth.js";
const recent = new Map();
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const b = body(req);
  const hook = process.env.DISCORD_WEBHOOK || process.env.LEAD_WEBHOOK;
  if (!hook) return res.status(500).json({ error: "not_configured" });
  const text = String(b.text || "").slice(0, 1800); if (!text) return res.status(400).json({ error: "empty" });
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || "x"; const now = Date.now(), l = (recent.get(ip) || []).filter(t => now - t < 60_000);
  if (l.length >= 20) return res.status(429).json({ error: "rate_limited" }); l.push(now); recent.set(ip, l);
  try { const r = await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text, text }) }); return res.status(r.ok ? 200 : 502).json({ ok: r.ok }); }
  catch (e) { return res.status(502).json({ error: e.message }); }
}
