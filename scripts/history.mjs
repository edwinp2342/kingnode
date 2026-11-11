// Long daily history for the Lab: ten years of split- and dividend-adjusted daily bars per core symbol, from Yahoo's chart API, in
// compact rows, refreshed weekly. One file per symbol at data/hist/SYM.json and a directory at data/hist/index.json.
//
// Adjustment: Yahoo's adjclose folds splits and dividends into the close; the same ratio (adjclose / close) is applied to open, high
// and low so a backtest sees total-return prices with no artificial gaps. The raw close rides along as the last column, so a level
// that mattered at the time (a strike, a wall) can still be read. The live day is not here — the app merges SYM-daily.json for that.
import fs from "node:fs";
import { readJSON, writeJSON } from "./market.mjs";

export const HIST_VERSION = 1;
const YAHOO = { SPX: "^GSPC", NDX: "^NDX", RUT: "^RUT", VIX: "^VIX", DJX: "^DJI", XSP: "^GSPC" };
const ALIAS = { "BRK.B": "BRK-B", "BF.B": "BF-B", SQ: "XYZ" };
const r4 = v => Math.round(v * 1e4) / 1e4;
const etDay = t => new Date(t).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export async function fetchHistory(sym, { range = "10y", fetchImpl = fetch } = {}) {
  const y = YAHOO[sym] || ALIAS[sym] || sym;
  const r = await fetchImpl(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?interval=1d&range=${range}&includePrePost=false&events=div%2Csplits`, { headers: { "user-agent": "Mozilla/5.0 (Kingnode)" }, signal: AbortSignal.timeout(30000) });
  if (r.status === 429) throw new Error("429");
  if (!r.ok) throw new Error("http " + r.status);
  const j = await r.json(); const res0 = j.chart?.result?.[0]; const q = res0?.indicators?.quote?.[0]; const adj = res0?.indicators?.adjclose?.[0]?.adjclose;
  if (!res0?.timestamp || !q) throw new Error("no bars");
  return normalizeHistory(sym, res0.timestamp, q, adj, res0.meta || {}, res0.events || {}, range);
}

// Yahoo's arrays → rows [t, o, h, l, c, v, rawClose], adjusted, one row per session (the live day's partial row is dropped —
// SYM-daily.json carries today), nulls skipped.
export function normalizeHistory(sym, ts, q, adj, meta = {}, events = {}, range = "10y") {
  const div = sym === "XSP" ? 10 : 1; const rows = []; const today = etDay(Date.now());
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i], o = q.open?.[i], h = q.high?.[i], l = q.low?.[i]; if (c == null || o == null || h == null || l == null || !(c > 0)) continue;
    const f = adj?.[i] != null && adj[i] > 0 ? adj[i] / c : 1; const t = ts[i] * 1000; const day = etDay(t);
    if (day === today && meta.regularMarketTime && (meta.regularMarketTime * 1000) < (meta.currentTradingPeriod?.regular?.end || 0) * 1000) continue; /* a session still running is not history */
    if (rows.length && etDay(rows[rows.length - 1][0]) === day) rows.pop(); // same-day duplicate: keep the later row
    rows.push([t, r4(o * f / div), r4(h * f / div), r4(l * f / div), r4(c * f / div), q.volume?.[i] || 0, r4(c / div)]);
  }
  const splits = Object.values(events.splits || {}).map(s => ({ date: s.date * 1000, ratio: s.numerator && s.denominator ? +(s.numerator / s.denominator).toFixed(4) : null, text: s.splitRatio || null })).sort((a, b) => a.date - b.date);
  const dividends = Object.values(events.dividends || {}).map(d => ({ date: d.date * 1000, amount: d.amount })).sort((a, b) => a.date - b.date);
  return { v: HIST_VERSION, symbol: sym, interval: "1d", range, adjusted: "split+dividend: Yahoo adjclose ÷ close applied to o/h/l/c; raw close in the last column", cols: "t o h l c v rawClose", source: "yahoo", currency: meta.currency || null, exchange: meta.exchangeName || null, bars: rows, splits, dividends, first: rows[0]?.[0] ?? null, last: rows[rows.length - 1]?.[0] ?? null, snapshotAt: Date.now() };
}

// Refresh the symbols that are missing or older than maxAgeDays, a batch at a time, spaced so Yahoo does not answer 429. Returns what
// happened so the feed can log it and back off on a limit.
export async function refreshHistory({ syms, dir = "data/hist", maxPerRun = 40, maxAgeDays = 7, spacingMs = 1200, fetchImpl = fetch, log = console.log } = {}) {
  fs.mkdirSync(dir, { recursive: true }); const idxPath = `${dir}/index.json`; const idx = readJSON(idxPath, { v: HIST_VERSION, at: 0, syms: {} }); idx.syms ||= {};
  const stale = syms.filter(s => { const e = idx.syms[s]; return !e || !fs.existsSync(`${dir}/${s}.json`) || Date.now() - (e.at || 0) > maxAgeDays * 86400e3 || e.v !== HIST_VERSION; });
  const todo = stale.slice(0, maxPerRun); let fetched = 0, failed = 0, limited = false; const errors = [];
  for (const sym of todo) {
    try { const h = await fetchHistory(sym, { fetchImpl }); if (h.bars.length < 50) throw new Error("short history " + h.bars.length);
      writeJSON(`${dir}/${sym}.json`, h); idx.syms[sym] = { v: HIST_VERSION, n: h.bars.length, first: h.first, last: h.last, at: h.snapshotAt, splits: h.splits.length, dividends: h.dividends.length }; fetched++; }
    catch (e) { failed++; errors.push(`${sym}:${e.message}`); if (/429/.test(e.message)) { limited = true; break; } }
    if (spacingMs) await new Promise(r => setTimeout(r, spacingMs));
  }
  idx.at = Date.now(); idx.n = Object.keys(idx.syms).length; idx.cols = "t o h l c v rawClose"; idx.note = "ten years of adjusted daily bars per symbol (hist/SYM.json), refreshed weekly; the live day comes from SYM-daily.json"; writeJSON(idxPath, idx);
  const remaining = stale.length - todo.length + (limited ? todo.length - fetched - failed : 0);
  if (fetched || failed) log(`history: ${fetched} refreshed, ${failed} failed${limited ? " (429 — backing off)" : ""}, ${remaining} to go of ${syms.length}${errors.length ? " · " + errors.slice(0, 4).join(" ") : ""}`);
  return { fetched, failed, limited, remaining, total: syms.length, have: idx.n };
}
