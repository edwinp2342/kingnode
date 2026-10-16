// Backtests the Ideas engine's equity rules on the daily bars in the feed (data branch), writes data-static/backtest.json.
// Rules under test (the trend/pullback/RSI/momentum half of analyzeTicker; positioning needs chain history we don't have):
//   BUY when close > EMA21 > EMA50, |close/EMA21 - 1| < pull (pullback), RSI14 < rsi, and today is a RED day (−4% < chg < 0): buy low.
//   Exit: stop = min(EMA50, entry*(1-stop)) on close (or an ATR stop); target = entry*(1+tgt); time stop `days` sessions.
//   v2 adds three filters, each switchable so the backtest can say which ones pay:
//     regime — SPY above its own 50-EMA on the entry day (don't buy pullbacks in a market that is breaking down)
//     rs     — the name's 20-day return beats SPY's (relative strength: buy the leaders' dips, not the laggards')
//     quiet  — the red day's volume is under 1.3× its 20-day average (a quiet pullback, not a liquidation)
//   The earlier "any day" version (pullback 1.5%, RSI<65, stop 4%, target 6%) stays as the baseline; v1 (red day, no filters) is kept too.
//   The numbers live in data-static/backtest.json (the app's Backtest card reads them) and move as the feed's bars grow: the Oct-13 run showed
//   PF 1.65 on 142 trades; two days later nine October entries were stopped out together and the same rule read PF 1.38 on 154 — that is what
//   150 trades of sample looks like. Stricter regime filters (SPY over its 21-EMA, no index down-days) and an ATR cap were tried and all made it
//   worse, so they stay out: the edge and the drawdowns come from the same high-beta names. Shipped as regime_rs_atr2; halves and the
//   positioning overlay (once levels-history.json has covered 40 entries) are written alongside.
//   Run: node scripts/backtest.mjs            (writes data-static/backtest.json with chosen, baseline and every variant)
import fs from "node:fs";
const BASE = process.env.DATA_BASE || "https://raw.githubusercontent.com/edwinp2342/kingnode/data/";
const syms = (process.env.BT_SYMBOLS || "SPY,QQQ,IWM,NVDA,AMD,TSM,AVGO,AMAT,LRCX,KLAC,MU,ARM,AAPL,MSFT,GOOGL,META,AMZN,TSLA,LLY,ISRG,XOM,CVX,FCX,CAT,GE,VRT,CEG,VST,CRWD,PANW,NET,ANET,SHOP,UBER,ABNB,NKE,COST,WMT,HD,PLTR,COIN,HOOD,GLD,SLV,TLT,XLE,SMH,INTC,MRVL,NFLX,ORCL,CRM,ADBE,QCOM,TXN,ASML,DELL,JPM,GS,V,MA,UNH,PG,KO,PEP,MCD,DIS,BA,DE,RTX,LMT,UPS,FDX,SOFI,RKLB,IONQ,APP,RDDT,MSTR,DKNG,CMG,LULU,ELF,ENPH,FSLR,OKLO,SMR,ASTS,HIMS,TEM,DUOL,SPOT,CAVA,CRWV,NBIS").split(",");
const ema = (v, n) => { const k = 2 / (n + 1); const out = []; let e = v[0]; v.forEach((x, i) => { e = i ? x * k + e * (1 - k) : x; out.push(e); }); return out; };
const rsi = (v, n = 14) => { const out = new Array(v.length).fill(null); let g = 0, l = 0; for (let i = 1; i < v.length; i++) { const d = v[i] - v[i - 1]; if (i <= n) { g += Math.max(d, 0); l += Math.max(-d, 0); if (i === n) { out[i] = 100 - 100 / (1 + (g / n) / ((l / n) || 1e-9)); } } else { g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; out[i] = 100 - 100 / (1 + g / (l || 1e-9)); } } return out; };
const atr = (bars, n = 14) => { const out = new Array(bars.length).fill(null); let a = null; for (let i = 1; i < bars.length; i++) { const [, , h, l] = bars[i], pc = bars[i - 1][4]; const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); a = a == null ? tr : (a * (n - 1) + tr) / n; if (i >= n) out[i] = a; } return out; };
const P = { pull: 0.025, rsi: 55, stop: 0.06, tgt: 0.08, days: 15, dipOnly: true, regime: false, rs: false, quiet: false, atrStop: 0, regime21: false, spy5: false, maxAtr: 0 };
const BASELINE = { pull: 0.015, rsi: 65, stop: 0.04, tgt: 0.06, days: 15, dipOnly: false, regime: false, rs: false, quiet: false, atrStop: 0 };
const data = []; let spy = null;
const DIR = process.env.DATA_DIR; // a local copy of the data branch (e.g. after `git clone -b data`) — fetch() in Node ignores HTTPS_PROXY
for (const sym of [...new Set(["SPY", ...syms])]) { let bars; try { if (DIR) { bars = JSON.parse(fs.readFileSync(`${DIR}/${sym}-daily.json`, "utf8")).bars; } else { const r = await fetch(`${BASE}${sym}-daily.json`); if (!r.ok) continue; bars = (await r.json()).bars; } } catch { continue; } if (bars && bars.length >= 80) { const d = { sym, bars, byDay: new Map(bars.map((b, i) => [new Date(b[0]).toISOString().slice(0, 10), i])) }; if (sym === "SPY") spy = d; if (syms.includes(sym)) data.push(d); } }
const spyC = spy ? spy.bars.map(b => b[4]) : null, spyE50 = spyC ? ema(spyC, 50) : null, spyE21 = spyC ? ema(spyC, 21) : null;
// Positioning history (data/levels-history.json on the feed): one row per ticker per day — spot chg cw pw flip gex em iv30 cVol pVol cPrem pPrem.
// It only started accumulating in October 2026, so the overlay test below reports coverage and stays quiet until there is enough of it.
let LV = null; try { LV = DIR ? JSON.parse(fs.readFileSync(`${DIR}/levels-history.json`, "utf8")) : await (await fetch(`${BASE}levels-history.json`)).json(); } catch { LV = null; }
function levelsOn(sym, dateStr) { const d = LV?.days?.[dateStr]; const r = d && d[sym]; if (!r) return null; const [spot, , cw, pw, flip, gex] = r; return { spot, cw, pw, flip, gex, aboveFlip: flip ? spot > flip : null, pwNear: pw ? (spot - pw) / spot >= 0 && (spot - pw) / spot < 0.02 : null, posGamma: gex != null ? gex > 0 : null }; }
function spyIdx(dateMs) { if (!spy) return -1; const k = new Date(dateMs).toISOString().slice(0, 10); return spy.byDay.has(k) ? spy.byDay.get(k) : -1; }
function simulate(p) {
  const res = { syms: 0, trades: [], trim: [] };
  for (const { sym, bars } of data) {
    res.syms++;
    const c = bars.map(b => b[4]), v = bars.map(b => b[5] || 0), e21 = ema(c, 21), e50 = ema(c, 50), r14 = rsi(c), a14 = atr(bars);
    let open = null;
    for (let i = 55; i < c.length; i++) {
      if (open) {
        const stop = p.atrStop ? open.entry - p.atrStop * open.atr : Math.min(e50[i], open.entry * (1 - p.stop)), tgt = open.entry * (1 + p.tgt), age = i - open.i;
        let exit = null, why = "";
        if (c[i] <= stop) { exit = c[i]; why = "stop"; } else if (c[i] >= tgt) { exit = c[i]; why = "target"; } else if (age >= p.days) { exit = c[i]; why = "time"; }
        if (exit != null) { res.trades.push({ sym, entry: open.entry, exit, ret: exit / open.entry - 1, days: age, why, date: new Date(bars[open.i][0]).toISOString().slice(0, 10) }); open = null; }
        continue;
      }
      const chg1 = c[i] / c[i - 1] - 1;
      let buy = c[i] > e21[i] && e21[i] > e50[i] && Math.abs(c[i] / e21[i] - 1) < p.pull && r14[i] != null && r14[i] < p.rsi && chg1 > -0.04 && chg1 < 0.04 && (!p.dipOnly || chg1 < 0);
      if (buy && (p.regime || p.rs || p.regime21 || p.spy5 || p.spyDay)) { const si = spyIdx(bars[i][0]); if (si < 50) buy = false; else { if (p.regime && !(spyC[si] > spyE50[si])) buy = false; if (p.regime21 && !(spyC[si] > spyE21[si])) buy = false; if (p.spy5 && si >= 5 && (spyC[si] / spyC[si - 5] - 1) < -0.02) buy = false; if (p.spyDay && si >= 1 && (spyC[si] / spyC[si - 1] - 1) < -p.spyDay) buy = false; if (p.rs && i >= 20 && si >= 20 && !((c[i] / c[i - 20] - 1) > (spyC[si] / spyC[si - 20] - 1))) buy = false; } }
      if (buy && p.maxAtr && a14[i] && a14[i] / c[i] > p.maxAtr) buy = false; // too wild for a 2×ATR stop to mean anything
      if (buy && p.quiet && i >= 21) { const avg = v.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20; if (avg && v[i] > avg * 1.3) buy = false; }
      if (buy && p.atrStop && !a14[i]) buy = false;
      if (buy) open = { i, entry: c[i], atr: a14[i] || 0 };
      const trim = (c[i] / e21[i] - 1 > 0.04) || (r14[i] != null && r14[i] > 72);
      if (trim && i + 5 < c.length) res.trim.push({ sym, fwd5: c[i + 5] / c[i] - 1 });
    }
  }
  const t = res.trades, wins = t.filter(x => x.ret > 0), gw = wins.reduce((a, x) => a + x.ret, 0), gl = -t.filter(x => x.ret <= 0).reduce((a, x) => a + x.ret, 0);
  const avgDays = t.length ? t.reduce((a, x) => a + x.days, 0) / t.length : null;
  return { params: p, summary: { n: t.length, syms: res.syms, symbols: res.syms, winRate: t.length ? wins.length / t.length : null, avgRet: t.length ? t.reduce((a, x) => a + x.ret, 0) / t.length : null, avgWin: wins.length ? gw / wins.length : null, avgLoss: t.length - wins.length ? -gl / (t.length - wins.length) : null, profitFactor: gl ? gw / gl : null, avgDays, retPerDay: avgDays ? (t.reduce((a, x) => a + x.ret, 0) / t.length) / avgDays : null, exits: { stop: t.filter(x => x.why === "stop").length, target: t.filter(x => x.why === "target").length, time: t.filter(x => x.why === "time").length }, byExit: { stop: t.filter(x => x.why === "stop").length, target: t.filter(x => x.why === "target").length, time: t.filter(x => x.why === "time").length }, trimFwd5: res.trim.length ? res.trim.reduce((a, x) => a + x.fwd5, 0) / res.trim.length : null, trimDownPct: res.trim.length ? res.trim.filter(x => x.fwd5 < 0).length / res.trim.length : null, trimN: res.trim.length }, trades: t };
}
const variants = {
  v1: P,
  regime: { ...P, regime: true }, rs: { ...P, rs: true }, quiet: { ...P, quiet: true }, atr2: { ...P, atrStop: 2 }, days20: { ...P, days: 20 },
  regime_rs: { ...P, regime: true, rs: true }, regime_quiet: { ...P, regime: true, quiet: true }, regime_rs_quiet: { ...P, regime: true, rs: true, quiet: true }, regime_rs_atr2: { ...P, regime: true, rs: true, atrStop: 2 }, rra_regime21: { ...P, regime: true, rs: true, atrStop: 2, regime21: true }, rra_spy5: { ...P, regime: true, rs: true, atrStop: 2, spy5: true }, rra_maxAtr4: { ...P, regime: true, rs: true, atrStop: 2, maxAtr: 0.04 }, rra_maxAtr5: { ...P, regime: true, rs: true, atrStop: 2, maxAtr: 0.05 }, rra_regime21_maxAtr5: { ...P, regime: true, rs: true, atrStop: 2, regime21: true, maxAtr: 0.05 }, rra_spyDay1: { ...P, regime: true, rs: true, atrStop: 2, spyDay: 0.01 }, rra_spyDay05: { ...P, regime: true, rs: true, atrStop: 2, spyDay: 0.005 }, regime_rs_atr25: { ...P, regime: true, rs: true, atrStop: 2.5 }, regime_rs_atr3: { ...P, regime: true, rs: true, atrStop: 3 }, regime_rs_days20: { ...P, regime: true, rs: true, days: 20 },
};
const out = {}; for (const [k, p] of Object.entries(variants)) { const r = simulate(p); out[k] = { params: r.params, summary: r.summary }; console.log(k.padEnd(18), JSON.stringify({ n: r.summary.n, wr: +(r.summary.winRate * 100).toFixed(1), avg: +(r.summary.avgRet * 100).toFixed(2), pf: +(r.summary.profitFactor || 0).toFixed(2), days: +(r.summary.avgDays || 0).toFixed(1), perDay: +((r.summary.retPerDay || 0) * 1e4).toFixed(1) })); }
const baseline = simulate(BASELINE); console.log("baseline".padEnd(18), JSON.stringify({ n: baseline.summary.n, wr: +(baseline.summary.winRate * 100).toFixed(1), avg: +(baseline.summary.avgRet * 100).toFixed(2), pf: +(baseline.summary.profitFactor || 0).toFixed(2) }));
// chosen = the variant the app ships; set CHOSEN=<name> to override the pick below
const chosenName = process.env.CHOSEN || "regime_rs_atr2"; const chosen = simulate(variants[chosenName]);
// Positioning overlay: split the chosen rule's trades by the dealer-positioning state on the entry day. Same trades, same exits — only the split differs,
// so this says whether "above the flip" / "put wall under you" / "dealers long gamma" add to the edge, once the history covers enough entries.
const overlay = (() => {
  const t = chosen.trades.map(x => ({ ...x, lv: levelsOn(x.sym, x.date) })); const withLv = t.filter(x => x.lv);
  const stats = arr => { const w = arr.filter(x => x.ret > 0), gw = w.reduce((a, x) => a + x.ret, 0), gl = -arr.filter(x => x.ret <= 0).reduce((a, x) => a + x.ret, 0); return { n: arr.length, winRate: arr.length ? w.length / arr.length : null, avgRet: arr.length ? arr.reduce((a, x) => a + x.ret, 0) / arr.length : null, profitFactor: gl ? gw / gl : (gw ? Infinity : null) }; };
  const split = key => ({ yes: stats(withLv.filter(x => x.lv[key] === true)), no: stats(withLv.filter(x => x.lv[key] === false)) });
  const out = { coverage: t.length ? withLv.length / t.length : 0, tradesWithLevels: withLv.length, enough: withLv.length >= 40, days: LV ? Object.keys(LV.days || {}).length : 0 };
  if (out.enough) { out.flip = split("aboveFlip"); out.putWall = split("pwNear"); out.gamma = split("posGamma"); }
  return out;
})();
// Halves: the same rule on the first and second half of the trades (by entry date) — a rule that only works in one half is a regime bet, not an edge.
const halves = (() => { const t = [...chosen.trades].sort((a, b) => a.date < b.date ? -1 : 1); const mid = Math.floor(t.length / 2); const st = arr => { const w = arr.filter(x => x.ret > 0), gw = w.reduce((a, x) => a + x.ret, 0), gl = -arr.filter(x => x.ret <= 0).reduce((a, x) => a + x.ret, 0); return { n: arr.length, from: arr[0]?.date, to: arr.at(-1)?.date, winRate: arr.length ? w.length / arr.length : null, avgRet: arr.length ? arr.reduce((a, x) => a + x.ret, 0) / arr.length : null, profitFactor: gl ? gw / gl : null }; }; return { first: st(t.slice(0, mid)), second: st(t.slice(mid)) }; })();
console.log("halves:", JSON.stringify(halves));
console.log("positioning overlay:", overlay.enough ? JSON.stringify(overlay) : `${overlay.days} days of levels history, ${overlay.tradesWithLevels} covered trades — needs 40 (keep the feed running)`);
fs.mkdirSync("data-static", { recursive: true });
fs.writeFileSync("data-static/backtest.json", JSON.stringify({ at: Date.now(), period: "last ~12 months of daily bars in the feed", chosenName, chosen: { params: chosen.params, summary: chosen.summary }, baseline: { params: baseline.params, summary: baseline.summary }, variants: out, overlay, halves, trades: chosen.trades }));
console.log("chosen:", chosenName, JSON.stringify(chosen.summary));
