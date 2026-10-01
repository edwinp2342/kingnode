// After Stripe Checkout redirects back: turn the session into an access token.
import { stripe, activePlan } from "./_lib/stripe.js";
import { issueToken, body } from "./_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const s = stripe(); if (!s) return res.status(500).json({ error: "not_configured" });
  const id = String(body(req).session_id || "");
  if (!/^cs_/.test(id)) return res.status(400).json({ error: "bad_session" });
  try {
    const session = await s.checkout.sessions.retrieve(id);
    const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
    if (!customer || session.status !== "complete") return res.status(402).json({ error: "not_paid" });
    const plan = (await activePlan(customer)) || session.metadata?.plan || "monthly";
    return res.status(200).json({ token: issueToken(customer, plan), plan });
  } catch (e) {
    console.error("session", e.message);
    return res.status(502).json({ error: "stripe_error" });
  }
}
