// Snapshots the chains, bars and quotes the terminal needs and writes them to ./data as compact JSON.
// Run by .github/workflows/data.yml every 5 minutes during market hours (free on a public repo), pushed to the `data` branch,
// read by the site from raw.githubusercontent.com — which allows browser requests. No server, no proxy, no laptop.
import { fetchChain, fetchBars } from "../api/_lib/data.js";
import fs from "node:fs";

const SYMS = (process.env.SNAPSHOT_SYMBOLS || "SPX,SPY,QQQ,IWM,VIX,NDX,RUT,DIA,TLT,NVDA,TSLA,AAPL,AMZN,MSFT,META,GOOGL,AMD,TSM,GLD,SLV").split(",").map(s => s.trim()).filter(Boolean);
const TAPE = ["SPX","NDX","RUT","VIX","SPY","QQQ","IWM","DIA"];
fs.mkdirSync("data", { recursive: true });
const quotes = []; const ok = [], fail = [];
for (const sym of SYMS) {
  try {
    const c = await fetchChain(sym);
    const exps = [...new Set(c.rows.map(r => r[0]))].sort().slice(0, 10), keep = new Set(exps);
    const rows = c.rows.filter(r => keep.has(r[0]) && Math.abs(r[2] / c.spot - 1) <= 0.2).map(r => r.map((v, i) => typeof v === "number" && i >= 3 ? +v.toPrecision(6) : v));
    fs.writeFileSync(`data/${sym}.json`, JSON.stringify({ ...c, rows, snapshotAt: Date.now() }));
    if (TAPE.includes(sym)) quotes.push({ symbol: sym, price: c.spot, prev: c.spot - (c.change || 0), last: c.spot, t: Date.now() });
    ok.push(sym);
  } catch (e) { fail.push(`${sym}:${e.message}`); }
  try { const b = await fetchBars(sym, "5m", "5d", true); fs.writeFileSync(`data/${sym}-bars.json`, JSON.stringify({ ...b, bars: b.bars.slice(-800), snapshotAt: Date.now() })); } catch {}
  try { const d = await fetchBars(sym, "1d", "1y", false); fs.writeFileSync(`data/${sym}-daily.json`, JSON.stringify({ ...d, bars: d.bars.slice(-300), snapshotAt: Date.now() })); } catch {}
}
if (quotes.find(q => q.symbol === "SPX")) { const s = quotes.find(q => q.symbol === "SPX"); quotes.push({ symbol: "XSP", price: s.price / 10, prev: s.prev / 10, last: s.last / 10, t: s.t }); }
fs.writeFileSync("data/quotes.json", JSON.stringify({ at: Date.now(), quotes }));
fs.writeFileSync("data/index.json", JSON.stringify({ at: Date.now(), ok, fail }));
console.log("ok", ok.join(","), fail.length ? "fail " + fail.join(" ") : "");
