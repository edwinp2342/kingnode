// The closing read and the anomaly pass, on synthetic days built to lean one way.   `node --test test/close-read.test.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { signedFlow, vwap, cleanBars, sweepDelta, computeCloseRead, resolveCloseRead, closeReadRecord, gradeOf, sideOf } from "../scripts/close-read.mjs";
import { detectAnomalies, baselines, sessionFraction, directionalPremium } from "../scripts/anomalies.mjs";

const T0 = Date.parse("2026-11-11T14:30:00Z"); // 09:30 ET
const at350 = T0 + 380 * 60e3; const et = { date: "2026-11-11", min: 15 * 60 + 50, dow: 3 };
// a day of 1-minute bars: drift per minute, volume per minute, with the last 30 minutes given their own drift and volume
function day(px, { drift = 0, vol = 1000, lateDrift = 0, lateVol = 1000 } = {}) { const bars = []; let p = px; for (let i = 0; i < 380; i++) { const late = i >= 350; const d = late ? lateDrift : drift; const o = p; p = p * (1 + d); bars.push([T0 + i * 60e3, o, Math.max(o, p), Math.min(o, p), p, late ? lateVol : vol]); } return bars; }

test("signedFlow splits dollar volume by bar direction; cleanBars caps a glitch bar", () => {
  const up = day(100, { lateDrift: 0.0005, lateVol: 2000 }); const f = signedFlow(up, at350 - 30 * 60e3, at350);
  assert.equal(f.n, 30); assert.ok(f.up > 0 && f.dn === 0 && f.ratio === 1);
  const flat = day(100, { lateDrift: 0 }); const g = signedFlow(flat, at350 - 30 * 60e3, at350); assert.equal(g.ratio, 0, "flat bars split evenly");
  const bars = day(100); bars[200][5] = 50e6; const c = cleanBars(bars); assert.ok(c[200][5] <= 20 * 1000, "a 50M-share minute is capped at 20× the median minute"); assert.equal(c[199][5], 1000);
  assert.ok(Math.abs(vwap(day(100), T0) - 100) < 0.5);
});

test("sweepDelta: market-wide dollar volume between two sweeps, by direction", () => {
  const prev = { A: [10, 9, 1, 1000, 0, null, 0, 10], B: [20, 21, -1, 5000, 0, null, 0, 20], C: [5, 5, 0, 100, 0, null, 0, 5] };
  const q = { A: [10.5, 9, 1, 1500, 0, null, 0, 10.5], B: [19, 21, -1, 6000, 0, null, 0, 19], C: [5, 5, 0, 100, 0, null, 0, 5], D: [1, 1, 0, 10, 0, null, 0, 1] };
  const d = sweepDelta(prev, q, 1); assert.equal(d.n, 2, "names with new volume and a previous sweep"); assert.equal(d.up, 500 * 10.5); assert.equal(d.dn, 1000 * 19); assert.ok(d.net < 0);
});

test("a buy-side close grades BUY with the factors agreeing; a sell-side one SELL; resolution judges the call", () => {
  const bars1m = { SPY: day(760, { drift: 0.00002, lateDrift: 0.0004, lateVol: 3000 }), QQQ: day(690, { drift: 0.00002, lateDrift: 0.0003, lateVol: 3000 }), IWM: day(280, { lateDrift: 0.0003, lateVol: 3000 }), AAPL: day(350, { lateDrift: 0.0005, lateVol: 4000 }), NVDA: day(180, { lateDrift: 0.0004, lateVol: 4000 }) };
  const breadth = { series: [[at350 - 35 * 60e3, 1500, 1300, 50, 54], [at350 - 60e3, 1700, 1100, 55, 60]] };
  const sweeps = [{ at: at350 - 20 * 60e3, up: 8e9, dn: 3e9, net: 5e9, total: 11e9, vol: 1, n: 5000 }, { at: at350 - 5 * 60e3, up: 7e9, dn: 2e9, net: 5e9, total: 9e9, vol: 1, n: 5000 }];
  const scan = { SPX: { spot: 7650, flip: 7600, cw: 7700, pw: 7550, gex: 1e9 } };
  const r = computeCloseRead({ now: at350, et, bars1m, quotes: { SPY: { prev: 750 } }, breadth, sweeps, scan, label: "15:50" });
  assert.equal(r.side, "BUY"); assert.ok(["A", "B"].includes(r.grade), r.grade + " " + r.score); assert.ok(r.factors.flow.score > 50 && r.factors.market.score > 50 && r.factors.breadth.score > 0 && r.factors.index.SPY.vsVwapPct > 0);
  assert.ok(r.factors.pace.x > 2, "late volume three times the day's"); assert.equal(r.factors.gamma.regime, "positive"); assert.match(r.text, /Buy-side into the close · grade [AB]/); assert.ok(r.leaders.length && !r.laggards.length);
  const sell = computeCloseRead({ now: at350, et, bars1m: { SPY: day(760, { lateDrift: -0.0004, lateVol: 3000 }), QQQ: day(690, { lateDrift: -0.0004, lateVol: 3000 }), IWM: day(280, { lateDrift: -0.0003, lateVol: 3000 }) }, quotes: {}, breadth: { series: [[at350 - 35 * 60e3, 1500, 1300, 50, 52], [at350 - 60e3, 1200, 1600, 45, 44]] }, sweeps: [{ at: at350 - 5 * 60e3, up: 2e9, dn: 8e9, net: -6e9, total: 10e9, vol: 1, n: 5000 }], scan: { SPX: { spot: 7500, flip: 7600, cw: 7700, pw: 7450, gex: -1e9 } }, label: "15:50" });
  assert.equal(sell.side, "SELL"); assert.equal(sell.factors.gamma.regime, "negative"); assert.ok(sell.score < -40);
  // resolution: SPY's move from the 3:50 print to the close
  const hit = resolveCloseRead(r, r.spy.px * 1.002), miss = resolveCloseRead(r, r.spy.px * 0.998), flat = resolveCloseRead(r, r.spy.px);
  assert.equal(hit.hit, true); assert.equal(miss.hit, false); assert.equal(flat.hit, false); assert.equal(flat.dir, "flat");
  const rec = closeReadRecord([{ grade: "B", label: "15:50", outcome: hit }, { grade: "B", label: "15:50", outcome: miss }, { grade: "A", label: "15:50", outcome: hit }, { grade: "C", outcome: null }]);
  assert.deepEqual(rec.byGrade, { B: { n: 2, hits: 1 }, A: { n: 1, hits: 1 } }); assert.deepEqual(rec.all, { n: 3, hits: 2 });
  assert.equal(gradeOf(61), "A"); assert.equal(gradeOf(-45), "B"); assert.equal(gradeOf(10), "D"); assert.equal(sideOf(10), "BALANCED");
  // an index with pseudo-volume never counts as dollar flow, and neither does a name whose half hour would be tens of billions
  const spx = day(7600, { lateDrift: -0.0004, lateVol: 4e9 }); const junk = day(50, { lateDrift: -0.001, lateVol: 5e9 }); const withIdx = computeCloseRead({ now: at350, et, bars1m: { ...bars1m, SPX: spx, JUNK: junk }, quotes: { SPY: { prev: 750 } }, breadth, sweeps, scan, label: "15:50" });
  assert.ok(!withIdx.laggards.some(x => x.sym === "SPX") && !withIdx.leaders.some(x => x.sym === "SPX"), "SPX never counts as dollar flow"); const junkRow = withIdx.laggards.find(x => x.sym === "JUNK"); assert.ok(junkRow && Math.abs(junkRow.net) < 5e7, "a glitch-volume name is capped to its own median minute, not counted at face value: " + JSON.stringify(junkRow)); assert.ok(withIdx.factors.flow.total < r.factors.flow.total * 1.5);
  // a missing factor is dropped from the weights, not treated as zero
  const thin = computeCloseRead({ now: at350, et, bars1m: { SPY: day(760, { lateDrift: 0.0004, lateVol: 3000 }) }, quotes: {}, breadth: null, sweeps: [], scan: null, label: "15:50" });
  assert.equal(thin.factors.market, null); assert.equal(thin.factors.breadth, null); assert.ok(thin.score > 0);
});

test("anomalies: a premium surge, a fresh block at the ask, a one-sided day and a vol/OI outlier are flagged and graded; a normal name is not", () => {
  const days = {}; for (let i = 1; i <= 20; i++) { const d = `2026-10-${String(i).padStart(2, "0")}`; days[d] = { NVDA: [180, 0, 190, 170, 175, 1e9, 5, 0.5, 1e6, 8e5, 400e6, 350e6], ACME: [50, 0, 55, 45, 48, 1e7, 2, 0.4, 2e4, 1e4, 3e6, 2e6], SPY: [750, 0, 760, 740, 745, 1e9, 4, 0.15, 2e6, 2e6, 600e6, 700e6] }; }
  const scan = { rows: {
    ACME: { spot: 52, chg: 6.1, cVol: 90000, pVol: 8000, cPrem: 27e6, pPrem: 2e6, top: [["2026-11-20", "C", 55, 40000, 3000, 12e6, "A"]], unusual: ["2026-11-20", "C", 60, 9000, 300, "A", 30], cw: 55, pw: 48, flip: 50 },
    NVDA: { spot: 181, chg: 0.4, cVol: 1e6, pVol: 8e5, cPrem: 380e6, pPrem: 330e6, top: [["2026-11-13", "C", 180, 20000, 60000, 15e6, "M"]], unusual: null, cw: 185, pw: 175, flip: 178 },
    SPY: { spot: 760, chg: 1.2, cVol: 2e6, pVol: 3e6, cPrem: 500e6, pPrem: 900e6, top: [["2026-11-13", "P", 755, 60000, 20000, 60e6, "A"]], unusual: null, cw: 765, pw: 750, flip: 752 },
  } };
  const b = baselines({ days }, "2026-11-11"); assert.equal(b.ACME.median, 5e6); assert.equal(b.ACME.n, 20);
  assert.ok(Math.abs(sessionFraction(15 * 60 + 50) - 380 / 390) < 1e-9); assert.equal(sessionFraction(570), 0.12);
  const an = detectAnomalies({ scan, history: { days }, now: at350, et });
  const kinds = sym => an.items.filter(x => x.sym === sym).map(x => x.kind).sort();
  assert.deepEqual(kinds("ACME"), ["block", "surge", "volOi"], JSON.stringify(an.items.filter(x => x.sym === "ACME").map(x => x.kind))); /* the one-sided day folds into the surge */
  const surge = an.items.find(x => x.sym === "ACME" && x.kind === "surge"); assert.equal(surge.side, "calls"); assert.ok(surge.ratio > 5); assert.equal(surge.grade, "A"); assert.match(surge.text, /ACME · calls · premium \d\.\d× its 20-day pace/);
  const block = an.items.find(x => x.sym === "ACME" && x.kind === "block"); assert.equal(block.aggr, "A"); assert.match(block.text, /at the ask \(bought\)/); assert.match(block.text, /fresh/);
  assert.equal(kinds("NVDA").length, 0, "a normal day for NVDA is not an anomaly");
  const spyBlock = an.items.find(x => x.sym === "SPY" && x.kind === "block"); assert.ok(spyBlock, "a $60M fresh SPY put block clears the index bar"); assert.equal(spyBlock.side, "puts"); assert.ok(["A","B"].includes(spyBlock.grade));
  // the same contract flagged as a block and as a vol/OI outlier is one item; volume over OI alone tops out at B
  const same = detectAnomalies({ scan: { rows: { ACME: { ...scan.rows.ACME, unusual: ["2026-11-20", "C", 55, 40000, 3000, "A", 13] } } }, history: { days }, now: at350, et }); assert.deepEqual(same.items.filter(x => x.sym === "ACME").map(x => x.kind).sort(), ["block", "surge"]); assert.match(same.items.find(x => x.kind === "block").text, /13× OI/);
  const thin = detectAnomalies({ scan: { rows: { ZZZ: { spot: 10, chg: 0, cVol: 5000, pVol: 100, cPrem: 2e5, pPrem: 1e4, top: [], unusual: ["2026-12-18", "C", 12, 4800, 40, "A", 120] } } }, history: { days }, now: at350, et }); assert.equal(thin.items.length, 1); assert.equal(thin.items[0].grade, "B");
  assert.ok(an.items.every((x, i, a) => i === 0 || a[i - 1].score >= x.score), "sorted by score"); assert.ok(an.counts.A >= 1); assert.ok(an.items.every(x => x.firstSeen === at350 && x.key.startsWith("2026-11-11|")));
  // the log keeps first-seen times across runs
  const again = detectAnomalies({ scan, history: { days }, now: at350 + 60e3, et, log: an.log }); assert.ok(again.items.every(x => x.firstSeen === at350));
  // midnight rolls the calendar, not the session: the same chains at 00:05 ET (and on Saturday) keep Wednesday's date, keys and first-seen times,
  // so nothing lights up as new at midnight and the day's own row never enters its baseline
  const midnight = detectAnomalies({ scan, history: { days: { ...days, "2026-11-11": { ACME: [52, 6.1, 55, 48, 50, 1e7, 2, 0.4, 90000, 8000, 27e6, 2e6] } } }, now: at350 + 8 * 3600e3 + 15 * 60e3, et: { date: "2026-11-12", min: 5, dow: 4 }, log: an.log });
  assert.equal(midnight.date, "2026-11-11"); assert.equal(midnight.frac, 1); assert.ok(midnight.items.length >= 3);
  assert.ok(midnight.items.every(x => x.key.startsWith("2026-11-11|") && x.firstSeen === at350), JSON.stringify(midnight.items.map(x => [x.key, x.firstSeen])));
  assert.equal(midnight.items.find(x => x.sym === "ACME" && x.kind === "surge").baseline, 5e6, "Wednesday's own premium is not in Wednesday's baseline");
  const saturday = detectAnomalies({ scan, history: { days }, now: at350 + 3 * 86400e3, et: { date: "2026-11-14", min: 600, dow: 6 }, log: an.log }); assert.equal(saturday.date, "2026-11-13");
});

test("anomalies: dividend-capture deep-ITM calls are not a surge — the premium outside |delta| ≥ 0.9 is what gets measured, in the day and in the baseline", () => {
  // XOM on 2026-11-13, the day before its ex-dividend date: $962M of call premium, 0% puts, against a $19M typical day — almost all of it deep calls
  const days = {}; for (let i = 1; i <= 20; i++) days[`2026-10-${String(i).padStart(2, "0")}`] = { XOM: [168, 0, 175, 165, 170, 3e7, 4, 0.25, 4e4, 3e4, 11e6, 8e6], DIV: [50, 0, 55, 45, 48, 1e7, 2, 0.3, 2e4, 1e4, 3e6, 2e6, "2026-10-30", 2.5e6, 0] };
  const xom = { spot: 170.7, chg: 0.48, cVol: 276017, pVol: 8789, cPrem: 962534319, pPrem: 3427238, cDeep: 940e6, pDeep: 0, top: [["2027-03-19", "C", 145, 1623, 1451, 4584975, "M"]], unusual: null };
  const an = detectAnomalies({ scan: { rows: { XOM: xom } }, history: { days }, now: at350, et });
  assert.equal(an.items.filter(x => x.sym === "XOM" && (x.kind === "surge" || x.kind === "skew")).length, 0, JSON.stringify(an.items.map(x => [x.sym, x.kind, x.ratio])));
  // the same tape with the deep bucket missing (a row from before the split) still surges — nothing is lost when the fields are absent
  const { cDeep, pDeep, ...old } = xom; const legacy = detectAnomalies({ scan: { rows: { XOM: old } }, history: { days }, now: at350, et }); const sg = legacy.items.find(x => x.sym === "XOM" && x.kind === "surge"); assert.ok(sg && sg.ratio > 40); assert.equal(sg.deep, 0);
  // a real surge on top of a deep-ITM day is still a surge, measured and described on the directional part only
  const both = detectAnomalies({ scan: { rows: { XOM: { ...xom, cPrem: 1060e6, pPrem: 2e6 } } }, history: { days }, now: at350, et }).items.find(x => x.sym === "XOM" && x.kind === "surge");
  assert.ok(both, "a $120M directional day on a $19M name is a surge"); assert.ok(both.ratio > 5 && both.ratio < 8, String(both.ratio)); assert.equal(both.putShare, 0.02); assert.match(both.text, /\$940\.0M deep-ITM set aside/); assert.equal(both.prem, 1062e6);
  // history rows that carry cDeep/pDeep (indexes 13, 14) have them taken out of the baseline; rows without count whole
  assert.equal(directionalPremium(days["2026-10-01"].DIV), 2.5e6); assert.equal(directionalPremium(days["2026-10-01"].XOM), 19e6); assert.equal(directionalPremium([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1e6, 2e6, null, 5e6, 5e6]), 0);
  const b = baselines({ days }, "2026-11-11"); assert.equal(b.DIV.median, 2.5e6); assert.equal(b.XOM.median, 19e6);
});
