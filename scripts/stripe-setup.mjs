// Creates the Shopfront product and both prices in your Stripe account, then prints the env vars to set.
// Usage:  STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup.mjs
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error("Set STRIPE_SECRET_KEY first."); process.exit(1); }
const stripe = new Stripe(key);

const product = await stripe.products.create({
  name: "Kingnode Pro",
  description: "All tickers, all expirations, alerts, exports and Ask the desk.",
});
const monthly = await stripe.prices.create({ product: product.id, currency: "usd", unit_amount: 1900, recurring: { interval: "month" }, nickname: "Pro monthly" });
const yearly = await stripe.prices.create({ product: product.id, currency: "usd", unit_amount: 15900, recurring: { interval: "year" }, nickname: "Pro yearly" });

console.log("\nDone. Add these to Vercel → Settings → Environment Variables (or .env.local):\n");
console.log(`STRIPE_SECRET_KEY=${key}`);
console.log(`STRIPE_PRICE_MONTHLY=${monthly.id}`);
console.log(`STRIPE_PRICE_YEARLY=${yearly.id}`);
console.log("\nThen in Stripe Dashboard → Settings → Billing → Customer portal: turn the portal on and allow customers to cancel and switch plans.");
