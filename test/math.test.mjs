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
  assert.equal(marketPhase(new Date("2026-10-13T01:00:00Z")), "overnight", "Monday 9 PM: the 24-hour session");
  assert.equal(marketPhase(new Date("2026-10-17T01:00:00Z")), "closed", "Friday 9 PM: no overnight session into the weekend");
  assert.equal(marketPhase(new Date("2026-10-19T01:00:00Z")), "overnight", "Sunday 9 PM: the week opens overnight");
  assert.equal(marketPhase(new Date("2026-10-19T07:30:00Z")), "overnight", "Monday 3:30 AM");
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
test("Ideas: the label means the backtested rule — trend + flip alone is not a Buy; every piece present is", () => {
  // analyzeTicker with its dependencies stubbed: computeFrom (real), marketFilters (real), the quant and halal pieces mocked
  const names = ["erf", "dte", "etOffsetMinutes", "marketDate", "parseExchangeTime", "etNowParts", "liveExps", "dealerSide", "computeFrom", "rsi", "ema", "emaArr", "marketFilters", "fmt", "pct", "money", "analyzeTicker"];
  const src = names.map(grab).join("\n");
  const mk = (n, start, drift) => { const bars = []; let px = start; for (let i = 0; i < n; i++) { px = px * (1 + drift(i)); bars.push([Date.UTC(2026, 0, 5) + i * 86400000, px, px * 1.01, px * 0.99, px, 1e6]); } return bars; };
  // an uptrend that pulled back to its 21-EMA on a red day; SPY in an uptrend too
  const up = mk(120, 100, i => i < 117 ? (i % 2 ? 0.01 : -0.006) : i === 119 ? -0.004 : -0.004); // a choppy climb (+1%/−0.6%), then three red days back to the 21-EMA with RSI just under 55
  const spy = mk(120, 500, i => 0.0005);
  const ctx = { Math, Date, Number, Map, Set, Array, Object, isFinite, console, String, Intl, JSON, Infinity,
    S: { set: { model: "standard", freshMinVol: 500, freshRatio: 1.5, range: 8 }, sym: "X", calc: null, bars: null },
    ID: { spy }, INDEX_SYMS: new Set(["SPX"]), NAMES: new Map([["X", "Test"]]), QD: { view: "bull" },
    withCalc: (c, b, fn) => fn(), ivAt: () => 0.3, realizedVol: () => ({ rv: 0.25 }), rankQuant: () => [], halalStatus: () => ({ s: "passes" }), earningsFor: () => null, getPb: () => ({ account: 25000, maxRiskPct: 5 }) };
  vm.createContext(ctx); vm.runInContext(src + "\nthis.analyzeTicker = analyzeTicker;", ctx);
  const chain = (spot) => { const rows = []; const exp = d(5); for (let K = Math.round(spot * 0.9); K <= spot * 1.1; K += 1) { const g = 0.02 * Math.exp(-Math.pow((K - spot) / 3, 2)); rows.push([exp, "C", K, K > spot ? 20000 : 500, 100, 0.3, g, 0.5, 1, 1.1, 1.05]); rows.push([exp, "P", K, K < spot ? 20000 : 500, 100, 0.3, g, -0.5, 1, 1.1, 1.05]); } return { symbol: "X", spot, rows }; };
  const spot = up.at(-1)[4]; const r = ctx.analyzeTicker("X", chain(spot), up);
  assert.equal(r.trendUp, true); assert.equal(r.pullback, true); assert.equal(r.redDay, true); assert.equal(r.regimeUp, true);
  assert.equal(r.signal, "Buy", "uptrend + pullback + red day + RSI reset + regime + leading + not below the flip = Buy: " + r.reasons.join(" | "));
  assert.ok(r.stop < r.entry && r.target > r.entry && r.shares > 0, "plan has a stop below, a target above and a size");
  // same name on a green day: one piece missing → Accumulate, never Buy
  const green = up.slice(0, -1).concat([[up.at(-1)[0], spot, spot * 1.012, spot * 0.995, spot * 1.01, 1e6]]);
  const g = ctx.analyzeTicker("X", chain(spot * 1.01), green); assert.notEqual(g.signal, "Buy", "green day → not a Buy"); assert.ok(["Accumulate", "Watch"].includes(g.signal), g.signal); assert.equal(g.pullback, true); assert.equal(g.redDay, false);
  // positioning alone (no trend) never earns a buy label even with a put wall under spot
  const flat = mk(120, 100, i => (i % 2 ? 0.005 : -0.0056)); const f = ctx.analyzeTicker("X", chain(flat.at(-1)[4]), flat); assert.ok(!["Buy", "Accumulate"].includes(f.signal), f.signal + " " + f.reasons.join(" | "));
  // regime off (SPY under its 50-EMA) blocks the Buy label
  ctx.ID.spy = mk(120, 500, i => i < 100 ? 0.003 : -0.01); const off = ctx.analyzeTicker("X", chain(spot), up); assert.equal(off.regimeUp, false); assert.notEqual(off.signal, "Buy");
});

// ---------- price series: aggregation, live patches, the forming bar ----------
test("series: 1-minute bars aggregate on the 09:30 grid, live minutes rebuild the forming 5-minute bar, a print stretches it", () => {
  const sctx = { Math, Date, Number, Map, Set, Array, Object, isFinite, Intl, String, console };
  vm.createContext(sctx);
  const grabConst = name => { const i = js.indexOf(`const ${name} = `); const j = js.indexOf("\n", i); return js.slice(i, j); };
  vm.runInContext([grabConst("IV_MIN"), grabConst("ET_CACHE"), grab("etInfo"), grab("isRegularBar"), grab("bucketStart"), grab("aggregateBars"), grab("mergeBars"), grab("foldMinutes"), grab("barDay"), grab("foldQuote"), grab("foldQuoteBar"), grab("barsForInterval")].join("\n") + "\nthis.f = { etInfo, isRegularBar, bucketStart, aggregateBars, mergeBars, foldMinutes, foldQuote, barsForInterval };", sctx);
  const f = sctx.f;
  const open = Date.parse("2026-10-22T09:30:00-04:00"); const m = k => open + k * 60000;
  // a session of 1-minute bars 09:30 → 16:00
  const mins = []; for (let k = 0; k <= 390; k++) mins.push([m(k), 100 + k * 0.01, 100 + k * 0.01 + 0.05, 100 + k * 0.01 - 0.05, 100 + (k + 1) * 0.01, 100]);
  const b5 = f.aggregateBars(mins, 1, 5); assert.equal(b5.length, 79, "78 five-minute bars + the 16:00 closing bar"); assert.equal(b5[0][0], m(0)); assert.equal(b5[0][5], 500, "volume sums"); assert.equal(b5[0][4], mins[4][4], "close of the fifth minute");
  const b60 = f.aggregateBars(mins, 1, 60); assert.equal(b60[0][0], m(0), "hourly bars start at 09:30, not 09:00"); assert.equal(b60[1][0], m(60));
  assert.equal(f.bucketStart(m(7), 5), m(5)); assert.equal(f.bucketStart(m(61), 60), m(60)); assert.equal(f.bucketStart(m(61), 30), m(60)); assert.equal(f.bucketStart(m(89), 30), m(60));
  assert.ok(f.isRegularBar(m(390)) && !f.isRegularBar(m(391)) && !f.isRegularBar(open - 60000), "16:00 is the closing print; 16:01 and 09:29 are not regular");
  // a 5-minute base patched by 1-minute live bars: the forming bar is rebuilt from the minutes it has in full
  const base = { kind: "5m", bars: b5.slice(0, 10).map(b => b.slice()), at: Date.now() };
  const live = [45, 46, 47, 48, 49, 50, 51, 52].map(k => [m(k), 200, 210, 190, 205, 1000]);
  assert.ok(f.foldMinutes(base, live)); assert.equal(base.bars.length, 11, "09:45 bucket rebuilt in place, 09:50 bucket appended");
  const b45 = base.bars[9]; assert.equal(b45[2], 210); assert.equal(b45[5], 5000, "five minutes of volume"); const b50 = base.bars[10]; assert.equal(b50[0], m(50)); assert.equal(b50[5], 3000, "three minutes so far");
  assert.ok(!f.foldMinutes(base, live), "the same patch again changes nothing");
  // a print inside the forming bar moves its close and stretches high/low; a print in the next bucket opens a bar
  assert.ok(f.foldQuote(base, 215, m(52) + 30000)); assert.equal(base.bars[10][4], 215); assert.equal(base.bars[10][2], 215);
  assert.ok(f.foldQuote(base, 216, m(55) + 5000)); assert.equal(base.bars.length, 12); assert.equal(base.bars[11][0], m(55)); assert.equal(base.bars[11][1], 216);
  assert.ok(!f.foldQuote(base, 216, m(40)), "an old print is ignored");
  // the interval on screen is built from the base; the extended filter drops pre/post bars; 1m from a 5m base stays 5m
  const withPost = { kind: "1m", bars: [...mins, [m(395), 1, 1, 1, 1, 1]], at: 0 };
  assert.equal(f.barsForInterval(withPost, "1m", false).length, 391); assert.equal(f.barsForInterval(withPost, "1m", true).length, 392);
  assert.equal(f.barsForInterval(withPost, "15m", true).length, 27, "26 quarter-hours + 16:00 closing bar... plus the 16:05 post bar folds into the 16:00 bucket");
  assert.equal(f.barsForInterval({ kind: "5m", bars: b5, at: 0 }, "1m", true).length, b5.length, "cannot invent minutes from five-minute bars");
  // Yahoo's trailing marker (stamped at the last trade time, o=h=l=c) folds into its bucket's close and adds no volume
  const withMarker = [...b5.slice(0, 3), [m(14) + 58000, 123, 123, 123, 123, 999]]; const norm = f.aggregateBars(withMarker, 5, 5);
  assert.equal(norm.length, 3); assert.equal(norm[2][4], 123); assert.equal(norm[2][2], 123); assert.equal(norm[2][5], b5[2][5], "marker volume is not added");
  // a daily base: a print on the same ET day updates the day's bar, the next day opens one
  const daily = { kind: "1d", bars: [[Date.parse("2026-10-21T00:00:00Z"), 10, 11, 9, 10.5, 5], [Date.parse("2026-10-22T00:00:00Z"), 10.5, 10.8, 10.2, 10.6, 3]], at: 0 };
  assert.ok(f.foldQuote(daily, 11.2, Date.parse("2026-10-22T15:00:00-04:00"))); assert.equal(daily.bars[1][4], 11.2); assert.equal(daily.bars[1][2], 11.2); assert.equal(daily.bars.length, 2);
  assert.ok(f.foldQuote(daily, 11.3, Date.parse("2026-10-23T10:00:00-04:00"))); assert.equal(daily.bars.length, 3); assert.equal(f.etInfo(daily.bars[2][0]).min, 570, "the new session's bar is stamped at its open");
});

// ---------- the latest print: which number the header, tape and chart follow in each session ----------
test("latest print: regular price in regular hours, the extended bar after hours, the 24-hour price overnight, indices unchanged", () => {
  const mk = phase => { const c = { Math, Date, Number, Set, isFinite, INDEX_SYMS: new Set(["SPX"]), marketPhase: () => phase }; vm.createContext(c); vm.runInContext([grab("extState"), grab("latestPrint")].join("\n") + "\nthis.latestPrint = latestPrint;", c); return c.latestPrint; };
  const t4 = Date.parse("2026-10-22T16:00:00-04:00"), t8 = Date.parse("2026-10-22T19:59:00-04:00"), now = Date.parse("2026-10-22T23:30:00-04:00");
  const q = { symbol: "NVDA", price: 212.21, prev: 221.97, last: 212.38, t: t8, state: null, full: 213.87, fullT: now };
  const eq = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m); // objects cross a vm boundary: compare by value
  eq(mk("overnight")(q), { price: 213.87, t: now, session: "OVN" });
  assert.equal(mk("regular")({ ...q, last: 211.7, t: t4 }).price, 212.21, "regular hours: the regular price, never the 24-hour sample");
  eq(mk("post")({ ...q, full: null, fullT: null }), { price: 212.38, t: t8, session: "AH" }, "after hours without a 24-hour sample: the last extended bar");
  assert.equal(mk("post")({ ...q, fullT: t8 + 300e3, full: 212.5 }).price, 212.5, "after hours: a fresher 24-hour sample beats a stale bar");
  eq(mk("overnight")({ symbol: "SPX", price: 7663.43, prev: 7757, last: 7663.43, t: t4, full: 7663.43, fullT: now }), { price: 7663.43, t: t4, session: "CLOSE" }, "an index has one session");
  assert.equal(mk("closed")({ ...q, full: 212.21, fullT: now }).session, "AH", "a weekend still shows Friday's last after-hours print");
  assert.equal(mk("closed")({ ...q, last: 212.21, full: null, fullT: null }).session, "CLOSE");
});
