// Price bars for the chart. With a streaming provider configured, its REST history (Alpaca: IEX or SIP per plan; Polygon/Massive: SIP);
// otherwise api/_lib/data.js (Polygon when DATA_PROVIDER=polygon, else Yahoo, delayed). Every response names its source and feed type.
// Indices come from Yahoo on every provider. Cached for 20 s per key; a 429 from the provider is passed on as 429 with retry-after.
import { fetchBars } from "./_lib/data.js";
const INDEX = new Set(["SPX", "NDX", "RUT", "VIX", "DJX", "XSP", "OEX"]);
const cache = new Map();
const INTERVALS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w", "1M"], RANGES = ["1d", "2d", "5d", "1mo", "3mo", "6mo", "ytd", "1y", "2y", "5y", "max"];

export default async function handler(req, res) {
  const symbol = String(req.query?.symbol || "SPX").toUpperCase().replace(/[^A-Z.\-]/g, "").slice(0, 10);
  const interval = INTERVALS.includes(req.query?.interval) ? req.query.interval : "5m";
  const range = RANGES.includes(req.query?.range) ? req.query.range : "5d";
  const extended = req.query?.extended === "1";
  const key = symbol + interval + range + (extended ? "x" : ""), hit = cache.get(key);
  if (hit && Date.now() - hit.at < 20_000) return res.status(200).json(hit.data);
  const rest = globalThis.__kingnode?.rest;
  try {
    let data;
    if (rest && !INDEX.has(symbol)) data = await rest.bars(symbol, interval, range, { extended });
    else data = await fetchBars(symbol, ["1m", "5m", "15m", "30m", "1h", "1d"].includes(interval) ? interval : "1d", ["1d", "2d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y"].includes(range) ? range : "1y", extended);
    if (!data.bars?.length) throw new Error("no bars");
    data.feedType = data.feedType || (data.source === "polygon" ? "sip" : data.source === "alpaca" ? "iex" : "delayed"); data.realtime = data.delayed === false;
    cache.set(key, { at: Date.now(), data });
    res.setHeader("Cache-Control", "public, max-age=15");
    return res.status(200).json(data);
  } catch (e) {
    console.error("bars", symbol, e.message);
    if (e.code === 429) { res.setHeader("Retry-After", String(e.retryAfter || 2)); return res.status(429).json({ error: "rate limited", retryAfter: e.retryAfter || 2 }); }
    return res.status(502).json({ error: "unavailable", detail: e.message });
  }
}
