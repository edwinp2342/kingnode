// Symbol search. Proxies Yahoo's public search endpoint (any listed name), cached per query.
const cache = new Map();
export default async function handler(req, res) {
  const q = String(req.query?.q || "").trim().slice(0, 30);
  if (q.length < 1) return res.status(200).json({ results: [] });
  const hit = cache.get(q.toLowerCase()); if (hit && Date.now() - hit.at < 3600_000) return res.status(200).json(hit.data);
  try {
    const r = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`, { headers: { "user-agent": "Mozilla/5.0 (Kingnode)" } });
    if (!r.ok) throw new Error("http " + r.status);
    const j = await r.json();
    const results = (j.quotes || []).filter(x => ["EQUITY", "ETF", "INDEX"].includes(x.quoteType) && /^[A-Z.^-]+$/.test(x.symbol)).map(x => ({ symbol: x.symbol.replace(/^\^/, ""), name: x.shortname || x.longname || "", type: x.quoteType, exchange: x.exchDisp || "" })).slice(0, 8);
    const data = { results }; cache.set(q.toLowerCase(), { at: Date.now(), data });
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.status(200).json(data);
  } catch (e) { return res.status(200).json({ results: [], error: e.message }); }
}
