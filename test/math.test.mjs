// Unit tests for the positioning math. Runs the app's own computeFrom (extracted from app.html) and the server's levels.js
// against a synthetic chain with known answers. `node --test test/math.test.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { computeLevels } from "../api/_lib/levels.js";

const html = fs.readFileSync(new URL("../app.html", import.meta.url), "utf8");
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function grab(name) {
  let i = js.indexOf(`function ${name}(`); if (i >= 0) { let j = js.indexOf("{", i), depth = 0; for (; j < js.length; j++) { if (js[j] === "{") depth++; else if (js[j] === "}") { depth--; if (!depth) break; } } return js.slice(i, j + 1); }
  i = js.indexOf(`const ${name} = `); if (i < 0) throw new Error("not found " + name); const j = js.indexOf("\n", i); return js.slice(i, j);
}
const src = [grab("erf"), grab("dte"), grab("etOffsetMinutes"), grab("marketDate"), grab("parseExchangeTime"), grab("etNowParts"), grab("liveExps"), grab("dealerSide"), grab("computeFrom"), grab("bsPrice")].join("\n");
const ctx = { Math, Date, Number, Map, Set, Array, Object, isFinite, console, String, Intl, S: { set: { freshMinVol: 500, freshRatio: 1.5 } } };
vm.createContext(ctx); vm.runInContext(src + "\nthis.computeFrom = computeFrom; this.bsPrice = bsPrice; this.erf = erf; this.dealerSide = dealerSide; this.parseExchangeTime = parseExchangeTime; this.marketDate = marketDate;", ctx);

const today = new Date(); const d = n => { const x = new Date(today); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
function chain(spot = 100) {
  const rows = [];
  for (const exp of [d(2), d(9), d(30)]) for (let K = 90; K <= 110; K += 1) {
    const callOI = K === 105 ? 50000 : 1000, putOI = K === 95 ? 40000 : 1000, gamma = 0.03 * Math.exp(-Math.pow((K - spot) / 4, 2));
    rows.push([exp, "C", K, callOI, 100, 0.2, gamma, 0.5, 1, 1.1, 1.05]);
    rows.push([exp, "P", K, putOI, 100, 0.2, gamma, -0.5, 1, 1.1, 1.05]);
  }
  return { symbol: "TEST", spot, asOf: new Date().toISOString(), rows };
}

test("walls and sign conventions (app)", () => {
  const c = ctx.computeFrom(chain(), [d(2), d(9), d(30)], 15, "standard");
  assert.equal(c.callWall.K, 105, "call wall at the 50K call strike");
  assert.equal(c.putWall.K, 95, "put wall at the 60K put strike");
  const s105 = c.strikes.find(s => s.K === 105), s95 = c.strikes.find(s => s.K === 95);
  assert.ok(s105.gex > 0, "dealers long calls → positive gamma at the call wall");
  assert.ok(s95.gex < 0, "dealers short puts → negative gamma at the put wall");
  assert.ok(c.flip >= 95 && c.flip <= 105, "flip sits between the walls (interpolated): " + c.flip);
  assert.equal(typeof c.flipConf, "string");
});
test("short-all model flips call sign", () => {
  const c = ctx.computeFrom(chain(), [d(30)], 15, "short");
  assert.ok(c.strikes.find(s => s.K === 105).gex < 0);
});
test("gamma scales with spot^2 and OI", () => {
  const a = ctx.computeFrom(chain(100), [d(30)], 15, "standard").strikes.find(s => s.K === 105).cG;
  const b = ctx.computeFrom({ ...chain(100), rows: chain(100).rows.map(r => r[1] === "C" && r[2] === 105 ? [...r.slice(0, 3), 100000, ...r.slice(4)] : r) }, [d(30)], 15, "standard").strikes.find(s => s.K === 105).cG;
  assert.ok(Math.abs(b / a - 2) < 1e-6, "doubling OI doubles gamma exposure");
});
test("expected move equals the ATM straddle", () => {
  const c = ctx.computeFrom(chain(), [d(2)], 15, "standard");
  assert.ok(Math.abs(c.em[0].move - 2.1) < 1e-6, "call mid + put mid at the ATM strike");
});
test("Black-Scholes sanity", () => {
  const call = ctx.bsPrice(100, 100, 0.25, 0.2, "C"), put = ctx.bsPrice(100, 100, 0.25, 0.2, "P");
  assert.ok(Math.abs(call - put) < 1e-9, "put-call parity at r=0");
  assert.ok(call > 3.9 && call < 4.1, "ATM 3-month 20% vol ≈ 3.99");
  assert.equal(ctx.bsPrice(120, 100, 0, 0.2, "C"), 20, "intrinsic at expiry");
});
test("expired expiries are dropped", () => {
  const past = new Date(); past.setDate(past.getDate() - 3); const old = past.toISOString().slice(0, 10);
  const ch = chain(); ch.rows.push([old, "C", 100, 999999, 100, 0.2, 0.05, 0.5, 1, 1.1, 1.05]);
  const c = ctx.computeFrom(ch, [old, d(30)], 15, "standard");
  assert.ok(!c.byExp.has(old), "an expired date never reaches the map");
});
test("one dealer-side function drives GEX, VEX and DEX", () => {
  const c = ctx.computeFrom(chain(), [d(30)], 15, "standard");
  const s105 = c.strikes.find(s => s.K === 105), s95 = c.strikes.find(s => s.K === 95);
  assert.ok(s105.gex > 0 && s105.dex > 0, "dealers long calls: positive gamma and positive delta at the call wall");
  assert.ok(s95.gex < 0 && s95.dex > 0, "dealers short puts: negative gamma, and short a negative-delta contract = positive delta");
  assert.equal(ctx.dealerSide("x", "C", 100, "flow", new Map([["x|C|100", -1]])), -1, "flow model: net-bought at the ask → dealers short");
  assert.equal(ctx.dealerSide("x", "C", 100, "flow", new Map()), 1, "flow model falls back to standard with no prints");
});
test("zero gamma is computed and sits near the crossover on a symmetric book", () => {
  const c = ctx.computeFrom(chain(), [d(30)], 15, "standard");
  assert.ok(typeof c.zeroGamma === "number" || c.zeroGamma === null);
  if (c.zeroGamma != null) assert.ok(Math.abs(c.zeroGamma - c.flip) < 8, `zero gamma ${c.zeroGamma} vs crossover ${c.flip}`);
});
test("exchange timestamps parse in New York time, DST-aware", () => {
  const summer = ctx.parseExchangeTime("2026-07-06 10:30:00"), winter = ctx.parseExchangeTime("2026-12-07 10:30:00");
  assert.equal(new Date(summer).toISOString(), "2026-07-06T14:30:00.000Z", "EDT = UTC−4");
  assert.equal(new Date(winter).toISOString(), "2026-12-07T15:30:00.000Z", "EST = UTC−5");
  assert.match(ctx.marketDate(), /^\d{4}-\d{2}-\d{2}$/);
});
test("server levels agree with the app on the walls", () => {
  const l = computeLevels(chain(), 3, 15);
  assert.equal(l.callWall, 105); assert.equal(l.putWall, 95);
});

// ---------- trust layer: market clock, staleness, strike binning, chain-volume flow ----------
import { marketPhase, NYSE_HOLIDAYS } from "../scripts/market-clock.mjs";
test("feed market clock: phases, weekends, holidays, half days (ET)", () => {
  assert.equal(marketPhase(new Date("2026-10-12T14:00:00Z")), "regular", "Columbus Day: stocks trade");
  assert.equal(marketPhase(new Date("2026-10-12T10:30:00Z")), "pre");
  assert.equal(marketPhase(new Date("2026-10-12T22:00:00Z")), "post");
  assert.equal(marketPhase(new Date("2026-10-13T01:00:00Z")), "closed");
  assert.equal(marketPhase(new Date("2026-10-17T15:00:00Z")), "closed", "Saturday");
  assert.equal(marketPhase(new Date("2026-11-26T15:00:00Z")), "closed", "Thanksgiving");
  assert.equal(marketPhase(new Date("2026-11-27T17:30:00Z")), "regular", "Black Friday before 1pm");
  assert.equal(marketPhase(new Date("2026-11-27T18:30:00Z")), "post", "Black Friday after the 1pm close");
  assert.ok(NYSE_HOLIDAYS.has("2026-12-25"));
});
test("app market clock matches the feed's, and staleness only counts while the market is open", () => {
  const src2 = [grab("marketPhase"), grab("marketOpenNow"), grab("isStale"), grab("NYSE_HOLIDAYS"), grab("NYSE_HALF_DAYS")].join("\n");
  const c2 = { Math, Date, Number, Map, Set, Array, Object, isFinite, String, Intl, marketDate: ctx.marketDate };
  vm.createContext(c2); vm.runInContext(src2 + "\nthis.marketPhase = marketPhase; this.isStale = isStale;", c2);
  for (const iso of ["2026-10-12T14:00:00Z", "2026-10-12T10:30:00Z", "2026-10-12T22:00:00Z", "2026-10-13T01:00:00Z", "2026-10-17T15:00:00Z", "2026-11-26T15:00:00Z", "2026-11-27T18:30:00Z"])
    assert.equal(c2.marketPhase(Date.parse(iso)), marketPhase(new Date(iso)), iso);
  const RealDate = Date;
  const at = iso => { const fixed = RealDate.parse(iso); c2.Date = class extends RealDate { constructor(...a){ super(...(a.length ? a : [fixed])); } static now(){ return fixed; } static parse(x){ return RealDate.parse(x); } }; vm.runInContext("Date = this.Date", c2); };
  at("2026-10-12T15:00:00Z"); // Monday 11:00 ET, market open
  assert.equal(c2.isStale(RealDate.parse("2026-10-12T14:00:00Z"), 40), true, "an hour-old snapshot during the session is stale");
  assert.equal(c2.isStale(RealDate.parse("2026-10-12T14:50:00Z"), 40), false, "10 minutes old is fine");
  at("2026-10-17T15:00:00Z"); // Saturday
  assert.equal(c2.isStale(RealDate.parse("2026-10-16T20:00:00Z"), 40), false, "Friday's close on a Saturday is the last session, not stale");
});
test("strike binning keeps dense chains readable and sums exposures", () => {
  const src3 = [grab("autoStrikeStep"), grab("binCells")].join("\n");
  const c3 = { Math, Map, Set, Array, Object, isFinite, Number }; vm.createContext(c3); vm.runInContext(src3 + "\nthis.autoStrikeStep = autoStrikeStep; this.binCells = binCells;", c3);
  const ks5 = []; for (let k = 7400; k <= 8200; k += 5) ks5.push(k);
  assert.equal(c3.autoStrikeStep(ks5), 25, "SPX 5-point strikes → 25-point bins");
  assert.equal(c3.autoStrikeStep([95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105]), 1, "a short list is not binned");
  const byCell = new Map(); for (const K of [7800, 7805, 7810]) byCell.set("e|" + K, { exp: "e", K, gex: K === 7805 ? -5 : 2, vex: 1, dex: 1, cG: 1, pG: 1, cOI: 10, pOI: 10, cVol: 1, pVol: 1 });
  const b = c3.binCells({ byCell }, 25); const cell = b.get("e|7800");
  assert.equal(cell.gex, -1, "exposures sum inside the bin"); assert.equal(cell.rep, 7805, "the strongest real strike represents the bin"); assert.equal(cell.cOI, 30);
});
test("chain-volume flow is real data: size = volume, side = where the last print sat, never synthetic", () => {
  const src4 = grab("chainFlow");
  const rows = [["2026-12-18", "C", 100, 500, 120, 0.3, 0.01, 0.5, 1.0, 1.2, 1.2], ["2026-12-18", "P", 95, 50, 40, 0.3, 0.01, -0.3, 2.0, 2.2, 2.0], ["2026-12-18", "C", 110, 10, 0, 0.3, 0.01, 0.2, 0.5, 0.6, 0.55]];
  const c4 = { Math, Date, Map, Set, Array, Object, isFinite, Number, String, S: { chain: { rows, asOf: "2026-10-12 15:00:00" }, calc: {}, demo: false, allExps: ["2026-12-18"], sym: "T" } };
  vm.createContext(c4); vm.runInContext(src4 + "\nthis.chainFlow = chainFlow;", c4);
  const t = c4.chainFlow();
  assert.equal(t.length, 2, "contracts with zero volume are not prints");
  assert.equal(t[0].K, 100); assert.equal(t[0].side, "A", "last at the ask"); assert.equal(t[0].sz, 120); assert.equal(t[0].prem, Math.round(1.2 * 120 * 100));
  assert.equal(t[1].side, "B", "last at the bid"); assert.equal(t[1].kind, "volume");
  c4.S.demo = true; assert.equal(c4.chainFlow().length, 0, "demo mode never fabricates flow here");
});
