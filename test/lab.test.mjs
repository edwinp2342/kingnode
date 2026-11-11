// The Lab engine on series with known answers: indicators, fill mechanics (no look-ahead, stops first, slippage, gaps), metrics,
// the conditional study, the statistics helpers, walk-forward, sensitivity, validation, every template.   `node --test test/lab.test.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sma, ema, rsi, atr, zscore, rollingMax, wilson, twoProportionZ, tTest, bootstrapCI, monteCarloDrawdown, kelly, multipleTesting, makeFeatures, evalRule, backtest, metrics, maxDrawdown, conditionalStudy, walkForward, sensitivity, applyParams, gridCombos, describeSpec, validate, normalizeSpec, TEMPLATES, mulberry32, FEATURE_NAMES } from "../scripts/lab.mjs";

const DAY = 86400e3; const T0 = Date.UTC(2018, 0, 2, 14, 30);
// trading-day stamps (skip weekends) so the calendar logic sees real gaps
function stamps(n) { const out = []; let t = T0; while (out.length < n) { const d = new Date(t).getUTCDay(); if (d !== 0 && d !== 6) out.push(t); t += DAY; } return out; }
// a seeded random walk with a drift, as daily bars
function walk(n, { seed = 1, drift = 0.0003, vol = 0.012, px = 100 } = {}) { const rnd = mulberry32(seed); const ts = stamps(n); const bars = []; let c = px; for (let i = 0; i < n; i++) { const r = drift + vol * (rnd() + rnd() + rnd() + rnd() - 2) * 1.7; const o = c * (1 + vol * 0.3 * (rnd() - 0.5)); c = o * (1 + r); const h = Math.max(o, c) * (1 + vol * 0.4 * rnd()), l = Math.min(o, c) * (1 - vol * 0.4 * rnd()); bars.push([ts[i], +o.toFixed(4), +h.toFixed(4), +l.toFixed(4), +c.toFixed(4), 1e6 + Math.round(rnd() * 1e6)]); } return bars; }
// a scripted path: explicit closes, open = previous close, high/low = ±range
function scripted(closes, range = 1) { const ts = stamps(closes.length); return closes.map((c, i) => { const o = i ? closes[i - 1] : c; return [ts[i], o, Math.max(o, c) + range, Math.min(o, c) - range, c, 1000]; }); }

test("indicators: SMA/EMA/RSI/ATR/z-score give textbook values", () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const e = ema([1, 2, 3, 4, 5, 6], 3); assert.equal(e[2], 2); assert.ok(Math.abs(e[3] - 3) < 1e-9); // seed = SMA(3) = 2, then 4*0.5 + 2*0.5 = 3
  assert.equal(rsi(Array.from({ length: 30 }, (_, i) => 100 + i), 14)[29], 100, "a series that only rises has RSI 100");
  const r = rsi([44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64], 14); assert.ok(Math.abs(r[14] - 70.46) < 0.1, "Wilder's worked example: " + r[14]); assert.ok(Math.abs(r[15] - 66.25) < 0.1);
  const flat = scripted(Array.from({ length: 20 }, () => 100), 1); assert.ok(Math.abs(atr(flat, 14)[19] - 2) < 1e-9, "constant 2-point ranges → ATR 2");
  const z = zscore([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5); assert.ok(Math.abs(z[9] - 1.4142) < 1e-3, "10 against mean 8, population sd 1.414 → 1.41");
  assert.deepEqual(rollingMax([3, 1, 4, 1, 5], 2), [null, 3, 4, 4, 5]);
  const F = makeFeatures(walk(300)); for (const f of FEATURE_NAMES) { const s = F.get({ f, p: f === "bb" ? 20 : 14, k: 2 }); assert.ok(Array.isArray(s) || s === null, f); if (Array.isArray(s)) assert.equal(s.length, 300, f); }
  assert.equal(evalRule({ all: [{ f: "close", op: ">", v: 0 }] }, F, 10), true); assert.equal(evalRule({ all: [{ f: "near_put_wall", op: "<", v: 1 }] }, F, 10), false, "no positioning data → false, never a guess");
});

test("fills: signal on the close, entry at the next open with slippage; stop before target in a bar; gaps fill at the open; time exits at the next open", () => {
  // day 0..: a dip on day 2 (close 90) triggers; entry day 3 open (= day 2 close 90) + 5 bps; target +5% = 94.5 hit on day 5's high
  const closes = [100, 100, 90, 91, 92, 95, 96, 97, 98, 99, 100, 100, 100, 100, 100]; const bars = scripted(closes, 0.5);
  const spec = { universe: ["X"], entry: { all: [{ f: "day_ret", op: "<", v: -5 }] }, exit: { target: { type: "pct", v: 5 }, stop: { type: "pct", v: 5 }, time: { bars: 20 } }, sizing: { type: "equal", pct: 50 }, costs: { slippageBps: 5 }, benchmark: null };
  const r = backtest(spec, { X: bars }); assert.equal(r.trades.length, 1); const t = r.trades[0];
  assert.equal(t.entryDate, new Date(bars[3][0]).toISOString().slice(0, 10), "filled the day after the signal"); assert.ok(Math.abs(t.entryPx - 90 * 1.0005) < 1e-6, "entry at the open plus slippage");
  assert.equal(t.reason, "target"); assert.equal(t.exitDate, new Date(bars[5][0]).toISOString().slice(0, 10)); assert.ok(Math.abs(t.exitPx - 90 * 1.0005 * 1.05 * (1 - 0.0005)) < 1e-3, "target price less slippage (ledger rounds to 4 dp)");
  assert.ok(r.equity.at(-1)[1] > 100000 && r.metrics.trades === 1 && r.metrics.winRate === 100);
  // the same path but the day after entry trades through both the stop and the target → the stop is assumed
  const wild = scripted([100, 100, 90, 90, 90], 0.5); wild[4] = [wild[4][0], 90, 97, 84, 92, 1000]; const r2 = backtest(spec, { X: wild }); assert.equal(r2.trades[0].reason, "stop"); assert.ok(Math.abs(r2.trades[0].exitPx - 90 * 1.0005 * 0.95 * (1 - 0.0005)) < 1e-3);
  // a gap below the stop fills at the open, not at the stop
  const gap = scripted([100, 100, 90, 90, 90], 0.5); gap[4] = [gap[4][0], 80, 81, 79, 80, 1000]; const r3 = backtest(spec, { X: gap }); assert.equal(r3.trades[0].reason, "stop"); assert.ok(Math.abs(r3.trades[0].exitPx - 80 * (1 - 0.0005)) < 1e-3, "gapped through: filled at the open " + r3.trades[0].exitPx);
  // time exit: 3 bars after entry → out at the next open
  const flat = scripted([100, 100, 90, 90, 90, 90, 90, 90, 90, 90], 0.1); const r4 = backtest({ ...spec, exit: { time: { bars: 3 } } }, { X: flat }); assert.equal(r4.trades[0].reason, "time"); assert.equal(r4.trades[0].bars, 4, "held three bars, out on the fourth open");
  // no look-ahead: a signal on the last bar never becomes a trade; an open position at the end is closed and flagged
  const r5 = backtest({ ...spec, exit: {} }, { X: scripted([100, 100, 90, 95, 96], 0.1) }); assert.equal(r5.trades.length, 1); assert.equal(r5.trades[0].reason, "open_at_end");
  // cash accounting: equity equals cash plus marks, never negative, and max positions caps the book
  const data = { A: walk(400, { seed: 1 }), B: walk(400, { seed: 2 }), C: walk(400, { seed: 3 }), D: walk(400, { seed: 4 }) };
  const r6 = backtest({ universe: ["A", "B", "C", "D"], entry: { all: [{ f: "close", op: ">", v: 0 }] }, exit: { time: { bars: 5 } }, sizing: { type: "equal", pct: 40 }, maxPositions: 2, benchmark: "A" }, data);
  assert.ok(r6.trades.length > 50); assert.ok(r6.equity.every(([, v]) => v > 0)); const concurrent = (() => { let max = 0; const ev = []; for (const t of r6.trades) { ev.push([t.entryDate, 1], [t.exitDate, -1]); } ev.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]); let c = 0; for (const [, d] of ev) { c += d; max = Math.max(max, c); } return max; })(); assert.ok(concurrent <= 2, "never more than maxPositions open: " + concurrent);
  assert.ok(r6.benchmark.length === r6.equity.length && r6.metrics.benchmark.beta != null);
  // short side mirrors: a falling path pays, with the stop above
  const down = scripted([100, 100, 110, 109, 105, 100, 95, 94, 94, 94], 0.3); const rs = backtest({ universe: ["X"], side: "short", entry: { all: [{ f: "day_ret", op: ">", v: 5 }] }, exit: { target: { type: "pct", v: 5 }, stop: { type: "pct", v: 5 } }, sizing: { type: "equal", pct: 50 }, benchmark: null }, { X: down }); assert.equal(rs.trades.length, 1); assert.equal(rs.trades[0].reason, "target"); assert.ok(rs.trades[0].pnl > 0 && rs.equity.at(-1)[1] > 100000);
});

test("metrics: a known curve gives the known return, drawdown and trade stats; Sharpe is zero when there is no variance", () => {
  const ts = stamps(6); const eq = [[ts[0], 100], [ts[1], 110], [ts[2], 99], [ts[3], 121], [ts[4], 121], [ts[5], 133.1]];
  const dd = maxDrawdown(eq); assert.ok(Math.abs(dd.maxDD - (-10)) < 1e-9, "110 → 99 is −10%");
  const trades = [{ pnl: 10, retPct: 10, bars: 2 }, { pnl: -5, retPct: -5, bars: 1 }, { pnl: 20, retPct: 20, bars: 3 }, { pnl: -5, retPct: -5, bars: 1 }];
  const m = metrics(eq, trades); assert.ok(Math.abs(m.totalReturn - 33.1) < 1e-6); assert.equal(m.maxDD, -10); assert.equal(m.winRate, 50); assert.equal(m.profitFactor, 3); assert.equal(m.expectancyPct, 5); assert.equal(m.avgWinPct, 15); assert.equal(m.avgLossPct, -5); assert.equal(m.maxConsecLosses, 1); assert.equal(m.trades, 4);
  const flat = ts.map((t, i) => [t, 100 * 1.001 ** i]); assert.equal(metrics(flat, []).sharpe, 0, "constant returns have no variance → Sharpe reported as 0, not Infinity");
  assert.deepEqual(kelly(60, 10, -5), { full: 40, half: 20, payoff: 2 }); // p − q/b = 0.6 − 0.4/2
});

test("statistics: Wilson, two-proportion z, t-test, bootstrap and Monte Carlo are deterministic and honest about small samples", () => {
  const w = wilson(7, 9); assert.ok(Math.abs(w.p - 0.778) < 1e-3 && w.lo > 0.44 && w.lo < 0.46 && w.hi > 0.93 && w.hi < 0.95, JSON.stringify(w));
  assert.ok(Math.abs(twoProportionZ(60, 100, 50, 100).z - 1.4213) < 1e-3); assert.ok(Number.isNaN(twoProportionZ(0, 0, 1, 2).p));
  const t = tTest([1, 2, 3, 4, 5]); assert.ok(Math.abs(t.t - 4.2426) < 1e-3);
  const b1 = bootstrapCI([1, -1, 2, 3, -2, 4, 1, 0.5, 2, -0.5], { seed: 3 }), b2 = bootstrapCI([1, -1, 2, 3, -2, 4, 1, 0.5, 2, -0.5], { seed: 3 }); assert.deepEqual(b1, b2, "seeded: the same answer every run"); assert.ok(b1.lo < b1.stat && b1.stat < b1.hi); assert.equal(bootstrapCI([1, 2], {}), null);
  const mc = monteCarloDrawdown([5, -3, 4, -6, 2, 8, -4, 3, -2, 6], { seed: 5, positionPct: 100 }); assert.ok(mc.p95DD <= mc.p50DD && mc.p50DD <= 0 && mc.worstDD <= mc.p95DD, JSON.stringify(mc)); assert.deepEqual(mc, monteCarloDrawdown([5, -3, 4, -6, 2, 8, -4, 3, -2, 6], { seed: 5, positionPct: 100 }));
  const mt = multipleTesting(50, 5, 0.6); assert.equal(mt.alphaAdjusted, 0.001); assert.ok(mt.expectedMaxSharpeFromNoise > 1 && /within|barely/.test(mt.verdict), JSON.stringify(mt)); assert.match(multipleTesting(1, 5, 1).note, /1 variants/);
});

test("conditional study: a scripted edge is found with its interval, the base rate sits beside it, and the path stats count target-before-stop", () => {
  // 600 flat-ish days; every 40th day the close drops 4% and the next five days recover 1% each → a real conditional edge
  const closes = []; let c = 100; for (let i = 0; i < 600; i++) { if (i % 40 === 20) c *= 0.96; else if (i % 40 > 20 && i % 40 <= 25) c *= 1.01; else c *= 1 + (i % 3 === 0 ? 0.001 : -0.0005); closes.push(+c.toFixed(4)); }
  const bars = scripted(closes, 0.05); const st = conditionalStudy({ bars, rule: { all: [{ f: "day_ret", op: "<", v: -3 }] }, horizons: [5, 10], targetPct: 3, stopPct: 3 });
  assert.equal(st.events, 15); assert.equal(st.horizons[5].hitRate, 100); assert.ok(st.horizons[5].ci[0] > 75 && st.horizons[5].ci[1] === 100, "15 of 15 → Wilson lower bound ~80%: " + JSON.stringify(st.horizons[5].ci)); assert.ok(st.horizons[5].mean > 4.5 && st.horizons[5].mean < 5.5);
  assert.ok(st.base[5].hit.p < 0.7 && st.base[5].n > 500, "the base rate is computed over every day"); assert.ok(st.horizons[5].vsBasePts > 30 && st.horizons[5].pVsBase < 0.01);
  assert.equal(st.path.targetFirst, 15); assert.equal(st.path.stopFirst, 0); assert.equal(st.path.pTargetFirst, 100); assert.ok(st.path.medianDaysToTarget >= 3 && st.path.medianDaysToTarget <= 4, "3% takes three to four 1% days: " + st.path.medianDaysToTarget); assert.ok(st.path.maeMedian > -1);
  assert.ok(st.warnings.some(w => /only 15 events/.test(w)));
  const none = conditionalStudy({ bars, rule: { all: [{ f: "rsi", p: 14, op: "<", v: 0 }] } }); assert.equal(none.events, 0); assert.equal(none.horizons[5].n, 0); assert.ok(Number.isNaN(none.horizons[5].hitRate) || none.horizons[5].hitRate == null);
});

test("walk-forward, sensitivity, params and the spec in English", () => {
  const data = { A: walk(1700, { seed: 21, drift: 0.0004 }), B: walk(1700, { seed: 22, drift: 0.0002 }), SPY: walk(1700, { seed: 23, drift: 0.0003 }) };
  const spec = { name: "wf", universe: ["A", "B"], entry: { all: [{ f: "rsi", p: 14, op: "<", v: 35 }] }, exit: { target: { type: "pct", v: 4 }, stop: { type: "pct", v: 4 }, time: { bars: 10 } }, sizing: { type: "equal", pct: 20 }, maxPositions: 2 };
  const wf = walkForward(spec, data, { grid: { "entry.all.0.v": [30, 35, 40], "exit.target.v": [3, 5] }, trainYears: 2, testYears: 1 }); assert.ok(wf.windows.length >= 3, "several windows: " + wf.windows.length); assert.equal(wf.combos, 6); assert.ok(wf.oos && typeof wf.oos.sharpe === "number"); assert.ok(wf.windows.every(w => w.test[0] > w.train[1] && w.params["entry.all.0.v"] != null)); assert.ok(wf.oosEquity.length > 400);
  const sens = sensitivity(spec, data, { path: "entry.all.0.v", values: [30, 35, 40] }, { path: "exit.time.bars", values: [5, 10] }, "expectancyPct"); assert.equal(sens.rows.length, 3); assert.equal(sens.rows[0].length, 2); assert.ok(sens.stable >= 0 && sens.stable <= 100);
  assert.deepEqual(gridCombos({ a: [1, 2], b: ["x"] }), [{ a: 1, b: "x" }, { a: 2, b: "x" }]); assert.equal(applyParams(spec, { "exit.target.v": 9 }).exit.target.v, 9); assert.equal(spec.exit.target.v, 4, "the original is untouched");
  const d = describeSpec(normalizeSpec(spec)); assert.match(d, /Long A, B when RSI\(14\) < 35/); assert.match(d, /\+4% target, −4% stop, 10 bars/); assert.match(d, /next open with 5 bps/);
  const r = backtest(spec, data); const checks = validate(r, { nTried: 6, oos: wf }); const names = checks.map(c => c.check); for (const k of ["look-ahead", "survivorship", "sample", "costs", "significance", "data mining", "out of sample", "span", "exposure"]) assert.ok(names.includes(k), k); assert.equal(checks.find(c => c.check === "look-ahead").level, "ok"); assert.equal(validate(backtest({ ...spec, fill: "close" }, data)).find(c => c.check === "look-ahead").level, "warn");
  assert.match(validate({ error: "boom" })[0].text, /boom/);
});

test("every template normalizes, describes itself and runs on synthetic data without throwing; positioning filters stay false without positioning", () => {
  const syms = [...new Set(TEMPLATES.flatMap(t => t.spec.universe))]; const data = Object.fromEntries(syms.map((s, i) => [s, walk(900, { seed: 100 + i })]));
  for (const t of TEMPLATES) { const s = normalizeSpec(t.spec); assert.ok(describeSpec(s).length > 40, t.id); const r = backtest(s, data, {}); assert.ok(!r.error, t.id + " " + r.error); assert.ok(Array.isArray(r.trades) && r.equity.length > 800, t.id); assert.ok(t.grid && t.sens?.length === 2, t.id + " has a grid and two sensitivity axes"); if (t.id === "put_wall") assert.equal(r.trades.length, 0, "no positioning → no trades, no invention"); }
  // with positioning supplied by date, the put-wall template trades
  const pos = { SPY: Object.fromEntries(data.SPY.map(b => [new Date(b[0]).toISOString().slice(0, 10), { pw: b[4] * 0.995, cw: b[4] * 1.03, flip: b[4] * 0.98, gex: 1 }])) };
  const pw = TEMPLATES.find(t => t.id === "put_wall"); const r = backtest({ ...pw.spec, universe: ["SPY"] }, data, { pos }); assert.ok(r.trades.length > 10, "positioning filters work when the data exists: " + r.trades.length);
});

test("the engine inlined into app.html is the current module (run `node scripts/inline-lab.mjs` after editing scripts/lab.mjs)", async () => {
  const { inlineBlock } = await import("../scripts/inline-lab.mjs"); const html = fs.readFileSync(new URL("../app.html", import.meta.url), "utf8"); const block = inlineBlock(); assert.ok(html.includes(block), "app.html's Lab engine block is stale or missing");
});
