// Renew a token if the subscription is still active (also catches cancellations).
import { activePlan, stripe } from "./_lib/stripe.js";
import { issueToken, readToken, body } from "./_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const p = readToken(body(req).token, { allowExpired: true });
  if (!p) return res.status(401).json({ error: "bad_token" });
  if (!stripe()) return res.status(500).json({ error: "not_configured" });
  try {
    const plan = await activePlan(p.c);
    if (!plan) return res.status(402).json({ error: "inactive" });
    return res.status(200).json({ token: issueToken(p.c, plan), plan });
  } catch (e) {
    console.error("refresh", e.message);
    return res.status(502).json({ error: "stripe_error" });
  }
}
