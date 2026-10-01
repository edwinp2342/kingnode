import Stripe from "stripe";

let client = null;
export function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return client || (client = new Stripe(process.env.STRIPE_SECRET_KEY));
}

export const PRICES = () => ({
  monthly: process.env.STRIPE_PRICE_MONTHLY,
  yearly: process.env.STRIPE_PRICE_YEARLY,
});

/** The customer's active plan ("monthly" | "yearly") or null. */
export async function activePlan(customerId) {
  const s = stripe(); if (!s) return null;
  const subs = await s.subscriptions.list({ customer: customerId, status: "all", limit: 10 });
  const prices = PRICES();
  for (const sub of subs.data) {
    if (!["active", "trialing", "past_due"].includes(sub.status)) continue;
    for (const item of sub.items.data) {
      if (item.price.id === prices.yearly) return "yearly";
      if (item.price.id === prices.monthly) return "monthly";
    }
    return sub.items.data[0]?.price?.recurring?.interval === "year" ? "yearly" : "monthly";
  }
  return null;
}

export function origin(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  return process.env.SITE_URL || `${proto}://${req.headers.host}`;
}
