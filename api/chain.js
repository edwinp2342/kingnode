// Options chain endpoint. The provider (cboe | tradier | polygon) is chosen in api/_lib/data.js via DATA_PROVIDER.
import { readToken } from "./_lib/auth.js";

import { fetchChain, provider } from "./_lib/data.js";
const FREE_SYMBOLS = new Set(["SPX", "SPY"]);
const cache = new Map();

export default async function handler(req, res) {
  const symbol = String(req.query?.symbol || "SPX").toUpperCase().replace(/[^A-Z.]/g, "").slice(0, 8);
  if (!symbol) return res.status(400).json({ error: "bad_symbol" });
  const pro = !!readToken(String(req.query?.token || ""));
  if (!pro && !FREE_SYMBOLS.has(symbol) && process.env.GATE_SYMBOLS !== "false") return res.status(402).json({ error: "upgrade_required", symbol });
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < 60_000) { res.setHeader("Cache-Control", "public, max-age=30"); return res.status(200).json(hit.data); }
  try {
    const data = await fetchChain(symbol);
    cache.set(symbol, { at: Date.now(), data });
    res.setHeader("Cache-Control", "public, max-age=30");
    return res.status(200).json(data);
  } catch (e) {
    console.error("chain", provider(), symbol, e.message);
    return res.status(502).json({ error: "unavailable", symbol, provider: provider() });
  }
}
