// The Lab's long daily history job: Yahoo rows → adjusted compact bars, batches, freshness, 429 backoff.   `node --test test/history.test.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeHistory, refreshHistory, HIST_VERSION } from "../scripts/history.mjs";

const day = i => Date.UTC(2024, 0, 2 + i, 14, 30) / 1000; // 9:30 ET stamps, like Yahoo's daily rows
function payload(n, { adjRatio = 0.5 } = {}) { const ts = [], open = [], high = [], low = [], close = [], volume = [], adj = []; for (let i = 0; i < n; i++) { ts.push(day(i)); const c = 100 + i; open.push(c - 0.5); high.push(c + 1); low.push(c - 1); close.push(c); volume.push(1000 + i); adj.push(c * adjRatio); } return { chart: { result: [{ timestamp: ts, indicators: { quote: [{ open, high, low, close, volume }], adjclose: [{ adjclose: adj }] }, meta: { currency: "USD", exchangeName: "NMS" }, events: { splits: { a: { date: day(3), numerator: 2, denominator: 1, splitRatio: "2:1" } }, dividends: { b: { date: day(5), amount: 0.25 } } } }] } }; }
const fakeFetch = (behaviour = {}) => async url => { const sym = decodeURIComponent(url.split("/chart/")[1].split("?")[0]); if (behaviour[sym] === 429) return { ok: false, status: 429 }; if (behaviour[sym] === 500) return { ok: false, status: 500 }; return { ok: true, status: 200, json: async () => payload(behaviour.n || 60) }; };

test("normalizeHistory applies the adjclose ratio to o/h/l/c, keeps the raw close, lists splits and dividends", () => {
  const p = payload(5).chart.result[0]; const h = normalizeHistory("TEST", p.timestamp, p.indicators.quote[0], p.indicators.adjclose[0].adjclose, p.meta, p.events);
  assert.equal(h.bars.length, 5); assert.deepEqual(h.bars[0], [day(0) * 1000, 49.75, 50.5, 49.5, 50, 1000, 100]); assert.equal(h.cols, "t o h l c v rawClose");
  assert.equal(h.splits.length, 1); assert.equal(h.splits[0].ratio, 2); assert.equal(h.dividends[0].amount, 0.25); assert.equal(h.first, day(0) * 1000); assert.equal(h.last, day(4) * 1000); assert.equal(h.currency, "USD");
  // a null row is skipped, a same-day duplicate keeps the later row, XSP is the S&P divided by ten
  const q2 = { open: [1, null, 3, 3.5], high: [2, 2, 4, 4.5], low: [0.5, 0.5, 2, 2.5], close: [1.5, 1.5, 3.5, 4], volume: [1, 1, 1, 1] }; const ts2 = [day(0), day(1), day(2), day(2) + 3600];
  const h2 = normalizeHistory("XSP", ts2, q2, null, {}, {}); assert.equal(h2.bars.length, 2); assert.equal(h2.bars[1][4], 0.4); assert.equal(h2.bars[0][1], 0.1);
});

test("refreshHistory fetches what is missing or stale in batches, records the index, and backs off on a 429", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kn-hist-")); const log = [];
  const r1 = await refreshHistory({ syms: ["AAA", "BBB", "CCC"], dir, maxPerRun: 2, spacingMs: 0, fetchImpl: fakeFetch(), log: m => log.push(m) });
  assert.equal(r1.fetched, 2); assert.equal(r1.remaining, 1); assert.equal(r1.have, 2); assert.ok(fs.existsSync(path.join(dir, "AAA.json")));
  const idx = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")); assert.equal(idx.syms.AAA.n, 60); assert.equal(idx.syms.AAA.v, HIST_VERSION); assert.equal(idx.n, 2);
  const r2 = await refreshHistory({ syms: ["AAA", "BBB", "CCC"], dir, maxPerRun: 2, spacingMs: 0, fetchImpl: fakeFetch(), log: m => log.push(m) }); assert.equal(r2.fetched, 1, "only the missing one"); assert.equal(r2.remaining, 0);
  const r3 = await refreshHistory({ syms: ["AAA", "BBB", "CCC"], dir, maxPerRun: 2, spacingMs: 0, fetchImpl: fakeFetch(), log: m => log.push(m) }); assert.equal(r3.fetched, 0, "all fresh");
  // stale after maxAgeDays → refetched; a short history is a failure, a 429 stops the batch
  const stale = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")); stale.syms.AAA.at = Date.now() - 8 * 86400e3; fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(stale));
  const r4 = await refreshHistory({ syms: ["AAA", "BBB", "CCC", "DDD", "EEE"], dir, maxPerRun: 5, spacingMs: 0, fetchImpl: fakeFetch({ DDD: 429 }), log: m => log.push(m) });
  assert.equal(r4.fetched, 1, "AAA refreshed"); assert.equal(r4.limited, true); assert.ok(r4.remaining >= 1, "EEE still to go after the 429"); assert.match(log.at(-1), /429/);
  const r5 = await refreshHistory({ syms: ["FFF"], dir, maxPerRun: 5, spacingMs: 0, fetchImpl: fakeFetch({ n: 10 }), log: m => log.push(m) }); assert.equal(r5.failed, 1); assert.match(log.at(-1), /short history/);
  fs.rmSync(dir, { recursive: true, force: true });
});
