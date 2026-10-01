// Restore Pro access on a new device: email on the receipt + last 4 digits of the card.
import { stripe, activePlan } from "./_lib/stripe.js";
import { issueToken, body } from "./_lib/auth.js";

const tries = new Map();

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const s = stripe(); if (!s) return res.status(500).json({ error: "not_configured" });
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const now = Date.now(), t = (tries.get(ip) || []).filter(x => now - x < 3600_000);
  if (t.length >= 10) return res.status(429).json({ error: "rate_limited" });
  t.push(now); tries.set(ip, t);

  const { email, last4 } = body(req);
  if (typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email) || !/^\d{4}$/.test(String(last4 || ""))) {
    return res.status(400).json({ error: "bad_input" });
  }
  try {
    const customers = await s.customers.list({ email: email.trim().toLowerCase(), limit: 5 });
    for (const c of customers.data) {
      const plan = await activePlan(c.id);
      if (!plan) continue;
      const pms = await s.paymentMethods.list({ customer: c.id, type: "card", limit: 10 });
      if (pms.data.some(pm => pm.card?.last4 === String(last4))) {
        return res.status(200).json({ token: issueToken(c.id, plan), plan });
      }
    }
    return res.status(404).json({ error: "no_subscription" });
  } catch (e) {
    console.error("restore", e.message);
    return res.status(502).json({ error: "stripe_error" });
  }
}
