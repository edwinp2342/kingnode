// The closing read and the anomaly pass, on synthetic days built to lean one way.   `node --test test/close-read.test.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { signedFlow, vwap, cleanBars, sweepDelta, computeCloseRead, resolveCloseRead, closeReadRecord, settleCloseReads, gradeOf, sideOf, closeReadDue, isCallRead } from "../scripts/close-read.mjs";
import { prevTradingDay, sessionCloseMin, marketPhase } from "../scripts/market-clock.mjs";
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

test("settleCloseReads: the next session's previous close re-judges the day before it (2026-11-20: 687.52 at 16:03, 689.81 settled); other days and settled reads are left alone", () => {
  const read = (date, label, side, grade, px, outcome) => ({ date, label, side, grade, score: side === "BUY" ? 40 : -40, spy: { px, prev: 715.87 }, outcome });
  const hist = { reads: [
    read("2026-11-19", "15:50", "SELL", "C", 715.97, { close: 715.84, movePct: -0.018, dir: "flat", hit: false, resolvedAt: 1, official: true }),
    read("2026-11-20", "15:50", "SELL", "B", 693.5, { close: 687.52, movePct: -0.862, dir: "down", hit: true, resolvedAt: 2 }),
    read("2026-11-20", "15:58", "SELL", "A", 687.25, { close: 687.52, movePct: 0.04, dir: "up", hit: false, resolvedAt: 2 }),
    read("2026-11-20", "16:05", "BUY", "C", 688, null), // a read the 16:03 pass never resolved
    read("2026-11-23", "15:50", "BUY", "C", 724.37, { close: 722.31, movePct: -0.284, dir: "down", hit: false, resolvedAt: 3 }) ] };
  assert.equal(prevTradingDay("2026-11-23"), "2026-11-20", "Monday's previous session is Friday"); assert.equal(prevTradingDay("2026-11-27"), "2026-11-25", "Thanksgiving is skipped");
  // Monday's quote: chart on 2026-11-23, chartPreviousClose 689.81 — Friday's three reads settle, Thursday (already official) and Monday do not
  assert.equal(settleCloseReads(hist, 689.81, prevTradingDay("2026-11-23"), 100), 3);
  const [thu, fri350, fri358, late, mon] = hist.reads;
  assert.equal(thu.outcome.close, 715.84); assert.equal(mon.outcome.official, undefined, "Monday waits for Tuesday's quote");
  assert.equal(fri350.outcome.close, 689.81); assert.equal(fri350.outcome.hit, true, "693.5 → 689.81 is still a sell-side hit"); assert.equal(fri350.outcome.movePct, -0.532);
  assert.deepEqual(fri350.outcome.provisional, { close: 687.52, movePct: -0.862, dir: "down", hit: true }); assert.equal(fri350.outcome.resolvedAt, 2); assert.equal(fri350.outcome.settledAt, 100);
  assert.equal(fri358.outcome.dir, "up"); assert.equal(fri358.outcome.movePct, 0.372); assert.equal(fri358.outcome.hit, false);
  assert.equal(late.outcome.official, true); assert.equal(late.outcome.hit, true, "688 → 689.81 judges the unresolved BUY read for the first time"); assert.equal(late.outcome.provisional, undefined); assert.equal(late.outcome.resolvedAt, 100);
  assert.deepEqual(hist.record, closeReadRecord(hist.reads.filter(r => r.label === "15:50")), "the record is rebuilt");
  // a second pass with the same quote does nothing; a close within a cent keeps no provisional copy
  assert.equal(settleCloseReads(hist, 689.81, "2026-11-20", 101), 0); assert.equal(fri350.outcome.settledAt, 100);
  const same = { reads: [read("2026-11-19", "15:50", "SELL", "C", 715.97, { close: 715.87, movePct: -0.014, dir: "flat", hit: false, resolvedAt: 1 })] };
  assert.equal(settleCloseReads(same, 715.87, "2026-11-19"), 1); assert.equal(same.reads[0].outcome.official, true); assert.equal(same.reads[0].outcome.provisional, undefined);
  assert.equal(settleCloseReads(same, 0, "2026-11-19"), 0); assert.equal(settleCloseReads(same, 700, null), 0); assert.equal(settleCloseReads(null, 700, "2026-11-19"), 0);
});

test("a chain read before today's open (a chain outage) never sets the gamma factor or its multiplier; a same-day chain does", () => {
  // a mild sell-side tape, so the score sits inside the clamp and the 1.1× negative-gamma multiplier is visible
  const sell = { bars1m: { SPY: day(760, { lateDrift: -0.00005, lateVol: 1200 }), QQQ: day(690, { lateDrift: -0.00005, lateVol: 1200 }), IWM: day(280, { lateDrift: -0.00004, lateVol: 1200 }) }, quotes: {}, breadth: { series: [[at350 - 35 * 60e3, 1500, 1300, 50, 50], [at350 - 60e3, 1350, 1450, 48, 46]] }, sweeps: [{ at: at350 - 5 * 60e3, up: 4e9, dn: 6e9, net: -2e9, total: 10e9, vol: 1, n: 5000 }], label: "15:50" };
  const book = { spot: 7500, flip: 7600, cw: 7700, pw: 7450, gex: -1e9 };
  const fresh = computeCloseRead({ now: at350, et, ...sell, scan: { SPX: { ...book, at: T0 + 60e3 } } });
  assert.equal(fresh.factors.gamma.regime, "negative"); assert.ok(!fresh.factors.gamma.stale); assert.match(fresh.text, /negative gamma/);
  // the same book stamped the previous afternoon: reported stale, no 1.1× negative-gamma amplification
  const stale = computeCloseRead({ now: at350, et, ...sell, scan: { SPX: { ...book, at: T0 - 18 * 3600e3 } } });
  assert.equal(stale.factors.gamma.stale, true); assert.equal(stale.factors.gamma.at, T0 - 18 * 3600e3); assert.match(stale.factors.gamma.reason, /before today's open/);
  assert.match(stale.text, /SPX gamma not read/); assert.ok(!/negative gamma/.test(stale.text));
  assert.ok(fresh.score < 0 && fresh.score > -90, "inside the clamp: " + fresh.score); assert.ok(Math.abs(stale.score) < Math.abs(fresh.score), `no multiplier on a stale book: ${stale.score} vs ${fresh.score}`); assert.ok(Math.abs(fresh.score / stale.score - 1.1) < 0.03, `${fresh.score} / ${stale.score}`);
  // an unstamped book whose spot sits far from the live SPX quote (the book is from another tape) is stale too; a close one is not
  const drifted = computeCloseRead({ now: at350, et, ...sell, quotes: { SPX: { price: 7200 } }, scan: { SPX: book } });
  assert.equal(drifted.factors.gamma.stale, true); assert.match(drifted.factors.gamma.reason, /1\.5%/);
  const near = computeCloseRead({ now: at350, et, ...sell, quotes: { SPX: { price: 7490 } }, scan: { SPX: book } });
  assert.equal(near.factors.gamma.regime, "negative");
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

test("app: closeReadSettledNote says whether a verdict is provisional, official, or re-judged from a different 4:03 print", async () => {
  const fs = await import("node:fs"); const vm = await import("node:vm");
  const html = fs.readFileSync(new URL("../app.html", import.meta.url), "utf8"); const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const i = js.indexOf("function closeReadSettledNote("); assert.ok(i >= 0, "closeReadSettledNote lives in app.html"); let j = js.indexOf("{", i), depth = 0; for (; j < js.length; j++) { if (js[j] === "{") depth++; else if (js[j] === "}") { depth--; if (!depth) break; } }
  const ctx = {}; vm.createContext(ctx); vm.runInContext(js.slice(i, j + 1) + "\nthis.note = closeReadSettledNote;", ctx);
  assert.equal(ctx.note(null), "");
  assert.match(ctx.note({ close: 722.31, hit: false }), /Provisional — judged on the 4:03 PM price/);
  assert.equal(ctx.note({ close: 715.87, hit: false, official: true }), " Official close.");
  const re = ctx.note({ close: 689.81, movePct: 0.372, hit: false, official: true, provisional: { close: 687.52, movePct: 0.04, hit: false } });
  assert.match(re, /Official close 689.81; the 4:03 PM print was 687.52 \(\+0.04%\)\./);
  assert.match(ctx.note({ close: 689.81, movePct: 0.372, hit: false, official: true, provisional: { close: 687.5, movePct: -0.2, hit: true } }), /first judged a right call/);
});

test("app: closeReadShift puts the 3:50 read beside the 3:58 only when the call changed, naming the factors that moved", async () => {
  const fs = await import("node:fs"); const vm = await import("node:vm");
  const html = fs.readFileSync(new URL("../app.html", import.meta.url), "utf8"); const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const i = js.indexOf("function closeReadShift("); assert.ok(i >= 0, "closeReadShift lives in app.html"); let j = js.indexOf("{", i), depth = 0; for (; j < js.length; j++) { if (js[j] === "{") depth++; else if (js[j] === "}") { depth--; if (!depth) break; } }
  const ctx = { Math }; vm.createContext(ctx); // values come back from the vm realm, so compare copies, not prototypes
  vm.runInContext(js.slice(i, j + 1) + "\nthis.closeReadShift = closeReadShift;", ctx);
  const read = (label, side, grade, score, f) => ({ date: "2026-11-16", label, side, grade, score, factors: { flow: { score: f[0] }, market: { score: f[1] }, index: { score: f[2] }, breadth: { score: f[3] }, pace: { x: 1 } } });
  const first = read("15:50", "BUY", "B", 42, [38, 40, 12, 20]);
  assert.equal(ctx.closeReadShift(first, read("15:58", "BUY", "B", 39, [36, 41, 10, 18])), null, "same side and grade → nothing to show");
  assert.equal(ctx.closeReadShift(null, first), null); assert.equal(ctx.closeReadShift(first, first), null, "a read beside itself is not a shift");
  assert.equal(ctx.closeReadShift({ ...first, date: "2026-11-13" }, read("15:58", "SELL", "C", -20, [0, 0, 0, 0])), null, "reads from different sessions never pair");
  const sh = ctx.closeReadShift(first, read("15:58", "BALANCED", "D", 5, [1, 52, -59, 10]));
  assert.ok(sh, "side changed → shown"); assert.equal(sh.dScore, -37);
  assert.deepEqual(Array.from(sh.moved, m => m.k), ["index", "flow", "market", "breadth"], "biggest mover first; every factor that moved 5+ points is listed");
  assert.deepEqual({ ...sh.moved[0] }, { k: "index", name: "Indexes", from: 12, to: -59, d: -71 });
  const sh2 = ctx.closeReadShift(first, read("15:58", "BUY", "C", 30, [38, 40, 12, 20])); assert.ok(sh2, "grade changed → shown"); assert.equal(sh2.moved.length, 0, "no factor moved 5 points");
  assert.ok(ctx.closeReadShift(first, { ...read("15:58", "SELL", "B", -40, [0, 0, 0, 0]), factors: {} }), "missing factors still pair without throwing");
});

test("app: closeReadRecords keeps a record per read time — the 3:58 read earns its own, balanced reads are not counted, grades sort A → D", async () => {
  const fs = await import("node:fs"); const vm = await import("node:vm");
  const html = fs.readFileSync(new URL("../app.html", import.meta.url), "utf8"); const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const i = js.indexOf("function closeReadRecords("); assert.ok(i >= 0, "closeReadRecords lives in app.html"); let j = js.indexOf("{", i), depth = 0; for (; j < js.length; j++) { if (js[j] === "{") depth++; else if (js[j] === "}") { depth--; if (!depth) break; } }
  const k = js.indexOf("const closeReadRecordText ="); assert.ok(k > j, "closeReadRecordText follows it"); const kEnd = js.indexOf("\n", k);
  const c = js.indexOf("const crKind ="); assert.ok(c >= 0, "crKind lives in app.html"); const cEnd = js.indexOf("\n", c);
  const ctx = { Object }; vm.createContext(ctx); vm.runInContext(js.slice(c, cEnd) + "\n" + js.slice(i, j + 1) + "\n" + js.slice(k, kEnd) + "\nthis.recs = closeReadRecords; this.txt = closeReadRecordText;", ctx);
  // the real shape of close-reads.json on 2026-11-24: the feed's record (3:50 calls) read 1/4, the 3:58 reads 2/7
  const hit = (date, label, side, grade, h) => ({ date, label, side, grade, score: side === "SELL" ? -40 : 40, outcome: h == null ? { close: 1, movePct: 0.1, dir: "up", hit: null } : { close: 1, movePct: 0.1, dir: "up", hit: h } });
  const reads = [hit("11-12", "15:50", "SELL", "C", false), hit("11-12", "15:58", "SELL", "A", false), hit("11-13", "15:50", "BALANCED", "D", null), hit("11-13", "15:58", "BUY", "B", false),
    hit("11-18", "15:50", "BALANCED", "D", null), hit("11-18", "15:58", "BUY", "C", false), hit("11-19", "15:50", "SELL", "C", false), hit("11-19", "15:58", "SELL", "C", true),
    hit("11-20", "15:50", "SELL", "B", true), hit("11-20", "15:58", "SELL", "A", false), hit("11-23", "15:50", "BUY", "C", false), hit("11-23", "15:58", "SELL", "C", false),
    hit("11-24", "15:50", "BALANCED", "D", null), { date: "11-24", label: "15:58", side: "BUY", grade: "B", score: 47, outcome: { close: 1, movePct: 0.04, dir: "up", hit: true } }, { date: "11-25", label: "15:50", side: "BUY", grade: "B", score: 30 } /* open, no outcome */];
  const r = ctx.recs(reads);
  assert.deepEqual(JSON.parse(JSON.stringify(r.call)), closeReadRecord(reads.filter(x => x.label === "15:50")), "the 3:50 record equals the feed's closeReadRecord on the same reads");
  assert.deepEqual(JSON.parse(JSON.stringify(r.call.all)), { n: 4, hits: 1 }); assert.deepEqual(JSON.parse(JSON.stringify(r.final.all)), { n: 7, hits: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(r.final.byGrade)), { A: { n: 2, hits: 0 }, B: { n: 2, hits: 1 }, C: { n: 3, hits: 1 } });
  assert.equal(ctx.txt(r.final), "2/7 right (A 0/2 · B 1/2 · C 1/3)"); assert.equal(ctx.txt(r.call), "1/4 right (B 1/1 · C 0/3)", "grades in A → D order, not insertion order");
  // a half day's reads (12:50 / 12:58, carrying `kind`) count with the rest instead of opening a third bucket
  const half = ctx.recs([...reads, { ...hit("11-27", "12:50", "SELL", "B", true), kind: "call" }, { ...hit("11-27", "12:58", "SELL", "A", true), kind: "final" }]);
  assert.deepEqual(Object.keys(half).sort(), ["call", "final"]); assert.deepEqual(JSON.parse(JSON.stringify(half.call.all)), { n: 5, hits: 2 }); assert.deepEqual(JSON.parse(JSON.stringify(half.final.byGrade.A)), { n: 3, hits: 1 });
  assert.equal(ctx.txt(undefined), "no judged calls yet"); assert.deepEqual({ ...ctx.recs(null) }, {}); assert.deepEqual({ ...ctx.recs([{ label: "15:58" }]) }, {}, "reads without a grade or outcome are skipped");
});

test("half day: the closing read keys on the session's close — 12:50 / 12:58 / 13:03 on 2026-11-27, 15:50 / 15:58 / 16:03 otherwise", () => {
  assert.equal(sessionCloseMin("2026-11-27"), 13 * 60); assert.equal(sessionCloseMin("2026-12-24"), 13 * 60); assert.equal(sessionCloseMin("2026-11-30"), 16 * 60);
  assert.equal(marketPhase(new Date("2026-11-27T17:55:00Z")), "regular", "12:55 ET on the half day"); assert.equal(marketPhase(new Date("2026-11-27T18:05:00Z")), "post", "13:05 ET: closed for the day");
  assert.equal(marketPhase(new Date("2026-11-26T15:00:00Z")), "closed", "Thanksgiving");
  const half = { closeMin: 13 * 60 };
  // before the fix the loop asked for ph === "regular" && min >= 15:50, which a half day never reaches
  assert.deepEqual(closeReadDue("regular", 12 * 60 + 49, half), null, "a minute early: nothing");
  assert.deepEqual(closeReadDue("regular", 12 * 60 + 50, half), { step: "call", label: "12:50", kind: "call" });
  assert.deepEqual(closeReadDue("regular", 12 * 60 + 53, { ...half, done: "12:50" }), null, "the call is taken once");
  assert.deepEqual(closeReadDue("regular", 12 * 60 + 58, { ...half, done: "12:50" }), { step: "final", label: "12:58", kind: "final", call: null });
  assert.deepEqual(closeReadDue("regular", 12 * 60 + 59, { ...half, done: null }), { step: "final", label: "12:58", kind: "final", call: { label: "12:50", kind: "call" } }, "a missed call is built with the final");
  assert.deepEqual(closeReadDue("regular", 12 * 60 + 59, { ...half, done: "12:58" }), null);
  assert.deepEqual(closeReadDue("post", 13 * 60 + 2, half), null, "the verdict waits three minutes"); assert.deepEqual(closeReadDue("post", 13 * 60 + 3, half), { step: "resolve" });
  assert.deepEqual(closeReadDue("post", 15 * 60 + 50, half), { step: "resolve" }, "15:50 on a half day is after the bell — no read, the verdict is still owed"); assert.deepEqual(closeReadDue("post", 15 * 60 + 50, { ...half, resolved: true }), null);
  assert.deepEqual(closeReadDue("post", 20 * 60, half), null, "the verdict is not taken overnight");
  // a normal day is exactly what it was
  assert.deepEqual(closeReadDue("regular", 15 * 60 + 50, {}), { step: "call", label: "15:50", kind: "call" }); assert.deepEqual(closeReadDue("regular", 15 * 60 + 49, {}), null);
  assert.deepEqual(closeReadDue("regular", 15 * 60 + 58, { done: "15:50" }), { step: "final", label: "15:58", kind: "final", call: null });
  assert.deepEqual(closeReadDue("post", 16 * 60 + 3, { done: "15:58" }), { step: "resolve" }); assert.deepEqual(closeReadDue("post", 16 * 60 + 3, { done: "15:58", resolved: true }), null);
  assert.deepEqual(closeReadDue("pre", 9 * 60, {}), null); assert.deepEqual(closeReadDue("closed", 15 * 60 + 50, {}), null, "no read on a holiday");
  // the record keys on the read's kind; reads written before `kind` existed are told apart by the 15:50 label
  assert.equal(isCallRead({ label: "15:50" }), true); assert.equal(isCallRead({ label: "15:58" }), false); assert.equal(isCallRead({ label: "12:50", kind: "call" }), true); assert.equal(isCallRead({ label: "12:58", kind: "final" }), false);
  const read = computeCloseRead({ now: Date.UTC(2026, 10, 27, 17, 50), et: { date: "2026-11-27", min: 12 * 60 + 50 }, label: "12:50", kind: "call" }); assert.equal(read.kind, "call"); assert.equal(read.label, "12:50");
  assert.equal(computeCloseRead({ now: Date.now(), label: "15:58" }).kind, "final", "the kind follows the label when the caller gives none");
  const hist = { reads: [{ date: "2026-11-27", label: "12:50", kind: "call", side: "SELL", grade: "B", spy: { px: 700 } }, { date: "2026-11-27", label: "12:58", kind: "final", side: "SELL", grade: "A", spy: { px: 699 } }] };
  assert.equal(settleCloseReads(hist, 697, "2026-11-27", 1), 2); assert.deepEqual(hist.record, { byGrade: { B: { n: 1, hits: 1 } }, all: { n: 1, hits: 1 } }, "the half day's call joins the record, its final does not");
});

test("half day: the app's session helpers close at 1:00 PM too — the header badge, the regular-bar test, the ext-hours label, the volume pace; the anomaly pace is whole after the early close", async () => {
  // the feed: between 13:00 and 16:00 on 2026-11-27 the premium pace is the whole day's, not 54% of one (before the fix `et.min < 960` kept projecting)
  const an = (date, min) => detectAnomalies({ scan: { rows: {} }, history: { days: {} }, now: Date.UTC(2026, 10, 27, 19), et: { date, min, dow: 5 } }).frac;
  assert.equal(an("2026-11-27", 14 * 60), 1, "2 PM on the half day: the session is over"); assert.ok(Math.abs(an("2026-11-20", 14 * 60) - 270 / 390) < 0.01, "2 PM on a normal Friday: 69% of the day");
  assert.ok(Math.abs(an("2026-11-27", 12 * 60) - 150 / 390) < 0.01, "noon on the half day: the per-minute pace, as on any day");
  // the app, read out of app.html: the helpers that used to say 960
  const fs = await import("node:fs"); const vm = await import("node:vm");
  const html = fs.readFileSync(new URL("../app.html", import.meta.url), "utf8"); const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const fn = name => { const i = js.indexOf(`function ${name}(`); assert.ok(i >= 0, `${name} lives in app.html`); let j = js.indexOf("{", i), depth = 0; for (; j < js.length; j++) { if (js[j] === "{") depth++; else if (js[j] === "}") { depth--; if (!depth) break; } } return js.slice(i, j + 1); };
  const line = start => { const i = js.indexOf(start); assert.ok(i >= 0, `${start} lives in app.html`); return js.slice(i, js.indexOf("\n", i)); };
  const ctx = { Math, Number, Map, Intl, Date }; vm.createContext(ctx);
  vm.runInContext([line("const NYSE_HALF_DAYS ="), fn("sessionCloseMinOf"), line("const closeClock ="), line("const ET_CACHE ="), fn("etInfo"), fn("isRegularBar"), fn("extState"), fn("sessionFraction"), fn("marketStateText")].join("\n")
    + "\nthis.o = { sessionCloseMinOf, closeClock, isRegularBar, extState, sessionFraction, marketStateText };", ctx);
  const o = ctx.o; const et = (h, m, d = 27) => Date.UTC(2026, 10, d, h + 5, m); // ET + 5h = UTC in November
  assert.equal(o.sessionCloseMinOf("2026-11-27"), 13 * 60); assert.equal(o.sessionCloseMinOf("2026-11-30"), 16 * 60); assert.equal(o.closeClock("2026-11-27"), "1:00 PM"); assert.equal(o.closeClock("2026-11-30"), "4:00 PM");
  assert.equal(o.marketStateText("regular", 5, "2026-11-27"), "Regular session · closes 1:00 PM (early close)"); assert.equal(o.marketStateText("regular", 1, "2026-11-30"), "Regular session · closes 4:00 PM");
  assert.equal(o.marketStateText("post", 5, "2026-11-27"), "After hours · until 8:00 PM (1:00 PM close)"); assert.equal(o.marketStateText("closed", 6, "2026-11-28"), "Closed · overnight session opens Sun 8:00 PM");
  assert.equal(o.isRegularBar(et(13, 0)), true, "the 1:00 PM bar is the closing print"); assert.equal(o.isRegularBar(et(13, 1)), false); assert.equal(o.isRegularBar(et(15, 59, 30)), true, "3:59 PM on a normal day");
  assert.equal(o.extState({ t: et(13, 30) }), "POST", "1:30 PM on the half day is after hours"); assert.equal(o.extState({ t: et(13, 30, 30) }), false, "1:30 PM on a normal day is not"); assert.equal(o.extState({ t: et(8, 0) }), "PRE"); assert.equal(o.extState({ state: "POST" }), "POST", "the feed's state wins");
  assert.equal(o.sessionFraction(et(14, 0)), 1, "the half day is whole by 2 PM"); assert.ok(Math.abs(o.sessionFraction(et(14, 0, 30)) - 270 / 390) < 0.01); assert.ok(Math.abs(o.sessionFraction(et(12, 0)) - 150 / 390) < 0.01, "noon: the per-minute pace");
});
