// Unit tests for the positioning math. Runs the app's own computeFrom (extracted from app.html) and the server's levels.js
// against a synthetic chain with known answers. `node --test test/`
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
const src = [grab("erf"), grab("dte"), grab("etNowParts"), grab("liveExps"), grab("computeFrom"), grab("bsPrice")].join("\n");
const ctx = { Math, Date, Number, Map, Set, Array, Object, isFinite, console, S: { set: { freshMinVol: 500, freshRatio: 1.5 } } };
vm.createContext(ctx); vm.runInContext(src + "\nthis.computeFrom = computeFrom; this.bsPrice = bsPrice; this.erf = erf;", ctx);

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
  const c = ctx.computeFrom(chain(), [d(30)], 15, "shortall");
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
test("server levels agree with the app on the walls", () => {
  const l = computeLevels(chain(), 3, 15);
  assert.equal(l.callWall, 105); assert.equal(l.putWall, 95);
});
