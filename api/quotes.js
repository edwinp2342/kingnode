// Batch quotes for the ticker tape. Yahoo chart meta (delayed) unless DATA_PROVIDER=polygon.
const YAHOO = { SPX: "^GSPC", NDX: "^NDX", RUT: "^RUT", VIX: "^VIX", DJX: "^DJI", DJI: "^DJI", XSP: "^GSPC", OEX: "^OEX" };
const cache = new Map();
async function one(sym) {
  const hit = cache.get(sym); if (hit && Date.now() - hit.at < 30_000) return hit.v;
  const y = YAHOO[sym] || sym;
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?interval=1m&range=1d&includePrePost=true`, { headers: { "user-agent": "Mozilla/5.0 (Kingnode)" } });
  if (!r.ok) throw new Error("http " + r.status);
  const j = await r.json(), m = j.chart?.result?.[0]?.meta; if (!m) throw new Error("no meta");
  const price = +(m.regularMarketPrice ?? 0), prev = +(m.chartPreviousClose ?? m.previousClose ?? 0);
  const q = j.chart.result[0].indicators?.quote?.[0]; const closes = (q?.close || []).filter(x => x != null); const last = closes.length ? closes[closes.length - 1] : price;
  const v = { symbol: sym, price: sym === "XSP" ? price / 10 : price, prev: sym === "XSP" ? prev / 10 : prev, last: sym === "XSP" ? last / 10 : last, state: m.marketState || null, t: (m.regularMarketTime || 0) * 1000 };
  cache.set(sym, { at: Date.now(), v }); return v;
}
export default async function handler(req, res) {
  const syms = String(req.query?.symbols || "SPX,NDX,RUT,VIX,SPY,QQQ,IWM,DIA,XSP").toUpperCase().split(",").map(s => s.replace(/[^A-Z.]/g, "")).filter(Boolean).slice(0, 30);
  const out = await Promise.all(syms.map(s => one(s).catch(e => ({ symbol: s, error: e.message }))));
  res.setHeader("Cache-Control", "public, max-age=15");
  return res.status(200).json({ at: Date.now(), quotes: out });
}
