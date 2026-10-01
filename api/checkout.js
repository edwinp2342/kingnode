import { stripe, PRICES, origin } from "./_lib/stripe.js";
import { body } from "./_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const s = stripe(), prices = PRICES();
  const plan = body(req).plan === "yearly" ? "yearly" : "monthly";
  if (!s || !prices[plan] || !process.env.APP_SECRET) return res.status(500).json({ error: "not_configured" });
  try {
    const base = origin(req);
    const session = await s.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: prices[plan], quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${base}/app.html?checkout={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/#pricing`,
      metadata: { plan },
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("checkout", e.message);
    return res.status(502).json({ error: "stripe_error" });
  }
}
