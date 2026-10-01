// Price bars for the chart. Provider chosen in api/_lib/data.js (Polygon when DATA_PROVIDER=polygon, else Yahoo delayed).
import { fetchBars } from "./_lib/data.js";
const cache = new Map();

export default async function handler(req, res) {
  const symbol = String(req.query?.symbol || "SPX").toUpperCase().replace(/[^A-Z.]/g, "").slice(0, 8);
  const interval = ["1m", "5m", "15m", "30m", "1h", "1d"].includes(req.query?.interval) ? req.query.interval : "5m";
  const range = ["1d", "2d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y"].includes(req.query?.range) ? req.query.range : "5d";
  const extended = req.query?.extended === "1";
  const key = symbol + interval + range + (extended ? "x" : ""), hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return res.status(200).json(hit.data);
  try {
    const data = await fetchBars(symbol, interval, range, extended);
    if (!data.bars.length) throw new Error("no bars");
    cache.set(key, { at: Date.now(), data });
    res.setHeader("Cache-Control", "public, max-age=30");
    return res.status(200).json(data);
  } catch (e) {
    console.error("bars", symbol, e.message);
    return res.status(502).json({ error: "unavailable" });
  }
}
