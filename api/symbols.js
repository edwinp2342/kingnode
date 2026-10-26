// The market-wide symbol table: every active US equity the configured provider lists (Alpaca /v2/assets or Polygon reference tickers),
// cached for a day in memory; without a provider, the GitHub feed's directory (Nasdaq Trader + Cboe's options flag). Rows: [sym, name, exchange, etf, optionable].
let cache = { at: 0, rows: null, source: null };
export default async function handler(req, res) {
  const kn = globalThis.__kingnode; const q = String(req.query?.q || "").trim().toUpperCase();
  if (!cache.rows || Date.now() - cache.at > 24 * 3600e3) {
    try { if (kn?.rest) { cache = { at: Date.now(), rows: await kn.rest.assets(), source: kn.rest.constructor.name === "AlpacaRest" ? "alpaca" : "polygon" }; } }
    catch (e) { console.error("assets", e.message); }
    if (!cache.rows) { try { const r = await fetch("https://raw.githubusercontent.com/edwinp2342/kingnode/data/symbols.json", { signal: AbortSignal.timeout(20000) }); const j = await r.json(); cache = { at: Date.now(), rows: j.rows, source: "feed" }; } catch (e) { return res.status(503).json({ error: "no symbol directory: " + e.message }); } }
  }
  res.setHeader("Cache-Control", "public, max-age=3600");
  if (q) { const hits = cache.rows.filter(r => r[0].startsWith(q) || r[1].toUpperCase().includes(q)).sort((a, b) => (a[0] === q ? -1 : b[0] === q ? 1 : a[0].startsWith(q) === b[0].startsWith(q) ? a[0].length - b[0].length : a[0].startsWith(q) ? -1 : 1)).slice(0, 12); return res.status(200).json({ source: cache.source, at: cache.at, results: hits.map(r => ({ symbol: r[0], name: r[1], exchange: r[2], etf: !!r[3], optionable: !!r[4] })) }); }
  return res.status(200).json({ source: cache.source, at: cache.at, n: cache.rows.length, cols: "sym name exchange etf optionable", rows: cache.rows });
}
