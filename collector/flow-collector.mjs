// Undertow flow collector — run this on your own machine or a small VPS during market hours.
//   POLYGON_KEY=... FLOW_SECRET=... SITE_URL=https://yoursite node collector/flow-collector.mjs SPY QQQ NVDA
// Subscribes to Polygon's options trade stream (needs an options plan with trades), classifies each print
// (sweep / block / aggressor side vs the quote), and ships batches to /api/flow every 2 seconds.
// Trade shape sent: {t, u (underlying), o (occ), exp, K, cp, px, sz, prem, side ("A"/"B"/"M"), kind ("sweep"|"block"|"trade"), ex}
import WebSocket from "ws";

const KEY = process.env.POLYGON_KEY, SECRET = process.env.FLOW_SECRET, SITE = (process.env.SITE_URL || "").replace(/\/$/, "");
const under = process.argv.slice(2).map(s => s.toUpperCase());
if (!KEY || !SECRET || !SITE || !under.length) { console.error("Usage: POLYGON_KEY FLOW_SECRET SITE_URL node flow-collector.mjs SPY QQQ ..."); process.exit(1); }

const MIN_PREM = Number(process.env.MIN_PREMIUM || 25000);  // ignore prints under $25k premium
const quotes = new Map(); // occ -> {bid, ask}
let batch = [];

function parseOcc(o) { const m = o.match(/^O:([A-Z]+)(\d{6})([CP])(\d{8})$/); if (!m) return null; return { u: m[1].replace(/W$/, ""), exp: `20${m[2].slice(0, 2)}-${m[2].slice(2, 4)}-${m[2].slice(4, 6)}`, cp: m[3], K: Number(m[4]) / 1000 }; }
function side(px, q) { if (!q) return "M"; if (px >= q.ask) return "A"; if (px <= q.bid) return "B"; return "M"; }

const ws = new WebSocket("wss://socket.polygon.io/options");
ws.on("open", () => { ws.send(JSON.stringify({ action: "auth", params: KEY })); });
ws.on("message", raw => {
  for (const m of JSON.parse(raw)) {
    if (m.ev === "status" && m.status === "auth_success") { ws.send(JSON.stringify({ action: "subscribe", params: under.flatMap(u => [`T.O:${u}*`, `Q.O:${u}*`]).join(",") })); console.log("subscribed", under.join(" ")); }
    if (m.ev === "Q") quotes.set(m.sym, { bid: m.bp, ask: m.ap });
    if (m.ev === "T") {
      const p = parseOcc(m.sym); if (!p) continue;
      const prem = m.p * m.s * 100; if (prem < MIN_PREM) continue;
      const conds = m.c || [];
      const kind = conds.includes(209) ? "sweep" : m.s >= 500 ? "block" : "trade"; // 209 = intermarket sweep in Polygon's condition codes
      batch.push({ t: m.t, u: p.u, o: m.sym, exp: p.exp, K: p.K, cp: p.cp, px: m.p, sz: m.s, prem: Math.round(prem), side: side(m.p, quotes.get(m.sym)), kind, ex: m.x });
    }
  }
});
ws.on("error", e => console.error("ws", e.message));
ws.on("close", () => { console.log("socket closed, exiting so your supervisor restarts it"); process.exit(1); });

setInterval(async () => {
  if (!batch.length) return;
  const trades = batch; batch = [];
  try { const r = await fetch(`${SITE}/api/flow`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ trades }) }); if (!r.ok) console.error("ship", r.status); else process.stdout.write(`.${trades.length}`); }
  catch (e) { console.error("ship", e.message); batch = trades.concat(batch).slice(-2000); }
}, 2000);
