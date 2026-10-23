// A stand-in network for the feed, so `node --import ./test/fake-net.mjs scripts/snapshot.mjs --once` runs a whole cycle offline:
// Yahoo chart requests get a synthetic session of bars with a realistic meta block, Cboe chain requests a small synthetic chain,
// everything else a 404. The shapes match what the real endpoints return, so the writers downstream are exercised for real.
const realFetch = globalThis.fetch;
const seedOf = s => { let h = 7; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 2147483647; return h || 1; };
function series(sym, interval, range, prePost) {
  let seed = seedOf(sym); const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const base = { SPY: 760, QQQ: 700, SPX: 7650, NDX: 28900, RUT: 2780, VIX: 19 }[sym.replace("^GSPC", "SPX").replace("^NDX", "NDX").replace("^RUT", "RUT").replace("^VIX", "VIX")] || 50 + (seedOf(sym) % 400);
  const mins = { "1m": 1, "5m": 5, "1d": 1440 }[interval] || 5;
  const now = Date.now(); const ts = [], o = [], h = [], l = [], c = [], v = [];
  const days = { "1d": 1, "5d": 5, "1y": 250, "4mo": 85 }[range] || 1;
  const et = t => { const d = new Date(new Date(t).toLocaleString("en-US", { timeZone: "America/New_York" })); return d.getHours() * 60 + d.getMinutes(); };
  let px = base; const start = now - days * 864e5;
  for (let t = Math.floor(start / 60000) * 60000; t <= now; t += mins * 60000) {
    const dow = new Date(t).getUTCDay(); if (dow === 0 || dow === 6) continue;
    if (mins < 1440) { const m = et(t); if (prePost ? (m < 240 || m >= 1200) : (m < 570 || m >= 960)) continue; }
    const op = px, cl = op * (1 + (rnd() - 0.5) * 0.002 * Math.sqrt(mins)); px = cl;
    ts.push(Math.floor(t / 1000)); o.push(+op.toFixed(2)); c.push(+cl.toFixed(2)); h.push(+(Math.max(op, cl) * (1 + rnd() * 0.0005)).toFixed(2)); l.push(+(Math.min(op, cl) * (1 - rnd() * 0.0005)).toFixed(2)); v.push(Math.round(1e4 + rnd() * 1e5));
  }
  const last = c.at(-1) || base, prev = c.length > 10 ? c[Math.max(0, c.length - 1 - Math.round(390 / mins))] : base;
  const regStart = new Date(new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" }) + " 09:30:00 GMT-0400").getTime();
  return { chart: { result: [{ meta: { symbol: sym, regularMarketPrice: last, regularMarketTime: ts.at(-1), chartPreviousClose: prev, previousClose: prev, marketState: "REGULAR", shortName: sym, currentTradingPeriod: { regular: { start: Math.floor(regStart / 1000), end: Math.floor(regStart / 1000) + 390 * 60 } } }, timestamp: ts, indicators: { quote: [{ open: o, high: h, low: l, close: c, volume: v }] } }], error: null } };
}
function chain(sym) {
  const spot = sym === "_SPX" || sym === "SPX" ? 7650 : sym === "SPY" ? 760 : 50 + (seedOf(sym) % 400); const options = [];
  const today = new Date(); const exps = [0, 1, 2, 5, 8, 15, 29, 57].map(d => { const e = new Date(today.getTime() + d * 864e5); return e.toISOString().slice(2, 10).replace(/-/g, ""); });
  const step = spot > 1000 ? 25 : spot > 200 ? 5 : 1;
  for (const e of exps) for (let k = Math.round(spot * 0.85 / step) * step; k <= spot * 1.15; k += step) for (const cp of ["C", "P"]) {
    const dist = (k - spot) / spot; const iv = 0.18 + Math.abs(dist) * 0.5; const delta = cp === "C" ? Math.max(0.01, Math.min(0.99, 0.5 - dist * 6)) : -Math.max(0.01, Math.min(0.99, 0.5 + dist * 6));
    options.push({ option: `${sym.replace("_", "")}${e}${cp}${String(Math.round(k * 1000)).padStart(8, "0")}`, open_interest: Math.round(500 + 20000 * Math.exp(-Math.abs(dist) * 30)), volume: Math.round(2000 * Math.exp(-Math.abs(dist) * 40)), iv, gamma: 0.002 * Math.exp(-Math.abs(dist) * 40), delta, bid: 1, ask: 1.1, last_trade_price: 1.05 });
  }
  return { timestamp: new Date().toISOString().replace("T", " ").slice(0, 19), data: { current_price: spot, price_change: -3.2, price_change_percent: -0.4, options } };
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
globalThis.__fakeNet = { calls: [] };
globalThis.fetch = async (url, opts) => {
  const u = String(url); globalThis.__fakeNet.calls.push(u);
  let m = u.match(/finance\/chart\/([^?]+)\?interval=(\w+)&range=(\w+)&includePrePost=(\w+)/);
  if (m) return json(series(decodeURIComponent(m[1]), m[2], m[3], m[4] === "true"));
  m = u.match(/delayed_quotes\/options\/([^.]+)\.json/);
  if (m) return json(chain(m[1]));
  if (/api\.github\.com/.test(u)) return new Response("", { status: 204 });
  return new Response("not here", { status: 404 });
};
