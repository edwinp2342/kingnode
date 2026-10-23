// Snapshots the chains, bars and quotes the terminal needs and writes them to ./data as compact JSON, then pushes.
// Runs as a loop inside one GitHub Actions job (LOOP_MINUTES). Cadence follows the market clock (ET):
//   pre 04:00–09:30 · regular 09:30–16:00 · post 16:00–20:00 · closed otherwise (weekends, NYSE holidays)
//   three loops share the process: FAST (quote + the last 1-minute bars for every core name every 20 s in regular hours, written as
//   time-bucketed live files; the full-session 1-minute series per core name once a minute) · MAIN (5-minute bars for ~300 tickers
//   every cycle while the market is open, with their last three bars in the minute bucket; Cboe chains, 15-min delayed, for the core
//   list every 3rd cycle and for the 150 most active optionable names rolling a dozen per cycle; daily bars every 9th; FINRA short
//   volume hourly) · MARKET (every US-listed symbol hourly with first-seen dates so new listings surface; a price sweep across the
//   ~5,000 optionable names every 5 min; 60 daily closes + 20-day average volume per optionable name once per session).
//   Each loop pushes after it writes; git serializes the pushes.
// A few minutes before the loop ends it dispatches its own successor (workflow_dispatch), so the feed does not depend on
// GitHub firing the hourly cron — which it skips freely. The cron stays as the restarter if a run ever dies.
import { fetchChain, fetchBars } from "../api/_lib/data.js";
import { computeLevels } from "../api/_lib/levels.js";
import { updateSymbols, sweepMarket, sweepCloses, mostActive, computeBreadth, readJSON, writeJSON } from "./market.mjs";
import fs from "node:fs";
import { execSync } from "node:child_process";

const SYMS = (process.env.SNAPSHOT_SYMBOLS || "SPX,SPY,QQQ,IWM,VIX,NDX,RUT,DIA,TLT,NVDA,TSLA,AAPL,AMZN,MSFT,META,GOOGL,AMD,TSM,GLD,SLV,COIN,PLTR,NFLX,XSP,AVGO,MU,ARM,MRVL,INTC,AMAT,LRCX,KLAC,SMH,XLE,XOM,FCX,CAT,CEG,VST,VRT,CRWD,PANW,ANET,ORCL,HOOD,MSTR,UBER,SHOP,LLY,UNH,JPM,BA,GE,DE,HYG,XLF,KRE,XBI,ARKK,IBIT,SOFI,RKLB,IONQ,APP,RDDT,OKLO,BABA,NIO,RIVN,MARA,DELL,ABNB,CMG,COST,WMT,HD,NKE").split(",").map(s => s.trim()).filter(Boolean);
// bars for a much wider list (cheap: one small Yahoo request each), so every ticker in the app has a chart
// every ticker the app knows: its built-in search universe + halal list + the extra list below
const appHtml = fs.readFileSync(new URL("../app.html", import.meta.url), "utf8");
const fromApp = [...appHtml.matchAll(/\["([A-Z.]{2,6})","[^"]+"\]/g)].map(m => m[1]).filter(x => !["ALL","ASK","BID","MID","GEX","VEX","DEX","PRE","POST","ETF"].includes(x)); // 2+ letters: the 1-letter matches are UI labels, and the real 1-letter tickers (F, T, V, C) are listed below
const BAR_SYMS = [...new Set([...SYMS, ...fromApp, ...(process.env.BAR_SYMBOLS || "AVGO,QCOM,TXN,MU,ARM,ASML,AMAT,LRCX,KLAC,INTC,MRVL,ADBE,CRM,ORCL,NOW,CRWD,PANW,NET,DDOG,SNOW,ANET,CSCO,SHOP,ABNB,UBER,LLY,NVO,ISRG,JNJ,MRK,ABBV,AMGN,GILD,PFE,TEM,HIMS,XOM,CVX,COP,OXY,SLB,XLE,XOP,FCX,NEM,CAT,DE,GE,UPS,FDX,VRT,CEG,VST,ENPH,FSLR,PG,COST,WMT,HD,LOW,NKE,LULU,TJX,CMG,ELF,CELH,KO,PEP,RKLB,ASTS,IONQ,RGTI,APP,RDDT,DUOL,SPOT,DIS,JPM,BAC,GS,V,MA,HOOD,DKNG,BA,T,VZ,F,GM,CCL,LMT,RTX,SMH,XLF,KRE,XBI,XLK,XLV,XLI,XLU,XLP,XLY,ARKK,HYG,EEM,FXI,BITO,IBIT,UVXY,SQQQ,TQQQ,SOXL,UUP,SPUS,HLAL,SPSK,MSTR,SOFI,XYZ,PYPL,AFRM,RBLX,DELL,HPQ,IBM,ADP,INTU,WDAY,TEAM,OKTA,ZS,MDB,ZM,TTD,ROKU,MELI,SE,BABA,PDD,JD,NIO,RIVN,LCID,MARA,RIOT,CLSK,OKLO,SMR,LUNR,NRG,CAVA,CRCL,CRWV,NBIS,SBET,MRNA,CVS,BMY,DAL,UAL,AAL,LUV,RCL,MAR,TGT,ISRG,HOOY,NFLY,C").split(",").map(s=>s.trim()).filter(Boolean)])];
// tickers whose app spelling differs from Yahoo's (BRK.B is BRK-B on Yahoo; Block renamed SQ to XYZ)
const YAHOO_ALIAS = { "BRK.B":"BRK-B", "BF.B":"BF-B", SQ:"XYZ" };
const TAPE = ["SPX","NDX","RUT","VIX","SPY","QQQ","IWM","DIA"];
const YAHOO = { SPX:"^GSPC", NDX:"^NDX", RUT:"^RUT", VIX:"^VIX", DJX:"^DJI", XSP:"^GSPC" };
const LOOP_MIN = Number(process.env.LOOP_MINUTES || 0), EVERY = Number(process.env.EVERY_SEC || 60), PUSH = process.env.PUSH === "1";
const HANDOFF_MIN = Number(process.env.HANDOFF_MINUTES || 4);   // dispatch the successor this long before the loop ends
const end = Date.now() + LOOP_MIN * 60e3; const sleep = ms => new Promise(r => setTimeout(r, ms));
// Start from what the last run left on the data branch (daily bars, chains for names not refreshed yet, the scan), without its
// history: the branch is force-pushed as a single commit every cycle, so the repo never accumulates a minute-by-minute history.
function seed() {
  if (fs.existsSync("data/.git")) return;
  if (PUSH && process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
    try { execSync(`git clone -q --depth 1 -b data "https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git" data && rm -rf data/.git`, { stdio: "inherit", shell: "/bin/bash", timeout: 240000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }); console.log(`seeded data/ with ${fs.readdirSync("data").length} files from the data branch`); }
    catch (e) { console.error("seed failed — starting empty", e.message); }
  }
  fs.mkdirSync("data", { recursive: true });
}
seed();

import { marketPhase, etNow } from "./market-clock.mjs";
// what this cycle does, by phase: cadence in seconds, chains every Nth cycle, whether to pull bars at all
const PLAN = {
  regular: { every: EVERY, chainsEvery: 3, bars: true, fast: Number(process.env.FAST_SEC || 20), sweep: 5 * 60, tierB: 15 * 60 },
  pre:     { every: EVERY, chainsEvery: 5, bars: true, fast: 45, sweep: 15 * 60, tierB: 30 * 60 },
  post:    { every: EVERY, chainsEvery: 5, bars: true, fast: 45, sweep: 15 * 60, tierB: 30 * 60 },
  closed:  { every: 600, chainsEvery: 6, bars: false, fast: 600, sweep: 6 * 3600, tierB: 6 * 3600 },
};

// One Yahoo request gives the quote and the whole session of 1-minute bars (pre, regular and post). The fast loop pulls this for every
// core name each tick, so the header quote and the last candles move together every 20 seconds in regular hours.
async function liveFetch(sym) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO[sym] || YAHOO_ALIAS[sym] || sym)}?interval=1m&range=1d&includePrePost=true`, { headers: { "user-agent": "Mozilla/5.0 (Kingnode)" }, signal: AbortSignal.timeout(15000) });
  if (r.status === 429) throw new Error("429");
  if (!r.ok) throw new Error("http " + r.status);
  const j = await r.json(), res0 = j.chart?.result?.[0], m = res0?.meta; if (!m) throw new Error("no meta");
  const q = res0.indicators?.quote?.[0] || {}, closes = (q.close || []), ts = res0.timestamp || [];
  let last = +m.regularMarketPrice || 0, lastT = (m.regularMarketTime || 0) * 1000;
  for (let i = closes.length - 1; i >= 0; i--) if (closes[i] != null) { last = closes[i]; lastT = ts[i] * 1000; break; }
  const price = (YAHOO[sym] && last) ? last : (+m.regularMarketPrice || last), prev = +(m.chartPreviousClose ?? m.previousClose ?? price); // indices: Yahoo's meta price can lag the bars by an hour after the close
  const div = sym === "XSP" ? 10 : 1;
  const bars = []; for (let i = 0; i < ts.length; i++) if (q.close?.[i] != null && q.open?.[i] != null) bars.push([ts[i] * 1000, +(q.open[i] / div).toFixed(4), +(q.high[i] / div).toFixed(4), +(q.low[i] / div).toFixed(4), +(q.close[i] / div).toFixed(4), q.volume?.[i] || 0]);
  const tp = m.currentTradingPeriod || {};
  const session = { regularStart: tp.regular?.start ? tp.regular.start * 1000 : null, regularEnd: tp.regular?.end ? tp.regular.end * 1000 : null, regularPrice: m.regularMarketPrice != null ? m.regularMarketPrice / div : null, regularTime: m.regularMarketTime ? m.regularMarketTime * 1000 : null, prevClose: prev / div, marketState: m.marketState || null, name: m.shortName || m.longName || null };
  return { quote: { symbol: sym, price: price / div, prev: prev / div, last: last / div, state: m.marketState || null, t: lastT, regT: (m.regularMarketTime || 0) * 1000 }, bars, session };
}
async function quote(sym) { return (await liveFetch(sym)).quote; }
// the names the fast loop keeps live: the tape indices plus the whole core chain list (one request each, a dozen in flight)
const LIVE_SYMS = [...new Set([...TAPE, ...SYMS])].filter(s => s !== "XSP");
const LIVE_BARS_KEEP = Number(process.env.LIVE_BARS || 8);   // minutes of 1-minute bars carried in each live bucket — enough to bridge the CDN's five-minute cache on SYM-1m.json

// ---------- FINRA off-exchange (dark pool / ATS) short volume: real, daily, free ----------
let svAt = 0;
async function shortVolume() {
  const want = new Set(BAR_SYMS); const days = {};
  const d = new Date(); let got = 0, tries = 0;
  while (got < 10 && tries < 18) {
    d.setUTCDate(d.getUTCDate() - (tries ? 1 : 0)); tries++;
    const key = d.toISOString().slice(0, 10).replace(/-/g, "");
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    try {
      const r = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${key}.txt`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) continue;
      const txt = await r.text(); let n = 0;
      for (const line of txt.split("\n")) { const f = line.split("|"); if (f.length < 5 || !want.has(f[1])) continue; (days[f[1]] ||= []).push([f[0].replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"), +f[2], +f[4]]); n++; }
      if (n) got++;
    } catch {}
  }
  if (!got) throw new Error("no finra files");
  for (const s in days) days[s].sort((a, b) => a[0].localeCompare(b[0]));
  fs.writeFileSync("data/shortvol.json", JSON.stringify({ at: Date.now(), source: "finra-cnms", days }));
  svAt = Date.now(); return got;
}

let chainAt = 0, barsAt = 0, dispatched = false; const universe = {}; const lastBars = {}; const scan = {};
try { const prev = JSON.parse(fs.readFileSync("data/scan.json", "utf8")); const cutoff = Date.now() - 26 * 3600e3; for (const [sym, r] of Object.entries(prev.rows || {})) if (r && r.at > cutoff) scan[sym] = r; console.log(`scan seeded with ${Object.keys(scan).length} rows from the branch`); } catch {} // a restart keeps yesterday's tier-B rows until they roll around again
// The close of the session before the latest one, from the 5-minute bars: Yahoo's chartPreviousClose on a 5-day request is the close
// before the whole window (five sessions back), which made the movers list show multi-day moves as "today".
const ET_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
function etParts(ts) { const p = ET_FMT.formatToParts(new Date(ts)); const g = t => p.find(x => x.type === t)?.value; return { date: `${g("year")}-${g("month")}-${g("day")}`, min: (Number(g("hour")) % 24) * 60 + Number(g("minute")) }; }
export function prevSessionClose(bars, session) {
  if (!bars?.length) return null;
  const latest = session?.regularStart ? etParts(session.regularStart).date : etParts(bars[bars.length - 1][0]).date;
  let prev = null; for (const b of bars) { const e = etParts(b[0]); if (e.date >= latest) break; if (e.min >= 570 && e.min < 960) prev = b; } // last regular-session bar of the session before
  return prev ? +prev[4].toFixed(4) : (session?.prevClose != null ? +(+session.prevClose).toFixed(4) : null);
}
// Yahoo's 1-year daily series often lacks the session in progress (and the one just closed) until late evening; build that bar from
// the 5-minute regular-session bars so trend, RSI and realized vol see today.
export function withToday(daily, intraday, session) {
  if (!daily?.length || !intraday?.length || !session?.regularStart || !session?.regularEnd) return daily || [];
  const reg = intraday.filter(b => b[0] >= session.regularStart && b[0] < session.regularEnd); if (!reg.length) return daily;
  const bar = [session.regularStart, reg[0][1], Math.max(...reg.map(b => b[2])), Math.min(...reg.map(b => b[3])), reg[reg.length - 1][4], reg.reduce((a, b) => a + (b[5] || 0), 0)];
  const day = t => new Date(t).toISOString().slice(0, 10); const last = daily[daily.length - 1];
  if (day(last[0]) === day(bar[0])) return [...daily.slice(0, -1), bar]; if (day(last[0]) < day(bar[0])) return [...daily, bar]; return daily;
}
// One compact line per chain ticker for the desk assistant and the scanner: where the options money went today, the unusual
// contract, ATM IV, and the levels. Computed from the full chain while it is in memory, so the app never has to pull 80 files.
// Which side of the quote a print hit — only when the last price sits inside the current spread; outside it the quote moved since the trade and the side is unknowable.
function printSide(last, bid, ask) { if (!last || !bid || !ask || ask < bid) return "M"; const tol = Math.max(0.05, last * 0.01); if (last > ask + tol || last < bid - tol) return "M"; if (last >= ask - tol) return "A"; if (last <= bid + tol) return "B"; return "M"; }
function scanRow(c0) {
  const t = etNow(); const c = { ...c0, rows: c0.rows.filter(r => r[0] > t.date || (r[0] === t.date && t.min < 16 * 60)) }; // settled expiries are not positioning
  const spot = c.spot; let cVol = 0, pVol = 0, cPrem = 0, pPrem = 0; const contracts = [];
  for (const r of c.rows) { const [exp, type, K, oi, vol, iv, , delta, bid, ask, last] = r; if (!vol) continue; const mid = bid && ask ? (bid + ask) / 2 : (last || bid || ask); const px = last || mid; if (!px) continue;
    const prem = px * vol * 100; if (type === "C") { cVol += vol; cPrem += prem; } else { pVol += vol; pPrem += prem; }
    contracts.push({ exp, type, K, vol, oi, prem, side: printSide(last, bid, ask), deep: Math.abs(delta || 0) >= 0.9, volOi: oi ? vol / oi : null }); }
  const dir = contracts.filter(x => !x.deep);
  const top = dir.sort((a, b) => b.prem - a.prem).slice(0, 3).map(x => [x.exp, x.type, x.K, x.vol, x.oi, Math.round(x.prem), x.side]);
  const exps = [...new Set(c.rows.map(r => r[0]))].sort(); const dte = e => Math.round((Date.parse(e + "T16:00:00-04:00") - Date.now()) / 86400000);
  const byUn = dir.filter(x => x.vol >= 300 && x.oi >= 50).sort((a, b) => (b.volOi || 0) - (a.volOi || 0));
  const un = byUn.find(x => dte(x.exp) >= 4) || byUn[0]; // a brand-new weekly always trades many times its day-old OI; prefer something with a few days on it
  const e30 = exps.find(e => dte(e) >= 20) || exps.at(-1); const near = c.rows.filter(r => r[0] === e30 && r[5] > 0); const atm = near.length ? near.reduce((a, r) => Math.abs(r[2] - spot) < Math.abs(a[2] - spot) ? r : a, near[0]) : null;
  let lv = {}; try { lv = computeLevels(c, 6, 8, "standard"); } catch {}
  return { spot: +spot.toFixed(2), chg: +(+c.changePct || 0).toFixed(2), cVol, pVol, cPrem: Math.round(cPrem), pPrem: Math.round(pPrem), top, unusual: un ? [un.exp, un.type, un.K, un.vol, un.oi, un.side, +un.volOi.toFixed(1)] : null, iv30: atm ? +(+atm[5]).toFixed(3) : null, pw: lv.putWall ?? null, flip: lv.flip ?? null, cw: lv.callWall ?? null, em: lv.expectedMove != null ? +lv.expectedMove.toFixed(2) : null, emExp: lv.nearest || null, gex: lv.total != null ? Math.round(lv.total) : null };
}
// One row per ticker per day of the levels the Ideas engine leans on (walls, flip, gamma, expected move, IV, flow) — the branch is force-pushed
// as a single commit each cycle, so this file is the only history that survives. The last chain of the day wins, so each row is the closing state.
// After a few weeks scripts/backtest.mjs can test whether "above the flip" and "put wall within 2%" actually pay (today they are an unmeasured overlay).
const LEVELS_FILE = "data/levels-history.json";
function recordLevels(scan) {
  try {
    let h = { cols: "spot chg cw pw flip gex em iv30 cVol pVol cPrem pPrem emExp", days: {} };
    try { const old = JSON.parse(fs.readFileSync(LEVELS_FILE, "utf8")); if (old && old.days) h = old; } catch {}
    const t = etNow(); const key = t.date; const row = {};
    for (const [sym, r] of Object.entries(scan)) row[sym] = [r.spot, r.chg, r.cw, r.pw, r.flip, r.gex, r.em, r.iv30, r.cVol, r.pVol, r.cPrem, r.pPrem, r.emExp || null]; // emExp: which expiry the expected move was for, so the app can score it against the next close
    h.days[key] = { ...(h.days[key] || {}), ...row, _at: Date.now() };
    const keys = Object.keys(h.days).sort(); for (const k of keys.slice(0, Math.max(0, keys.length - 420))) delete h.days[k]; // ~20 months, a few hundred KB
    fs.writeFileSync(LEVELS_FILE, JSON.stringify(h));
  } catch (e) { console.error("levels history", e.message); }
}
async function cycle(n, ph) {
  const t0 = Date.now(); const ok = [], fail = []; const plan = PLAN[ph];
  if (n === 0) await fastTick(ph); // the first cycle also writes the tape, so a fresh run never shows an empty header
  // bars for every ticker in the app, 8 at a time (not while closed: nothing moves, and the files already hold the last session)
  if (plan.bars || n === 0) { // cycle 0 always pulls bars so a run that starts overnight still has every chart
    for (let i = 0; i < BAR_SYMS.length; i += 8) {
      await Promise.all(BAR_SYMS.slice(i, i + 8).map(async sym => {
        const ysym = YAHOO_ALIAS[sym] || sym; let b = null;
        try {
          b = await fetchBars(ysym, "5m", "5d", true);
          fs.writeFileSync(`data/${sym}-bars.json`, JSON.stringify({ ...b, symbol: sym, bars: b.bars.slice(-800), snapshotAt: Date.now() }));
          const lastBar = b.bars.at(-1); const s = b.session || {};
          if (lastBar) { universe[sym] = [+lastBar[4].toFixed(4), prevSessionClose(b.bars, s), lastBar[0], s.regularPrice != null ? +(+s.regularPrice).toFixed(4) : null, s.marketState || null]; lastBars[sym] = b.bars.slice(-3).map(r => [r[0], +r[1].toFixed(4), +r[2].toFixed(4), +r[3].toFixed(4), +r[4].toFixed(4), r[5] || 0]); }
        } catch (e) { fail.push(`b:${sym}`); }
        if (n % 9 === 0) { try { const d = await fetchBars(ysym, "1d", "1y", false); fs.writeFileSync(`data/${sym}-daily.json`, JSON.stringify({ ...d, symbol: sym, bars: withToday(d.bars.slice(-300), b?.bars, b?.session), snapshotAt: Date.now() })); } catch (e) { fail.push(`d:${sym}`); } }
      }));
    }
    barsAt = Date.now();
    // one file with last/prev/regular price for every ticker — watchlist, halal screen, movers and the scanner read this instead of 300 files —
    // plus the last three 5-minute bars per name, so any chart in the app can patch its last candles from the minute bucket while SYM-bars.json sits in the CDN cache
    { const doc = { at: barsAt, phase: ph, cols: ["last", "prevClose", "lastT", "regularPrice", "state"], q: universe, bars: lastBars, barsCols: "t open high low close volume (5-minute, last three)" }; writeJSON("data/universe.json", doc); liveWrite("u", 60, doc); }
  }
  // chains: the core list every Nth cycle, four in flight; the most active optionable names (tier B, from the market sweep) on their own clock
  const snapChain = async (sym, nExp, range) => { const c = await fetchChain(sym); const exps = [...new Set(c.rows.map(r => r[0]))].sort().slice(0, nExp), keep = new Set(exps);
    const rows = c.rows.filter(r => keep.has(r[0]) && Math.abs(r[2] / c.spot - 1) <= range).map(r => r.map((v, i) => typeof v === "number" && i >= 3 ? +v.toPrecision(6) : v));
    writeJSON(`data/${sym}.json`, { ...c, rows, snapshotAt: Date.now() }); try { scan[sym] = { ...scanRow(c), at: Date.now() }; } catch (e) { console.error("scan", sym, e.message); } };
  // Cboe's CDN rate-limits bursts (four in flight drew 429s on half of tier B): two in flight, a short gap between pairs, one retry after a pause on a 429
  const chainBatch = async (list, nExp, range, tag, width = 2, gapMs = 250) => { let r429 = 0; for (let i = 0; i < list.length; i += width) { await Promise.all(list.slice(i, i + width).map(async sym => { for (let attempt = 0; attempt < 2; attempt++) { try { await snapChain(sym, nExp, range); ok.push(sym); return; } catch (e) { if (/429/.test(e.message) && attempt === 0) { r429++; await sleep(2500); continue; } fail.push(`${tag}:${sym}:${e.message}`); return; } } })); if (r429 >= 3) { fail.push(`${tag}:rate-limited after ${i + width}`); break; } await sleep(gapMs); } return r429; };
  if (n % plan.chainsEvery === 0) await chainBatch(SYMS, 8, 0.15, "c", 1, 300);
  // tier B rolls: the list of the 150 most active names is re-picked from the sweep every 15 min, and every cycle takes the next dozen —
  // a steady ~12 chains a minute instead of a 150-request burst that Cboe's limiter answered with 429s
  if (!tierBList.length || Date.now() - tierBAt > plan.tierB * 1000) { const market = readJSON("data/market.json", null); const tierB = mostActive(market, new Set(SYMS), Number(process.env.TIER_B || 150)); if (tierB.length) { tierBList = tierB; tierBAt = Date.now(); tierBPos = tierBPos % tierB.length; } }
  if (tierBList.length) { const per = Number(process.env.TIER_B_PER_CYCLE || 12); const slice = []; for (let i = 0; i < Math.min(per, tierBList.length); i++) slice.push(tierBList[(tierBPos + i) % tierBList.length]);
    const r429 = await chainBatch(slice, 6, 0.12, "cb", 1, 350); if (r429 < 3) tierBPos = (tierBPos + slice.length) % tierBList.length; /* rate-limited: the same dozen go again next cycle */ }
  if (ok.length) { chainAt = Date.now(); writeJSON("data/scan.json", { at: Date.now(), phase: ph, cols: "spot chg cVol pVol cPrem pPrem top[exp,type,K,vol,oi,prem,side] unusual[exp,type,K,vol,oi,side,volOi] iv30 pw flip cw em emExp gex", core: SYMS, tierB: tierBList, rows: scan }); recordLevels(scan); }
  if (Date.now() - svAt > 3600e3) { try { const g = await shortVolume(); console.log(`short volume: ${g} days`); } catch (e) { svAt = Date.now() - 3600e3 + 900e3; fail.push(`sv:${e.message}`); } }
  const loopEnd = end; const nextIn = plan.every * 1000;
  writeIndex({ cycle: n, phase: ph, chainAt, barsAt, next: nextIn, loopEnd, ok, fail });
  await watchdog(n, ok, fail, ph);
  console.log(`cycle ${n} · ${ph} · ${((Date.now() - t0) / 1000).toFixed(1)}s · chains ${ok.length}${fail.length ? " · fail " + fail.slice(0, 12).join(" ") + (fail.length > 12 ? ` +${fail.length - 12}` : "") : ""}`);
  if (PUSH) push();
}
let tierBAt = 0, tierBList = [], tierBPos = 0, fastAt = 0, sweepAt = 0, symbolsAt = 0, closesFor = ""; const status = { fast: null, sweep: null, symbols: null, closes: null, breadth: null, push: null };
// GitHub's raw CDN caches every path for five minutes and ignores the query string (x-cache: HIT on a unique ?t= — measured 2026-10-20), so a
// file rewritten every 20 s reaches a browser every 5 min. A path that changes with time is a cache miss every time: the tape is also written
// as live/q-<20-second bucket>.json and the universe as live/u-<minute bucket>.json; the app asks for the bucket a little behind "now" and
// falls back to the plain file. Old buckets are deleted so the branch stays small.
function liveWrite(kind, secs, doc) {
  try { fs.mkdirSync("data/live", { recursive: true }); const b = Math.floor(Date.now() / (secs * 1000)); writeJSON(`data/live/${kind}-${b}.json`, doc);
    for (const f of fs.readdirSync("data/live")) { const m = f.match(/^([qu])-(\d+)\.json$/); if (m && m[1] === kind && b - Number(m[2]) > (kind === "q" ? 9 : 4)) fs.unlinkSync(`data/live/${f}`); } } catch (e) { console.error("live write", e.message); }
}
const indexState = {}; // the last main-cycle numbers, so the fast loop can rewrite index.json without losing them
function writeIndex(patch) { Object.assign(indexState, patch); writeJSON("data/index.json", { at: Date.now(), ...indexState, run: process.env.GITHUB_RUN_ID || null, ...status, tierB: tierBList.length }); }
// FAST: the live tape. One Yahoo request per core name (a dozen in flight) and one push — the header quote for every core name and the
// last candles of its chart move every 20 seconds in regular hours. The bucket carries the quotes plus the last few 1-minute bars per name;
// the whole session of 1-minute bars goes to SYM-1m.json once a minute (that file rides the CDN's five-minute cache, the bucket bridges it).
let oneMinAt = 0;
async function fastTick(ph) {
  const t0 = Date.now(); const quotes = []; const bars = {}; const fail = []; const full = {}; let r429 = 0;
  let i = 0; const worker = async () => { while (i < LIVE_SYMS.length) { const sym = LIVE_SYMS[i++]; try { const d = await liveFetch(sym); quotes.push(d.quote); if (d.bars.length) { bars[sym] = d.bars.slice(-LIVE_BARS_KEEP); full[sym] = d; } } catch (e) { if (e.message === "429") r429++; fail.push(`q:${sym}:${e.message}`); } } };
  await Promise.all(Array.from({ length: Math.min(12, LIVE_SYMS.length) }, worker));
  const spx = quotes.find(q => q.symbol === "SPX"); if (spx) { quotes.push({ ...spx, symbol: "XSP", price: spx.price / 10, prev: spx.prev / 10, last: spx.last / 10 }); if (bars.SPX) bars.XSP = bars.SPX.map(b => [b[0], +(b[1] / 10).toFixed(4), +(b[2] / 10).toFixed(4), +(b[3] / 10).toFixed(4), +(b[4] / 10).toFixed(4), b[5]]); }
  if (quotes.length) { const doc = { at: Date.now(), phase: ph, quotes, bars, barsCols: "t open high low close volume (1-minute, last few)" }; writeJSON("data/quotes.json", doc); liveWrite("q", 20, doc); }
  if (Object.keys(full).length && Date.now() - oneMinAt >= 55000) { // the full-session 1-minute series, once a minute
    for (const [sym, d] of Object.entries(full)) writeJSON(`data/${sym}-1m.json`, { symbol: sym, interval: "1m", range: "1d", extended: true, source: "yahoo", delayed: true, bars: d.bars.slice(-1000), session: d.session, snapshotAt: Date.now() });
    if (full.SPX) writeJSON("data/XSP-1m.json", { symbol: "XSP", interval: "1m", range: "1d", extended: true, source: "yahoo", delayed: true, bars: bars.XSP ? full.SPX.bars.slice(-1000).map(b => [b[0], +(b[1] / 10).toFixed(4), +(b[2] / 10).toFixed(4), +(b[3] / 10).toFixed(4), +(b[4] / 10).toFixed(4), b[5]]) : [], session: full.SPX.session, snapshotAt: Date.now() });
    oneMinAt = Date.now();
  }
  fastAt = Date.now(); status.fast = { at: fastAt, ms: Date.now() - t0, n: quotes.length, bars: Object.keys(bars).length, fail: fail.slice(0, 12), nFail: fail.length, r429 };
  if (r429 >= 10) fastAt = Date.now() + 40000; // Yahoo pushed back: skip two ticks
  return quotes.length;
}
async function fastLoop() {
  while (Date.now() < end) {
    const ph = marketPhase(); const every = PLAN[ph].fast * 1000;
    if (Date.now() - fastAt >= every - 500) { try { await fastTick(ph); writeIndex({}); if (PUSH && ph !== "closed") push(); } catch (e) { console.error("fast", e.message); } }
    await sleep(Math.min(every, Math.max(1000, end - Date.now())));
  }
}
// MARKET: the whole listed universe hourly, a price sweep across every optionable name on the phase's cadence, closes once per session.
async function marketLoop() {
  const symbolsPath = "data/symbols.json"; let symbols = readJSON(symbolsPath, null);
  while (Date.now() < end) {
    const ph = marketPhase(); const t = etNow();
    try {
      if (!symbols || Date.now() - symbolsAt > 3600e3) { symbols = await updateSymbols(symbolsPath); symbolsAt = Date.now(); status.symbols = { at: symbolsAt, n: symbols.n, optionable: symbols.nOptionable, new: symbols.new.length }; console.log(`symbols: ${symbols.n} listed · ${symbols.nOptionable} optionable · ${symbols.new.length} new listings`); if (PUSH) push(); }
      const list = symbols?.optionable || [];
      if (list.length && Date.now() - sweepAt > PLAN[ph].sweep * 1000) { const m = await sweepMarket(list, { concurrency: ph === "regular" ? 12 : 8, closes: readJSON("data/closes.json", null) }); sweepAt = Date.now(); status.sweep = { at: sweepAt, ms: m.ms, n: m.n, ok: m.ok, fail: m.fail, r429: m.r429 }; console.log(`market sweep: ${m.ok}/${m.n} in ${(m.ms / 1000).toFixed(0)}s${m.r429 ? ` · ${m.r429}×429` : ""}`); if (m.r429 > 20) sweepAt = Date.now() + PLAN[ph].sweep * 1000;
        try { const b = computeBreadth(m, readJSON("data/closes.json", null), symbols); if (b) { status.breadth = { at: b.at, adv: b.adv, dec: b.dec, above50: b.above50 }; console.log(`breadth: ${b.adv} up / ${b.dec} down · ${b.above50}% above the 50-EMA`); } } catch (e) { console.error("breadth", e.message); }
        writeIndex({}); if (PUSH) push(); }
      // 60 closes per optionable name, once per session after the close (or at start when the file is older than the last session)
      const closes = readJSON("data/closes.json", null); const lastSession = closes ? new Date(closes.at).toISOString().slice(0, 10) : ""; const upgrade = !!closes && !/:v/.test(closes.cols || ""); // a closes file from before the average-volume column: redo it once
      if (list.length && (ph === "post" || ph === "closed") && t.min >= 16 * 60 + 15 && closesFor !== t.date && (lastSession !== t.date || upgrade)) { closesFor = t.date; const c = await sweepCloses(list, { concurrency: 8 }); status.closes = { at: Date.now(), ms: c.ms, ok: c.ok, fail: c.fail }; console.log(`closes: ${c.ok}/${c.n} in ${(c.ms / 1000).toFixed(0)}s`); writeIndex({}); if (PUSH) push(); }
    } catch (e) { console.error("market loop", e.message); }
    await sleep(Math.min(60e3, Math.max(1000, end - Date.now())));
  }
}
let badStreak = 0;
async function watchdog(n, ok, fail, ph) {
  const hook = process.env.DISCORD_WEBHOOK; const chainCycle = n % PLAN[ph].chainsEvery === 0;
  const spxDown = chainCycle && !ok.includes("SPX"); const manyFails = fail.filter(f => !f.startsWith("cb:")).length > 12; // tier-B names without a Cboe chain are expected misses
  if (spxDown || manyFails) badStreak++; else badStreak = 0;
  if (badStreak === 2 && hook) { try { await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `⚠️ Kingnode feed: ${spxDown ? "SPX chain failed twice in a row" : fail.length + " fetch failures"} (cycle ${n}). ${fail.slice(0, 6).join(" ")}` }) }); } catch {} }
}
let pushN = 0, pushMs = 0, pushSlow = 0;
// One commit, amended and force-pushed: the branch is always a single snapshot. The catch: every amend leaves the previous commit's blobs
// behind as loose objects in the runner's local repo (~250 changed files a minute), and git's auto-gc then repacks them in the foreground —
// the loop stalled for 3–4 minutes at a time on the 20th. So: auto-gc off, and the local repo is thrown away and re-created every 40 pushes
// (one full upload of ~20 MB every quarter hour, instead of an unbounded objects directory and a 14 GB runner disk filling up).
function push() {
  const t0 = Date.now(); pushN++;
  try {
    const git = (cmd, timeout = 120000) => execSync(cmd, { stdio: "inherit", shell: "/bin/bash", timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (!fs.existsSync("data/.git") || pushN % 40 === 1) git(`cd data && rm -rf .git && git init -q -b data && git config gc.auto 0 && git config user.name kingnode-bot && git config user.email bot@users.noreply.github.com`);
    git(`cd data && git add -A && (git rev-parse -q --verify HEAD >/dev/null 2>&1 && git commit -q --amend -m "snapshot $(date -u +%FT%TZ)" >/dev/null 2>&1 || git commit -qm "snapshot $(date -u +%FT%TZ)" >/dev/null 2>&1); git push -q --force "https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git" data`);
  } catch (e) { console.error("push failed", e.message); }
  pushMs = Date.now() - t0; if (pushMs > 15000) pushSlow++; status.push = { n: pushN, lastMs: pushMs, slow: pushSlow };
}
// Hand the baton to the next run. workflow_dispatch is one of the two events GITHUB_TOKEN is allowed to trigger.
async function dispatchSuccessor() {
  if (dispatched || !process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) return;
  dispatched = true;
  try {
    const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/${process.env.FEED_WORKFLOW || "data.yml"}/dispatches`, {
      method: "POST", headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28" },
      body: JSON.stringify({ ref: process.env.FEED_REF || "main" }), signal: AbortSignal.timeout(20000) });
    console.log(`successor dispatched: http ${r.status}`);
    if (!r.ok) console.error(await r.text());
  } catch (e) { console.error("dispatch failed", e.message); }
}
let n = 0;
if (process.argv.includes("--once") || !LOOP_MIN) { await cycle(0, marketPhase()); }
else {
  const handoffAt = end - HANDOFF_MIN * 60e3;
  const mainLoop = async () => { while (Date.now() < end) {
    if (Date.now() >= handoffAt) await dispatchSuccessor();   // the successor's start cancels this run (concurrency group) — no gap, no overlap
    const ph = marketPhase();
    await cycle(n++, ph);
    const wait = Math.max(5, PLAN[ph].every - 1) * 1000;
    const cap = (dispatched ? end : handoffAt) - Date.now();   // never sleep past the handoff moment
    await sleep(Math.min(wait, Math.max(1000, cap)));
  } };
  await Promise.all([mainLoop(), fastLoop(), marketLoop()]);
}
