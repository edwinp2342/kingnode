// Stripe Customer Portal: update card, switch plan, cancel.
import { stripe, origin } from "./_lib/stripe.js";
import { readToken, body } from "./_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const p = readToken(body(req).token, { allowExpired: true });
  if (!p) return res.status(401).json({ error: "bad_token" });
  const s = stripe(); if (!s) return res.status(500).json({ error: "not_configured" });
  try {
    const session = await s.billingPortal.sessions.create({ customer: p.c, return_url: `${origin(req)}/app.html` });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("portal", e.message);
    return res.status(502).json({ error: "stripe_error" });
  }
}
