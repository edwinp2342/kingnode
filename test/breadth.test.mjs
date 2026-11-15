// Market breadth: the series is one session's, recorded while it trades.   `node --test test/breadth.test.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeBreadth } from "../scripts/market.mjs";

const symbols = { rows: [["AAA", "A", "Q", 0, 1], ["BBB", "B", "Q", 0, 1], ["CCC", "C", "Q", 0, 1]] };
const market = { q: { AAA: [50, 49, 2.0, 1e6], BBB: [20, 21, -4.8, 2e6], CCC: [10, 10, 0, 1e5] } }; // last prev chg% vol
const T = iso => Date.parse(iso);

test("breadth series is keyed by session: weekend sweeps join Friday's row once, the session records through the close", () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kn-breadth-")), "breadth.json");
  // Saturday 17:00 ET: the tape is Friday's session; the file says so and holds one point, not a Saturday "day"
  let b = computeBreadth(market, null, symbols, { path: p, now: T("2026-11-14T22:00:00Z") });
  assert.equal(b.day, "2026-11-13"); assert.equal(b.adv, 1); assert.equal(b.dec, 1); assert.equal(b.unch, 1); assert.equal(b.series.length, 1);
  b = computeBreadth(market, null, symbols, { path: p, now: T("2026-11-15T03:00:00Z") });
  assert.equal(b.day, "2026-11-13"); assert.equal(b.series.length, 1, "a second closed-market sweep adds nothing");
  // Monday 08:00 ET: still Friday's session, still no new point
  b = computeBreadth(market, null, symbols, { path: p, now: T("2026-11-16T13:00:00Z") });
  assert.equal(b.day, "2026-11-13"); assert.equal(b.series.length, 1);
  // Monday's open starts a fresh series and records every sweep while the market trades
  b = computeBreadth(market, null, symbols, { path: p, now: T("2026-11-16T14:35:00Z") });
  assert.equal(b.day, "2026-11-16"); assert.equal(b.series.length, 1);
  b = computeBreadth(market, null, symbols, { path: p, now: T("2026-11-16T15:05:00Z") }); assert.equal(b.series.length, 2);
  b = computeBreadth(market, null, symbols, { path: p, now: T("2026-11-16T20:55:00Z") }); assert.equal(b.series.length, 3);
  // the first sweep after the close records the closing values; later ones do not
  b = computeBreadth(market, null, symbols, { path: p, now: T("2026-11-16T21:05:00Z") }); assert.equal(b.series.length, 4);
  b = computeBreadth(market, null, symbols, { path: p, now: T("2026-11-16T22:05:00Z") }); assert.equal(b.series.length, 4);
  assert.equal(b.series[3][0], T("2026-11-16T21:05:00Z"));
  assert.deepEqual(b.series[3].slice(1, 3), [1, 1]); assert.equal(b.seriesCols, "t adv dec above50pct upDollarPct");
});
