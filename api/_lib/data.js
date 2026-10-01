// Data providers. Set DATA_PROVIDER=cboe (default, free, delayed, personal use) | tradier | polygon.
// Every provider returns the same normalized chain:
//   { symbol, spot, asOf, delayed, source, change, changePct, rows: [[exp,type,strike,oi,vol,iv,gamma,delta,bid,ask,last], ...] }

const INDEX = new Set(["SPX", "NDX", "RUT", "VIX", "DJX", "XSP", "OEX"]);
const MAX_EXPS = Number(process.env.MAX_EXPIRATIONS || 12);

export function provider() { return (process.env.DATA_PROVIDER || "cboe").toLowerCase(); }

export async function fetchChain(symbol) {
  const p = provider();
  if (p === "tradier") return tradierChain(symbol);
  if (p === "polygon") return polygonChain(symbol);
  return cboeChain(symbol);
}

// ---------- Cboe delayed (free) ----------
function parseOcc(sym) {
  const m = sym.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  return { exp: `20${m[2].slice(0, 2)}-${m[2].slice(2, 4)}-${m[2].slice(4, 6)}`, type: m[3], strike: Number(m[4]) / 1000 };
}
async function cboeChain(symbol) {
  const candidates = INDEX.has(symbol) ? [`_${symbol}`, symbol] : [symbol];
  let lastErr;
  for (const s of candidates) {
    try {
      const r = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${s}.json`, { headers: { "user-agent": "Mozilla/5.0 (Undertow)" } });
      if (!r.ok) { lastErr = new Error("http " + r.status); continue; }
      const j = await r.json(), d = j.data || j;
      if (!Array.isArray(d.options)) { lastErr = new Error("no options"); continue; }
      const spot = Number(d.current_price ?? d.close ?? d.last_trade_price ?? 0);
      const rows = [];
      for (const o of d.options) {
        const p = parseOcc(String(o.option || "")); if (!p) continue;
        rows.push([p.exp, p.type, p.strike, +o.open_interest || 0, +o.volume || 0, +o.iv || 0, +o.gamma || 0, +o.delta || 0, +o.bid || 0, +o.ask || 0, +o.last_trade_price || 0]);
      }
      return finish({ symbol, spot, asOf: j.timestamp || new Date().toISOString(), delayed: true, source: "cboe-delayed", change: +d.price_change || 0, changePct: +d.price_change_percent || 0, rows });
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("chain unavailable");
}

// ---------- Tradier (TRADIER_TOKEN; TRADIER_ENV=sandbox|prod) ----------
function tradierBase() { return process.env.TRADIER_ENV === "prod" ? "https://api.tradier.com/v1" : "https://sandbox.tradier.com/v1"; }
async function tradier(path, params) {
  const u = new URL(tradierBase() + path); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${process.env.TRADIER_TOKEN}`, Accept: "application/json" } });
  if (!r.ok) throw new Error(`tradier ${path} http ${r.status}`);
  return r.json();
}
async function tradierChain(symbol) {
  if (!process.env.TRADIER_TOKEN) throw new Error("TRADIER_TOKEN missing");
  const q = await tradier("/markets/quotes", { symbols: symbol });
  const quote = q.quotes?.quote; const qq = Array.isArray(quote) ? quote[0] : quote;
  const spot = +qq?.last || +qq?.close || 0;
  const ex = await tradier("/markets/options/expirations", { symbol, includeAllRoots: "true" });
  let exps = ex.expirations?.date || []; if (!Array.isArray(exps)) exps = [exps];
  exps = exps.slice(0, MAX_EXPS);
  const rows = [];
  await Promise.all(exps.map(async exp => {
    const c = await tradier("/markets/options/chains", { symbol, expiration: exp, greeks: "true" });
    let list = c.options?.option || []; if (!Array.isArray(list)) list = [list];
    for (const o of list) {
      const g = o.greeks || {};
      rows.push([exp, o.option_type === "call" ? "C" : "P", +o.strike, +o.open_interest || 0, +o.volume || 0, +g.mid_iv || +g.smv_vol || 0, +g.gamma || 0, +g.delta || 0, +o.bid || 0, +o.ask || 0, +o.last || 0]);
    }
  }));
  return finish({ symbol, spot, asOf: new Date().toISOString(), delayed: process.env.TRADIER_ENV !== "prod", source: "tradier", change: +qq?.change || 0, changePct: +qq?.change_percentage || 0, rows });
}

// ---------- Polygon (POLYGON_KEY) ----------
async function polygon(url) {
  const u = new URL(url); u.searchParams.set("apiKey", process.env.POLYGON_KEY);
  const r = await fetch(u); if (!r.ok) throw new Error(`polygon http ${r.status}`); return r.json();
}
async function polygonChain(symbol) {
  if (!process.env.POLYGON_KEY) throw new Error("POLYGON_KEY missing");
  const under = INDEX.has(symbol) ? `I:${symbol}` : symbol;
  const rows = []; let spot = 0, change = 0, changePct = 0;
  let url = `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(under)}?limit=250`;
  const expSet = new Set();
  for (let page = 0; page < 40 && url; page++) {
    const j = await polygon(url);
    for (const o of j.results || []) {
      const d = o.details || {}, g = o.greeks || {};
      if (!spot && o.underlying_asset?.price) spot = +o.underlying_asset.price;
      if (!spot && o.underlying_asset?.value) spot = +o.underlying_asset.value;
      expSet.add(d.expiration_date);
      if (expSet.size > MAX_EXPS && !rows.some(r => r[0] === d.expiration_date)) continue;
      rows.push([d.expiration_date, d.contract_type === "call" ? "C" : "P", +d.strike_price, +o.open_interest || 0, +(o.day?.volume) || 0, +o.implied_volatility || 0, +g.gamma || 0, +g.delta || 0, +(o.last_quote?.bid) || 0, +(o.last_quote?.ask) || 0, +(o.day?.close) || 0]);
    }
    url = j.next_url || null;
  }
  return finish({ symbol, spot, asOf: new Date().toISOString(), delayed: false, source: "polygon", change, changePct, rows });
}

function finish(chain) {
  // keep only the nearest MAX_EXPS expirations, sorted
  const exps = [...new Set(chain.rows.map(r => r[0]))].filter(Boolean).sort().slice(0, MAX_EXPS);
  const keep = new Set(exps);
  chain.rows = chain.rows.filter(r => keep.has(r[0]) && r[2] > 0);
  chain.cols = ["exp", "type", "strike", "oi", "vol", "iv", "gamma", "delta", "bid", "ask", "last"];
  return chain;
}

// ---------- Bars ----------
const YAHOO = { SPX: "^GSPC", NDX: "^NDX", RUT: "^RUT", VIX: "^VIX", DJX: "^DJI", XSP: "^GSPC", OEX: "^OEX" };
export async function fetchBars(symbol, interval, range, extended = false) {
  if (provider() === "polygon" && process.env.POLYGON_KEY) { // Polygon aggs include extended hours; the chart shades them by clock time
    const [mult, span] = { "1m": [1, "minute"], "5m": [5, "minute"], "15m": [15, "minute"], "30m": [30, "minute"], "1h": [1, "hour"], "1d": [1, "day"] }[interval];
    const days = { "1d": 2, "2d": 3, "5d": 8, "1mo": 32, "3mo": 95, "6mo": 185, "1y": 370, "2y": 740, "5y": 1830 }[range] || 8;
    const to = new Date(), from = new Date(Date.now() - days * 86400000);
    const t = INDEX.has(symbol) ? `I:${symbol}` : symbol;
    const j = await polygon(`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(t)}/range/${mult}/${span}/${from.toISOString().slice(0, 10)}/${to.toISOString().slice(0, 10)}?adjusted=true&sort=asc&limit=50000`);
    return { symbol, interval, range, bars: (j.results || []).map(b => [b.t, b.o, b.h, b.l, b.c, b.v || 0]).slice(-1500), delayed: false, source: "polygon" };
  }
  const y = YAHOO[symbol] || symbol;
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?interval=${interval}&range=${range}&includePrePost=${extended ? "true" : "false"}`, { headers: { "user-agent": "Mozilla/5.0 (Undertow)" } });
  if (!r.ok) throw new Error("yahoo http " + r.status);
  const j = await r.json(), res0 = j.chart?.result?.[0], q = res0?.indicators?.quote?.[0];
  if (!res0?.timestamp || !q) throw new Error("no bars");
  const bars = []; res0.timestamp.forEach((t, i) => { if (q.close[i] != null && q.open[i] != null) bars.push([t * 1000, q.open[i], q.high[i], q.low[i], q.close[i], q.volume?.[i] || 0]); });
  const meta = res0.meta || {};
  const session = { regularStart: meta.currentTradingPeriod?.regular?.start ? meta.currentTradingPeriod.regular.start * 1000 : null, regularEnd: meta.currentTradingPeriod?.regular?.end ? meta.currentTradingPeriod.regular.end * 1000 : null, regularPrice: meta.regularMarketPrice ?? null, marketState: meta.marketState || null };
  return { symbol, interval, range, extended, bars: bars.slice(-1500), delayed: true, source: "yahoo", session };
}
