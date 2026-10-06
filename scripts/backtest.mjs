// Backtests the Ideas engine's equity rules on the daily bars in the feed (data branch), writes data-static/backtest.json.
// Rules under test (the trend/pullback/RSI/momentum half of analyzeTicker; positioning needs chain history we don't have):
//   BUY when close > EMA21 > EMA50, |close/EMA21 - 1| < 2.5% (pullback), RSI14 < 55, and today is a RED day (−4% < chg < 0): buy low.
//   Exit: stop = min(EMA50, entry*0.94) on close; target = entry*1.08; time stop 15 sessions.
//   The earlier "any day" version (pullback 1.5%, RSI<65, stop 4%, target 6%) is kept as the baseline for comparison.
//   TRIM signal (for info): close/EMA21 > 1.04 or RSI > 72 → measures forward 5-day return.
import fs from "node:fs";
const BASE = process.env.DATA_BASE || "https://raw.githubusercontent.com/edwinp2342/kingnode/data/";
const syms = (process.env.BT_SYMBOLS || "SPY,QQQ,IWM,NVDA,AMD,TSM,AVGO,AMAT,LRCX,KLAC,MU,ARM,AAPL,MSFT,GOOGL,META,AMZN,TSLA,LLY,ISRG,XOM,CVX,FCX,CAT,GE,VRT,CEG,VST,CRWD,PANW,NET,ANET,SHOP,UBER,ABNB,NKE,COST,WMT,HD,PLTR,COIN,HOOD,GLD,SLV,TLT,XLE,SMH,INTC,MRVL,NFLX,ORCL,ADBE,CRM,NOW,DE,UPS,FDX,PG,KO,PEP,CMG,RKLB,IONQ,APP,RDDT,SOFI,MSTR").split(",");
const ema = (v, n) => { const k = 2 / (n + 1); const out = []; let e = v[0]; v.forEach((x, i) => { e = i ? x * k + e * (1 - k) : x; out.push(e); }); return out; };
const rsi = (v, n = 14) => { const out = new Array(v.length).fill(null); let g = 0, l = 0; for (let i = 1; i < v.length; i++) { const d = v[i] - v[i - 1]; if (i <= n) { g += Math.max(d, 0); l += Math.max(-d, 0); if (i === n) { out[i] = 100 - 100 / (1 + (g / n) / ((l / n) || 1e-9)); } } else { g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; out[i] = 100 - 100 / (1 + g / (l || 1e-9)); } } return out; };
const P = { pull: 0.025, rsi: 55, stop: 0.06, tgt: 0.08, days: 15, dipOnly: true }, BASELINE = { pull: 0.015, rsi: 65, stop: 0.04, tgt: 0.06, days: 15, dipOnly: false };
const data = [];
for (const sym of syms) { let bars; try { const r = await fetch(`${BASE}${sym}-daily.json`); if (!r.ok) continue; bars = (await r.json()).bars; } catch { continue; } if (bars && bars.length >= 80) data.push({ sym, bars }); }
function simulate(p) {
const res = { syms: 0, trades: [], trim: [] };
for (const { sym, bars } of data) {
  res.syms++;
  const c = bars.map(b => b[4]), e21 = ema(c, 21), e50 = ema(c, 50), r14 = rsi(c);
  let open = null;
  for (let i = 55; i < c.length; i++) {
    if (open) {
      const stop = Math.min(e50[i], open.entry * (1 - p.stop)), tgt = open.entry * (1 + p.tgt), age = i - open.i;
      let exit = null, why = "";
      if (c[i] <= stop) { exit = c[i]; why = "stop"; } else if (c[i] >= tgt) { exit = c[i]; why = "target"; } else if (age >= 15) { exit = c[i]; why = "time"; }
      if (exit != null) { res.trades.push({ sym, entry: open.entry, exit, ret: exit / open.entry - 1, days: age, why, date: new Date(bars[open.i][0]).toISOString().slice(0, 10) }); open = null; }
      continue;
    }
    const chg1 = c[i] / c[i - 1] - 1;
    const buy = c[i] > e21[i] && e21[i] > e50[i] && Math.abs(c[i] / e21[i] - 1) < p.pull && r14[i] != null && r14[i] < p.rsi && chg1 > -0.04 && chg1 < 0.04 && (!p.dipOnly || chg1 < 0);
    if (buy) open = { i, entry: c[i] };
    const trim = (c[i] / e21[i] - 1 > 0.04) || (r14[i] != null && r14[i] > 72);
    if (trim && i + 5 < c.length) res.trim.push({ sym, fwd5: c[i + 5] / c[i] - 1 });
  }
}
const t = res.trades, wins = t.filter(x => x.ret > 0), gw = wins.reduce((a, x) => a + x.ret, 0), gl = -t.filter(x => x.ret <= 0).reduce((a, x) => a + x.ret, 0);
return { params: p, summary: { n: t.length, winRate: t.length ? wins.length / t.length : null, avgRet: t.length ? t.reduce((a, x) => a + x.ret, 0) / t.length : null, avgWin: wins.length ? gw / wins.length : null, avgLoss: t.length - wins.length ? -gl / (t.length - wins.length) : null, profitFactor: gl ? gw / gl : null, byExit: Object.fromEntries(["stop", "target", "time"].map(k => [k, t.filter(x => x.why === k).length])), avgDays: t.length ? t.reduce((a, x) => a + x.days, 0) / t.length : null, trimN: res.trim.length, trimFwd5: res.trim.length ? res.trim.reduce((a, x) => a + x.fwd5, 0) / res.trim.length : null, trimDownPct: res.trim.length ? res.trim.filter(x => x.fwd5 < 0).length / res.trim.length : null, symbols: res.syms }, trades: t.slice(-300) };
}
const chosen = simulate(P), baseline = simulate(BASELINE);
fs.mkdirSync("data-static", { recursive: true });
fs.writeFileSync("data-static/backtest.json", JSON.stringify({ at: Date.now(), period: "last ~12 months of daily bars in the feed", chosen: { params: chosen.params, summary: chosen.summary }, baseline: { params: baseline.params, summary: baseline.summary }, trades: chosen.trades }, null, 1));
console.log("chosen", JSON.stringify(chosen.summary)); console.log("baseline", JSON.stringify(baseline.summary));
