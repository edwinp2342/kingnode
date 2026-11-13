// The macro job: BLS series → readings, EFFR → target range, FRED dates → releases, dedupe against the hand-verified calendar, and the
// whole fetch with the network stubbed (every source answering, then every source failing).  `node --test test/macro.test.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { blsSeriesToReadings, targetRangeFromEffr, fredDatesToReleases, dedupeReleases, fetchMacro } from "../scripts/macro.mjs";

const series = (id, rows) => ({ seriesID: id, data: rows.map(([year, period, value]) => ({ year, period, periodName: period, value: String(value) })) });
const months = (id, start, vals) => { const out = []; let [y, m] = start.split("-").map(Number); for (const v of vals) { out.push([String(y), "M" + String(m).padStart(2, "0"), v]); m++; if (m > 12) { m = 1; y++; } } return series(id, out.reverse()); }; // BLS lists newest first

test("BLS series become CPI m/m and y/y, unemployment with its prior, payroll changes", () => {
  const cpi = months("CUSR0000SA0", "2025-09", [310, 311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321, 322]); // 13 months → y/y from the first
  const core = months("CUSR0000SA0L1E", "2025-09", [320, 321, 322, 323, 324, 325, 326, 327, 328, 329, 330, 331, 332]);
  const un = months("LNS14000000", "2026-07", [4.2, 4.3, 4.4]);
  const pay = months("CES0000000001", "2026-07", [159000, 159119, 159140]);
  const d = blsSeriesToReadings([cpi, core, un, pay, series("CES0500000003", [["2026", "M09", "36.5"], ["2026", "M08", "36.4"], ["2025", "M09", "35.2"]])], Date.parse("2026-11-03T16:00:00Z"));
  assert.equal(d.cpi.period, "2026-09"); assert.equal(d.cpi.index, 322); assert.equal(d.cpi.mom, +((322 / 321 - 1) * 100).toFixed(2)); assert.equal(d.cpi.yoy, +((322 / 310 - 1) * 100).toFixed(2)); assert.equal(d.cpi.coreYoy, +((332 / 320 - 1) * 100).toFixed(2));
  assert.deepEqual({ ...d.unemployment }, { period: "2026-09", rate: 4.4, prior: 4.3, src: "bls" });
  assert.equal(d.payrolls.change, 21); assert.equal(d.payrolls.priorChange, 119); assert.equal(d.payrolls.unit, "thousands");
  assert.equal(d.hourlyEarnings.yoy, +((36.5 / 35.2 - 1) * 100).toFixed(2)); assert.equal(d.asOf, "2026-11-03T16:00:00.000Z");
  assert.equal(blsSeriesToReadings([series("CUSR0000SA0", [["2026", "M13", "1"]])]).cpi, undefined, "annual averages (M13) are not months");
});

test("the target range is the quarter-point band the effective rate sits in", () => {
  assert.equal(targetRangeFromEffr(3.88), "3.75–4.00%"); assert.equal(targetRangeFromEffr(4.33), "4.25–4.50%"); assert.equal(targetRangeFromEffr(5.33), "5.25–5.50%"); assert.equal(targetRangeFromEffr(0), null);
});

test("FRED release dates get an impact from their name; duplicates of hand-verified lines are dropped", () => {
  const rel = fredDatesToReleases({ release_dates: [{ release_name: "Consumer Price Index", date: "2026-11-10" }, { release_name: "Employment Situation", date: "2026-11-06" }, { release_name: "Producer Price Index", date: "2026-11-13" }, { release_name: "Weekly Natural Gas Storage", date: "2026-11-12" }, { date: "2026-11-12" }] });
  assert.deepEqual(rel.map(r => [r.name, r.impact]), [["Consumer Price Index", 3], ["Employment Situation", 3], ["Producer Price Index", 2], ["Weekly Natural Gas Storage", 1]]);
  const merged = dedupeReleases([{ date: "2026-11-10", time: "08:30", name: "CPI (October) + real earnings", impact: 3, src: "bls" }, ...rel, { date: "2026-11-12", time: "08:30", name: "Jobless claims", impact: 1, src: "static" }]);
  assert.ok(!merged.some(r => r.src === "fred" && /Consumer Price/.test(r.name)), "the FRED CPI line duplicates the verified BLS line");
  assert.ok(merged.some(r => r.src === "fred" && /Employment Situation/.test(r.name)), "a release only FRED knows stays");
  assert.equal(merged.filter(r => r.date === "2026-11-12").length, 2);
});

test("fetchMacro: every source answers; then every source fails and the file still carries the calendar", async () => {
  const realFetch = globalThis.fetch;
  const answers = {
    bls: { status: "REQUEST_SUCCEEDED", Results: { series: [series("CUSR0000SA0", [["2026", "M09", "322"], ["2026", "M08", "321"], ["2025", "M09", "310"]]), series("LNS14000000", [["2026", "M09", "4.3"], ["2026", "M08", "4.3"]])] } },
    nyfed: { refRates: [{ effectiveDate: "2026-11-02", type: "EFFR", percentRate: 3.88 }] },
    yahoo: sym => ({ chart: { result: [{ meta: { regularMarketPrice: sym.includes("TNX") ? 4.11 : sym.includes("IRX") ? 3.92 : 4.4, chartPreviousClose: 4.0 }, indicators: sym.includes("TYX") ? undefined : { quote: [{ close: [4.0, 4.02, null, 4.05, 4.11] }] } }] } }),
  };
  globalThis.fetch = async (url) => { const u = String(url); const ok = body => ({ ok: true, status: 200, json: async () => body }); if (u.includes("api.bls.gov")) return ok(answers.bls); if (u.includes("newyorkfed")) return ok(answers.nyfed); if (u.includes("finance.yahoo")) return ok(answers.yahoo(u)); if (u.includes("stlouisfed")) return ok({ release_dates: [{ release_name: "Employment Situation", date: "2026-12-04" }] }); return { ok: false, status: 404, json: async () => ({}) }; };
  try {
    const doc = await fetchMacro({ now: Date.parse("2026-11-03T16:00:00Z"), fredKey: "test" });
    assert.equal(doc.data.cpi.yoy, +((322 / 310 - 1) * 100).toFixed(2)); assert.equal(doc.data.unemployment.rate, 4.3);
    assert.equal(doc.data.effr.rate, 3.88); assert.equal(doc.data.fedFunds.range, "3.75–4.00%"); assert.equal(doc.data.fedFunds.src, "inferred from EFFR");
    assert.equal(doc.data.yields.t10y, 4.11); assert.equal(doc.data.yields.t3m, 3.92);
    assert.equal(doc.data.yields.t10yPrev, 4.05, "prev is the session before the last bar, not the close before the 5-day range"); assert.equal(doc.data.yields.t30yPrev, 4.0, "no bars: falls back to the meta close");
    assert.match(doc.sources.bls, /^ok/); assert.match(doc.sources.nyfed, /^ok/); assert.match(doc.sources.yields, /^ok · 4\/4/); assert.match(doc.sources.fred, /^ok/); assert.match(doc.sources.calendar, /^static/);
    assert.ok(doc.releases.some(r => r.date === "2026-11-03" && /midterm/i.test(r.name)), "election day is on the calendar");
    assert.ok(doc.releases.some(r => r.date === "2026-11-10" && /CPI/.test(r.name)) && !doc.releases.some(r => r.date === "2026-11-01"), "past dates drop off, CPI Nov 10 is there");
    assert.ok(doc.releases.every((r, i, a) => i === 0 || a[i - 1].date <= r.date), "sorted by date");
    assert.ok(doc.fomc.includes("2026-12-09") && doc.fomc.includes("2027-12-08"));
    globalThis.fetch = async () => { throw new Error("offline"); };
    const dark = await fetchMacro({ now: Date.parse("2026-11-03T16:00:00Z"), fredKey: "" });
    assert.match(dark.sources.bls, /^error/); assert.match(dark.sources.nyfed, /^error/); assert.match(dark.sources.yields, /^error/); assert.equal(dark.sources.fred, undefined);
    assert.equal(dark.data.cpi, undefined); assert.equal(dark.data.fedFunds.src, "static"); assert.equal(dark.data.fedFunds.range, "3.75–4.00%");
    assert.ok(dark.releases.length > 20, "the verified calendar is always there");
  } finally { globalThis.fetch = realFetch; }
});
