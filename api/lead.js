// Receives "Request a free call" form submissions from the landing page.
// Every lead is printed to your Vercel logs. To get them on your phone or in a sheet,
// set LEAD_WEBHOOK to a Slack, Discord, Zapier, Make, or Google Apps Script webhook URL.

const recent = new Map();

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const b = typeof req.body === "string" ? safe(req.body) : (req.body || {});
  if (b.website_url) return res.status(200).json({ ok: true }); // bot trap: silently accept

  const clip = (v, n) => String(v || "").trim().slice(0, n);
  const lead = {
    name: clip(b.name, 120), business: clip(b.business, 160), phone: clip(b.phone, 40),
    email: clip(b.email, 160), need: clip(b.need, 80), message: clip(b.message, 2000),
    at: new Date().toISOString(),
  };
  if (!lead.name || !lead.business || (!lead.phone && !lead.email)) return res.status(400).json({ error: "missing_fields" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const now = Date.now(), last = (recent.get(ip) || []).filter(t => now - t < 3600_000);
  if (last.length >= 5) return res.status(429).json({ error: "rate_limited" });
  last.push(now); recent.set(ip, last);

  const text = `New Kingnode lead: ${lead.name} — ${lead.business}\n` +
    `Needs: ${lead.need}\nPhone: ${lead.phone || "—"}\nEmail: ${lead.email || "—"}\n` +
    (lead.message ? `Notes: ${lead.message}` : "");
  console.log("LEAD", JSON.stringify(lead));

  if (process.env.LEAD_WEBHOOK) {
    try {
      await fetch(process.env.LEAD_WEBHOOK, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, content: text, ...lead }), // text=Slack, content=Discord, fields=Zapier/Make/Sheets
      });
    } catch (e) { console.error("Lead webhook failed", e); }
  }
  return res.status(200).json({ ok: true });
}
function safe(s) { try { return JSON.parse(s); } catch { return null; } }
