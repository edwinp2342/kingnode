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
  const src4 = grab("printSide") + "\n" + grab("chainFlow");
  const rows = [["2026-12-18", "C", 100, 500, 120, 0.3, 0.01, 0.5, 1.0, 1.2, 1.2], ["2026-12-18", "P", 95, 50, 40, 0.3, 0.01, -0.3, 2.0, 2.2, 2.0], ["2026-12-18", "C", 110, 10, 0, 0.3, 0.01, 0.2, 0.5, 0.6, 0.55], ["2026-12-18", "P", 90, 500, 300, 0.3, 0.01, -0.2, 98.7, 99.5, 82.9]];
  const c4 = { Math, Date, Map, Set, Array, Object, isFinite, Number, String, S: { chain: { rows, asOf: "2026-10-12 15:00:00" }, calc: {}, demo: false, allExps: ["2026-12-18"], sym: "T" } };
  vm.createContext(c4); vm.runInContext(src4 + "\nthis.chainFlow = chainFlow;", c4);
  const t = c4.chainFlow();
  assert.equal(t.length, 3, "contracts with zero volume are not prints");
  const by = K => t.find(x => x.K === K);
  assert.equal(by(100).side, "A", "last at the ask"); assert.equal(by(100).sz, 120); assert.equal(by(100).prem, Math.round(1.2 * 120 * 100));
  assert.equal(by(95).side, "B", "last at the bid"); assert.equal(by(95).kind, "volume");
  assert.equal(by(90).side, "M", "a last print far outside the current spread (quote moved since the trade) says nothing about the side — it is not 'sold at the bid'");
  c4.S.demo = true; assert.equal(c4.chainFlow().length, 0, "demo mode never fabricates flow here");
});
test("Ava can log what she is told: open, close, note — and never on a bad payload", () => {
  const names = ["fmt", "money", "JR_KEY", "getJournal", "setJournal", "PB_KEY", "PB_DEF", "getPb", "setPb", "uidj", "journalOpen", "journalClose", "AVA_NOTES_KEY", "avaNotes", "avaRemember", "avaForget", "ediApply", "ediRunActions"];
  const src5 = names.map(grab).join("\n");
  const store = new Map(); const localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const c5 = { Math, Date, Number, Map, Set, Array, Object, isFinite, String, JSON, Intl, localStorage, console, chainSnapshot: () => null, goSym: () => {}, renderTabs: () => {}, dte: () => 30, S: { tab: "x" }, marketDate: ctx.marketDate };
  vm.createContext(c5); vm.runInContext(src5 + "\nthis.ediApply = ediApply; this.ediRunActions = ediRunActions; this.getPb = getPb; this.getJournal = getJournal; this.avaNotes = avaNotes;", c5);
  const r1 = c5.ediRunActions('Logged it.\n<<kn {"action":"open","sym":"hood","kind":"option","cp":"C","strike":115,"exp":"2026-11-20","qty":2,"entry":3.4,"date":"2026-10-12","why":"flow at the ask"}>>');
  assert.equal(r1.text, "Logged it.", "action lines are stripped from what the user sees");
  assert.equal(r1.actions.length, 1); assert.ok(r1.actions[0].ok, r1.actions[0].msg);
  const pb = c5.getPb(); assert.equal(pb.positions.length, 1); assert.equal(pb.positions[0].sym, "HOOD"); assert.equal(pb.positions[0].K, 115);
  const j = c5.getJournal(); assert.equal(j.length, 1); assert.equal(j[0].strike, 115); assert.equal(j[0].expiration, "2026-11-20");
  const r2 = c5.ediRunActions('Closed.\n<<kn {"action":"close","sym":"HOOD","strike":115,"exp":"2026-11-20","exit":4.1,"why":"took 20%"}>>');
  assert.ok(r2.actions[0].ok, r2.actions[0].msg); assert.match(r2.actions[0].msg, /\+\$140/, "2 contracts × (4.10 − 3.40) × 100 = +$140");
  assert.ok(c5.getPb().positions[0].closed, "position marked closed"); assert.equal(c5.getJournal()[0].exit, 4.1);
  const r3 = c5.ediRunActions('<<kn {"action":"open","sym":"NFLY","kind":"shares","qty":65,"entry":15.2}>> <<kn {"action":"note","text":"buys the income sleeve weekly"}>>');
  assert.ok(r3.actions.every(a => a.ok), JSON.stringify(r3.actions)); assert.equal(c5.avaNotes().length, 1);
  const r4 = c5.ediRunActions('<<kn {"action":"close","sym":"NFLY","kind":"shares","exit":16}>>');
  assert.match(r4.actions[0].msg, /\+\$52/, "65 shares × 0.80 = +$52, not ×100");
  const r5 = c5.ediRunActions('<<kn {"action":"open","sym":"TLT","kind":"option","cp":"C","strike":80}>> <<kn {"action":"close","sym":"ZZZ","exit":1}>> <<kn {not json}>>');
  assert.ok(r5.actions.every(a => !a.ok), "missing fields, unknown position and bad JSON all refuse"); assert.equal(c5.getPb().positions.length, 2, "nothing half-written");
});
test("feed: today's session is folded into the daily series from the 5-minute bars", async () => {
  const src = fs.readFileSync(new URL("../scripts/snapshot.mjs", import.meta.url), "utf8"); const i = src.indexOf("export function withToday"); let j = src.indexOf("{", i), d = 0; for (; j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}") { d--; if (!d) break; } }
  const withToday = new Function(src.slice(i + 7, j + 1) + "; return withToday;")();
  const day = (s, h = 13, m = 30) => Date.parse(`${s}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  const daily = [[day("2026-10-09"), 100, 101, 99, 100.5, 1000], [day("2026-10-12"), 101, 102, 100, 101.5, 1100]];
  const session = { regularStart: day("2026-10-13"), regularEnd: day("2026-10-13", 20, 0) };
  const intra = [[day("2026-10-13", 13, 25), 90, 90, 90, 90, 5], [day("2026-10-13", 13, 30), 102, 103, 101.5, 102.5, 10], [day("2026-10-13", 15, 0), 102.5, 104, 102, 103.8, 20], [day("2026-10-13", 20, 5), 50, 50, 50, 50, 7]];
  const out = withToday(daily, intra, session);
  assert.equal(out.length, 3, "a new session is appended"); assert.deepEqual(out[2], [session.regularStart, 102, 104, 101.5, 103.8, 30], "open/high/low/close/volume from regular-session bars only");
  const again = withToday(out, intra, session); assert.equal(again.length, 3, "running it twice replaces, never duplicates");
  assert.equal(withToday(daily, [], session).length, 2, "no intraday bars → unchanged");
});
test("feed: previous close for the movers comes from the prior session's last regular bar, not Yahoo's 5-day window", () => {
  const src = fs.readFileSync(new URL("../scripts/snapshot.mjs", import.meta.url), "utf8");
  const grabF = name => { const i = src.indexOf(`function ${name}`); let j = src.indexOf("{", i), d = 0; for (; j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}") { d--; if (!d) break; } } return src.slice(i, j + 1); };
  const fmtLine = src.slice(src.indexOf("const ET_FMT"), src.indexOf("\n", src.indexOf("const ET_FMT")));
  const prevSessionClose = new Function(fmtLine + "\n" + grabF("etParts") + "\n" + grabF("prevSessionClose") + "; return prevSessionClose;")();
  const t = (d, h, m) => Date.parse(`${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-04:00`); // ET (EDT)
  const bars = [[t("2026-10-13", 15, 55), 0, 0, 0, 112.0, 1], [t("2026-10-13", 19, 55), 0, 0, 0, 111.1, 1] /* after-hours print */, [t("2026-10-14", 9, 30), 0, 0, 0, 108, 1], [t("2026-10-14", 15, 55), 0, 0, 0, 100.6, 1]];
  const session = { regularStart: t("2026-10-14", 9, 30), prevClose: 140.68 /* Yahoo's 5-day-window value — wrong for a daily change */ };
  assert.equal(prevSessionClose(bars, session), 112, "the 3:55 PM regular bar of the prior session, not the after-hours print and not Yahoo's number");
  assert.equal(prevSessionClose([[t("2026-10-14", 9, 30), 0, 0, 0, 108, 1]], session), 140.68, "falls back to Yahoo when there is no prior session in the window");
});
test("app: the chart knows whose bars it is holding (symbol switch reloads; same key dedupes), and greeks print as decimals", () => {
  const fm = new Function(grab("barsMetaMatches") + "\n" + grab("barsCurrent") + "\n" + grab("fmtGreek") + "\n" + grab("fmt") + "; return { barsMetaMatches, barsCurrent, fmtGreek };")();
  globalThis.S = { sym: "SPX", set: { interval: "5m", chartRange: "5d", extended: true }, bars: [[0, 1, 1, 1, 1, 1]], barsMeta: { sym: "SPX", iv: "5m", rg: "5d", ext: true } };
  assert.equal(fm.barsMetaMatches(), true); assert.equal(fm.barsCurrent(), true);
  S.sym = "HOOD"; assert.equal(fm.barsMetaMatches(), false, "another ticker's bars never pass as this one's");
  S.sym = "SPX"; S.set.interval = "1d"; assert.equal(fm.barsMetaMatches(), false, "interval change → reload");
  S.set.interval = "5m"; S.bars = null; assert.equal(fm.barsMetaMatches(), true, "no bars for this exact key (already tried) → no reload loop"); assert.equal(fm.barsCurrent(), false);
  delete globalThis.S;
  assert.equal(fm.fmtGreek(2e-4), "0.0002"); assert.equal(fm.fmtGreek(0.000123456), "0.000123"); assert.equal(fm.fmtGreek(0.0421), "0.0421"); assert.equal(fm.fmtGreek(-0.00007), "-0.00007"); assert.equal(fm.fmtGreek(0), "0"); assert.equal(fm.fmtGreek(NaN), "—");
});
