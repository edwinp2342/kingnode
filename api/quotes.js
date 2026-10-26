// Batch quotes for the tape and the header. With a streaming provider on the local server, the engine's live record wins (and says it is
// real-time, and whether it is IEX or the consolidated tape); otherwise the provider's REST snapshot; otherwise Yahoo's chart meta, which
// is delayed and labelled so. Indices (SPX, NDX, …) are Yahoo-only on every provider: Alpaca and Polygon stock feeds do not carry them.
const YAHOO = { SPX: "^GSPC", NDX: "^NDX", RUT: "^RUT", VIX: "^VIX", DJX: "^DJI", DJI: "^DJI", XSP: "^GSPC", OEX: "^OEX" };
const INDEX = new Set(Object.keys(YAHOO));
const cache = new Map();
async function yahoo(sym) {
  const hit = cache.get(sym); if (hit && Date.now() - hit.at < 20_000) return hit.v;
  const y = YAHOO[sym] || sym;
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?interval=1m&range=1d&includePrePost=true`, { headers: { "user-agent": "Mozilla/5.0 (Kingnode)" }, signal: AbortSignal.timeout(12000) });
  if (r.status === 429) throw new Error("rate limited");
  if (!r.ok) throw new Error("http " + r.status);
  const j = await r.json(), res0 = j.chart?.result?.[0], m = res0?.meta; if (!m) throw new Error("no meta");
  const q = res0.indicators?.quote?.[0]; const closes = q?.close || [], ts = res0.timestamp || []; let last = +m.regularMarketPrice || 0, lastT = (m.regularMarketTime || 0) * 1000;
  for (let i = closes.length - 1; i >= 0; i--) if (closes[i] != null) { last = closes[i]; lastT = ts[i] * 1000; break; }
  const price = (YAHOO[sym] && last) ? last : (+m.regularMarketPrice || last), prev = +(m.chartPreviousClose ?? m.previousClose ?? price); const div = sym === "XSP" ? 10 : 1; const full = +m.fulldayPrice || 0;
  const v = { symbol: sym, price: price / div, prev: prev / div, last: last / div, state: m.marketState || null, t: lastT, regT: (m.regularMarketTime || 0) * 1000, full: full ? full / div : null, fullT: full ? Date.now() : null, source: "yahoo", feedType: "delayed", realtime: false };
  cache.set(sym, { at: Date.now(), v }); return v;
}
export default async function handler(req, res) {
  const syms = String(req.query?.symbols || "SPX,NDX,RUT,VIX,SPY,QQQ,IWM,DIA,XSP").toUpperCase().split(",").map(s => s.replace(/[^A-Z.\-]/g, "")).filter(Boolean).slice(0, 60);
  const kn = globalThis.__kingnode; const engine = kn?.engine, rest = kn?.rest; const out = []; const needRest = [];
  for (const s of syms) {
    if (INDEX.has(s)) { out.push(null); continue; }
    const live = engine?.snapshot(s);
    if (live && live.price && live.t && Date.now() - live.updatedAt < 120_000) out.push({ symbol: s, price: live.price, prev: live.prev, last: live.price, t: live.t, bid: live.bid, ask: live.ask, state: null, source: live.provider, feedType: live.feedType, realtime: true, consolidated: live.feedType === "sip" });
    else out.push(null), needRest.push(s);
  }
  let snaps = {}; if (rest && needRest.length) { try { snaps = await rest.snapshots(needRest); } catch (e) { console.error("snapshots", e.message); } }
  await Promise.all(syms.map(async (s, i) => {
    if (out[i]) return;
    const sn = snaps[s]; if (sn && !sn.error && sn.price) { out[i] = { symbol: s, price: sn.price, prev: sn.prev, last: sn.price, t: sn.t, bid: sn.bid, ask: sn.ask, state: null, source: sn.source, feedType: sn.feedType, realtime: !!sn.realtime }; return; }
    if (sn && sn.error && !INDEX.has(s)) { out[i] = { symbol: s, error: sn.error, source: rest.constructor.name === "AlpacaRest" ? "alpaca" : "polygon" }; return; }
    try { out[i] = await yahoo(s); } catch (e) { out[i] = { symbol: s, error: e.message, source: "yahoo" }; }
  }));
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ at: Date.now(), stream: engine ? engine.status().state : "disabled", quotes: out });
}
