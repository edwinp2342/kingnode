// Health check for your daily maintenance agent: verifies the data provider, bars, Stripe config and the last cron run.
import { fetchChain, fetchBars, provider } from "./_lib/data.js";

export default async function handler(req, res) {
  const out = { ok: true, at: new Date().toISOString(), provider: provider(), checks: {} };
  const t = async (name, fn) => { const s = Date.now(); try { const v = await fn(); out.checks[name] = { ok: true, ms: Date.now() - s, ...v }; } catch (e) { out.ok = false; out.checks[name] = { ok: false, ms: Date.now() - s, error: e.message }; } };
  await t("chain_spx", async () => { const c = await fetchChain("SPX"); if (!c.rows.length || !c.spot) throw new Error("empty chain"); return { spot: c.spot, rows: c.rows.length, asOf: c.asOf, delayed: c.delayed }; });
  await t("bars_spy", async () => { const b = await fetchBars("SPY", "5m", "1d"); if (!b.bars.length) throw new Error("no bars"); return { bars: b.bars.length, last: new Date(b.bars.at(-1)[0]).toISOString() }; });
  out.checks.stripe = { ok: !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_MONTHLY && process.env.STRIPE_PRICE_YEARLY), configured: !!process.env.STRIPE_SECRET_KEY };
  out.checks.app_secret = { ok: !!process.env.APP_SECRET };
  out.checks.anthropic = { ok: !!process.env.ANTHROPIC_API_KEY };
  out.checks.discord = { ok: !!(process.env.DISCORD_WEBHOOK || process.env.LEAD_WEBHOOK) };
  res.setHeader("Cache-Control", "no-store");
  return res.status(out.ok ? 200 : 503).json(out);
}
