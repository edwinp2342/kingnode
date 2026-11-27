// Ava's scored calls: resolveCall() out of app.html — target/stop on the path (stop wins a tie), else the close at the horizon,
// ±0.5% flat, raw prices compared against adjusted bars that carry the raw close.   `node --test test/ava-calls.test.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function pull(name) { const html = fs.readFileSync(new URL("../app.html", import.meta.url), "utf8"); const js = html.match(/<script>([\s\S]*?)<\/script>/)[1]; const i = js.indexOf(`function ${name}(`); assert.ok(i >= 0, name + " lives in app.html"); let j = js.indexOf("{", i), depth = 0; for (; j < js.length; j++) { if (js[j] === "{") depth++; else if (js[j] === "}") { depth--; if (!depth) break; } } const ctx = { Math, Date }; vm.createContext(ctx); vm.runInContext(js.slice(i, j + 1) + `\nthis.${name} = ${name};`, ctx); return ctx[name]; }
const resolveCall = pull("resolveCall");
const DAY = 86400e3; const t0 = Date.UTC(2026, 10, 2, 14, 30); // Mon Nov 2 2026
const bar = (i, o, h, l, c, raw = null) => [t0 + i * DAY, o, h, l, c, 1000, raw ?? c];
const call = (over = {}) => ({ id: "c1", t: t0 - 3600e3, date: "2026-11-02", sym: "X", side: "bull", px: 100, target: null, stop: null, horizonDays: 3, ...over });

test("a bull call is right when the close at the horizon is higher, wrong when lower, flat inside half a percent; open until the horizon prints", () => {
  const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 102, 99, 101), bar(2, 101, 103, 100, 102), bar(3, 102, 104, 101, 103), bar(4, 103, 105, 102, 104)];
  const up = resolveCall(call(), bars); assert.equal(up.hit, true); assert.equal(up.px, 103); assert.equal(up.why, "at the horizon"); assert.equal(up.at, bars[3][0]);
  const down = resolveCall(call({ side: "bear" }), bars); assert.equal(down.hit, false);
  const flat = resolveCall(call(), [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100.2), bar(2, 100, 101, 99, 100.1), bar(3, 100, 101, 99, 100.3)]); assert.equal(flat.hit, null); assert.equal(flat.why, "flat at the horizon");
  const neutral = resolveCall(call({ side: "neutral" }), [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100.2), bar(2, 100, 101, 99, 100.1), bar(3, 100, 101, 99, 100.3)]); assert.equal(neutral.hit, true, "a neutral call is right on a flat close");
  assert.equal(resolveCall(call(), bars.slice(0, 3)), null, "still open: the horizon bar has not printed");
  assert.equal(resolveCall(call({ date: "2026-12-01" }), bars), null, "no bar on or after the call date yet");
});

test("target and stop are judged on the path: whichever prints first decides, the stop on a tie; the horizon close never overrides a touch", () => {
  const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 106, 99, 104), bar(2, 104, 105, 94, 95), bar(3, 95, 96, 94, 95)];
  const t = resolveCall(call({ target: 105, stop: 96 }), bars); assert.equal(t.hit, true); assert.equal(t.px, 105); assert.equal(t.why, "target hit"); assert.equal(t.at, bars[1][0]);
  const s = resolveCall(call({ target: 110, stop: 96 }), bars); assert.equal(s.hit, false); assert.equal(s.why, "stop hit"); assert.equal(s.at, bars[2][0]);
  const tie = resolveCall(call({ target: 105, stop: 99.5 }), [bar(0, 100, 101, 99, 100), bar(1, 100, 106, 99, 104), bar(2, 104, 105, 103, 104), bar(3, 104, 105, 103, 104)]); assert.equal(tie.hit, false, "both printed in one bar → the stop is assumed");
  const bear = resolveCall(call({ side: "bear", target: 95, stop: 103 }), [bar(0, 100, 101, 99, 100), bar(1, 100, 102, 94, 96), bar(2, 96, 97, 95, 96), bar(3, 96, 97, 95, 96)]); assert.equal(bear.hit, true); assert.equal(bear.px, 95);
});

test("adjusted bars with a raw close beside them are compared in raw terms, which is what the call price was", () => {
  // a 2:1 split-adjusted history: adjusted prices are half the raw prints; the call was made at raw 100 and the target is raw 105
  const adj = (i, o, h, l, c) => [t0 + i * DAY, o / 2, h / 2, l / 2, c / 2, 1000, c];
  const bars = [adj(0, 100, 101, 99, 100), adj(1, 100, 106, 99, 104), adj(2, 104, 105, 103, 104), adj(3, 104, 105, 103, 104)];
  const r = resolveCall(call({ target: 105, stop: 96 }), bars); assert.equal(r.hit, true); assert.equal(r.px, 105);
  const r2 = resolveCall(call(), bars); assert.equal(r2.px, 104, "the horizon close comes back in raw terms"); assert.equal(r2.hit, true);
});
