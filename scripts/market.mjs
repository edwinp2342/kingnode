// Market-wide data for the feed: every listed US symbol, which of them have listed options, a price sweep across the
// optionable universe, and a nightly 60-day close series per optionable name. All from sources GitHub Actions can reach
// without a key (probed 2026-10-15: Nasdaq Trader's symbol directory and Cboe's symbol directory are open; Nasdaq's
// screener/IPO APIs and the SEC's ticker file block Actions runners; Yahoo's batch quote needs a crumb, its chart does not).
//
//   symbols.json  — every US-listed common stock and ETF: [sym, name, exchange, etf, optionable]; firstSeen per symbol, so a
//                   new listing shows up the day Nasdaq lists it (the IPO watch); updated hourly
//   market.json   — last / prevClose / change% / volume for every optionable name, swept every few minutes in regular hours
//   closes.json   — 60 daily closes per optionable name, once per session after the close (trend / RSI for any name)
import fs from "node:fs";

const UA = "Mozilla/5.0 (Kingnode feed; +https://github.com/edwinp2342/kingnode)";
const YAHOO = { SPX: "^GSPC", NDX: "^NDX", RUT: "^RUT", VIX: "^VIX", DJX: "^DJI", XSP: "^GSPC" };
const ALIAS = { "BRK.B": "BRK-B", "BF.B": "BF-B" };
const ySym = s => YAHOO[s] || ALIAS[s] || s.replace(".", "-");

export function readJSON(path, fallback) { try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return fallback; } }
// write to a temp file and rename, so a push that lands mid-write never ships half a file
export function writeJSON(path, obj) { const tmp = path + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, path); }

// ---------- symbol directory ----------
// Nasdaq Trader lists everything that trades on US exchanges (Nasdaq, NYSE, NYSE American, NYSE Arca, Cboe BZX), refreshed nightly.
// Kept: common stock and ETFs. Dropped: test issues, warrants, rights, units, preferreds, notes and symbols with suffixes ($, =, ^ ...).
export async function fetchSymbolDirectory() {
  const r = await fetch("https://www.nasdaqtrader.com/dynamic/symdir/nasdaqtraded.txt", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("nasdaqtraded http " + r.status);
  const txt = await r.text(); const lines = txt.split("\n"); const head = lines[0].split("|"); const col = n => head.indexOf(n);
  const iSym = col("Symbol"), iName = col("Security Name"), iEx = col("Listing Exchange"), iEtf = col("ETF"), iTest = col("Test Issue"), iFin = col("Financial Status"), iTraded = col("Nasdaq Traded");
  const EX = { N: "NYSE", Q: "NASDAQ", A: "NYSE American", P: "NYSE Arca", Z: "Cboe BZX", V: "IEX" };
  const out = [];
  for (const line of lines.slice(1)) {
    const f = line.split("|"); if (f.length < 8) continue;
    const sym = f[iSym], name = (f[iName] || "").trim();
    if (!sym || f[iTraded] !== "Y" || f[iTest] === "Y") continue;
    if (/[$=^~]/.test(sym) || sym.length > 5) continue;                                            // preferreds, when-issued, rights and other suffixed classes
    if (/\b(warrant|warrants|right|rights|unit|units|preferred|notes?|debenture|trust preferred|depositary|%|due 20)\b/i.test(name)) continue;
    if (/\.(W|R|U|WS|RT|P[A-Z]?)$/.test(sym)) continue;
    const etf = f[iEtf] === "Y";
    const cleanName = name.replace(/ - (Common Stock|Class A Common Stock|Class B Common Stock|Class C Common Stock|American Depositary Shares|Ordinary Shares|Common Shares).*$/i, "").replace(/ (Common Stock|Class A Ordinary Shares|Ordinary Shares)$/i, "").trim();
    out.push([sym, cleanName.slice(0, 60), EX[f[iEx]] || f[iEx] || "", etf ? 1 : 0, 0]);
  }
  if (out.length < 3000) throw new Error("directory looks truncated: " + out.length);
  return out;
}
// Cboe's directory of every equity and index with listed options.
export async function fetchOptionable() {
  const r = await fetch("https://www.cboe.com/us/options/symboldir/equity_index_options/?download=csv", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error("cboe dir http " + r.status);
  const txt = await r.text(); const set = new Set();
  for (const line of txt.split("\n").slice(1)) { const m = line.match(/^"[^"]*","([^"]+)"/); if (m) set.add(m[1].trim()); }
  if (set.size < 1000) throw new Error("cboe dir looks truncated: " + set.size);
  return set;
}
// Merge the two into data/symbols.json, keeping firstSeen so new listings are visible. The first run ever marks every symbol with the
// bootstrap date and no symbol from that day counts as new; from then on, a symbol that appears is a listing that just happened.
export async function updateSymbols(path = "data/symbols.json") {
  const prev = readJSON(path, null); const today = new Date().toISOString().slice(0, 10);
  const rows = await fetchSymbolDirectory(); let optionable = null; try { optionable = await fetchOptionable(); } catch (e) { console.error("optionable dir", e.message); }
  const firstSeen = { ...(prev?.firstSeen || {}) }; const bootstrap = prev?.bootstrap || today;
  for (const r of rows) { if (!firstSeen[r[0]]) firstSeen[r[0]] = today; if (optionable) r[4] = optionable.has(r[0]) ? 1 : 0; else if (prev?.optionable) r[4] = prev.optionable.includes(r[0]) ? 1 : 0; }
  const live = new Set(rows.map(r => r[0])); for (const s of Object.keys(firstSeen)) if (!live.has(s) && firstSeen[s] < today) { /* delisted: keep the date a while for the record */ }
  const cutoff = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
  const fresh = rows.filter(r => firstSeen[r[0]] >= cutoff && firstSeen[r[0]] !== bootstrap).map(r => [r[0], r[1], firstSeen[r[0]], r[2], r[4]]).sort((a, b) => b[2].localeCompare(a[2]));
  const out = { at: Date.now(), bootstrap, n: rows.length, nOptionable: rows.filter(r => r[4]).length, cols: "sym name exchange etf optionable", rows, optionable: rows.filter(r => r[4]).map(r => r[0]), new: fresh, newCols: "sym name firstSeen exchange optionable", firstSeen };
  writeJSON(path, out); return out;
}

// ---------- quote sweep over the optionable universe ----------
async function chartMeta(sym, range = "1d", interval = "1m", timeoutMs = 9000) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym(sym))}?interval=${interval}&range=${range}&includePrePost=false`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (r.status === 429) throw new Error("429");
  if (!r.ok) throw new Error("http " + r.status);
  const j = await r.json(); const res0 = j.chart?.result?.[0]; if (!res0?.meta) throw new Error("no meta"); return res0;
}
async function pool(items, size, fn) { let i = 0; const errors = []; const next = async () => { while (i < items.length) { const it = items[i++]; try { await fn(it); } catch (e) { errors.push([it, e.message]); } } }; await Promise.all(Array.from({ length: Math.min(size, items.length) }, next)); return errors; }
// last / previous close / change% / volume for every optionable name. Adaptive: a sweep that trips Yahoo's limiter (429s or many timeouts)
// reports it so the caller spaces the next one out. ~4,000 names at 12 in flight takes about a minute.
export async function sweepMarket(symbols, { concurrency = 12, path = "data/market.json" } = {}) {
  const prev = readJSON(path, null); const q = { ...(prev?.q || {}) }; const t0 = Date.now(); let ok = 0, r429 = 0;
  const errors = await pool(symbols, concurrency, async sym => {
    const res0 = await chartMeta(sym); const m = res0.meta; const last = +m.regularMarketPrice || 0; if (!last) throw new Error("no price");
    const prevC = +(m.chartPreviousClose ?? m.previousClose ?? 0) || null;
    q[sym] = [+last.toFixed(4), prevC ? +prevC.toFixed(4) : null, prevC ? +((last / prevC - 1) * 100).toFixed(2) : null, +(m.regularMarketVolume || 0), (m.regularMarketTime || 0) * 1000, m.marketState || null]; ok++;
  });
  r429 = errors.filter(e => e[1] === "429").length;
  const out = { at: Date.now(), ms: Date.now() - t0, n: symbols.length, ok, fail: errors.length, r429, cols: "last prevClose chgPct volume lastT state", q };
  writeJSON(path, out); return out;
}
// 60 daily closes per optionable name — enough for the 21/50-EMA, RSI and relative-strength rules on any name. Once per session.
export async function sweepCloses(symbols, { concurrency = 10, path = "data/closes.json" } = {}) {
  const prev = readJSON(path, null); const c = { ...(prev?.c || {}) }; const t0 = Date.now(); let ok = 0;
  const errors = await pool(symbols, concurrency, async sym => {
    const res0 = await chartMeta(sym, "4mo", "1d", 12000); const q0 = res0.indicators?.quote?.[0] || {}; const cl = q0.close || [], vol = q0.volume || [], ts = res0.timestamp || [];
    const pts = [], vols = []; for (let i = 0; i < cl.length; i++) if (cl[i] != null) { pts.push(+cl[i].toFixed(3)); vols.push(vol[i] || 0); }
    if (pts.length < 20) throw new Error("short"); c[sym] = pts.slice(-60); ok++; if (ts.length) c[sym + ":t"] = ts[ts.length - 1] * 1000;
    const v20 = vols.slice(-21, -1).filter(v => v > 0); if (v20.length >= 10) c[sym + ":v"] = Math.round(v20.reduce((a, b) => a + b, 0) / v20.length); // 20-day average volume, the session in progress excluded — relative volume for any name
  });
  const out = { at: Date.now(), ms: Date.now() - t0, n: symbols.length, ok, fail: errors.length, cols: "60 daily closes, oldest first; sym:t = stamp of the last bar; sym:v = 20-day average volume", c };
  writeJSON(path, out); return out;
}
// Which optionable names deserve a chain snapshot beyond the fixed list: the most active by dollar volume in the latest sweep.
export function mostActive(market, exclude, limit = 150) {
  if (!market?.q) return [];
  return Object.entries(market.q).filter(([s, v]) => !exclude.has(s) && v[0] >= 5 && v[3] > 0).map(([s, v]) => [s, v[0] * v[3]]).sort((a, b) => b[1] - a[1]).slice(0, limit).map(x => x[0]);
}
