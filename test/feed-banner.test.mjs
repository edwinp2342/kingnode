// The app's chain-outage detector, read out of app.html: the loop is alive but the chain vendor is refusing every chain.   `node --test test/feed-banner.test.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function appFn(name) {
  const html = fs.readFileSync(new URL("../app.html", import.meta.url), "utf8"); const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const i = js.indexOf(`function ${name}(`); assert.ok(i >= 0, `${name} lives in app.html`); let j = js.indexOf("{", i), depth = 0; for (; j < js.length; j++) { if (js[j] === "{") depth++; else if (js[j] === "}") { depth--; if (!depth) break; } }
  const ctx = { Math }; vm.createContext(ctx); vm.runInContext(js.slice(i, j + 1) + `\nthis.fn = ${name};`, ctx); return ctx.fn;
}

test("app: chainOutage fires on a cycle of chains all refused with one error, stays quiet on the usual handful of misses", () => {
  const chainOutage = appFn("chainOutage");
  // the 2026-11-19/20 outage as index.json showed it: a tier-B cycle, a dozen 403s, the run started inside the outage so chainAt is 0
  const tierB = ["HWM", "VEEV", "WWD", "GLW", "ZS", "KMB", "SPCX", "SOXL", "SNDK", "TQQQ", "VOO", "GOOG"].map(s => `cb:${s}:http 403`);
  const o = chainOutage({ fail: ["b:ROKU", ...tierB], chainAt: 0 }, 1795126910301);
  assert.ok(o, "a dozen tier-B chains refused with the same status is an outage");
  assert.equal(o.error, "http 403"); assert.equal(o.n, 12); assert.equal(o.core, 0); assert.equal(o.tierB, 12); assert.equal(o.since, 1795126910301, "scan.json's write stands in for the loop's reset chainAt");
  // a core cycle: 79 of 80 names refused, one bar miss and a short-volume error in the list too
  const core = Array.from({ length: 79 }, (_, i) => `c:S${i}:http 403`);
  const c = chainOutage({ fail: ["b:ROKU", "sv:timeout", ...core, "cb:XLP:http 403"], chainAt: 1795100000000 }, 0);
  assert.equal(c.core, 79); assert.equal(c.tierB, 1); assert.equal(c.n, 80); assert.equal(c.since, 1795100000000, "the loop's own chainAt when it is newer than anything the app loaded");
  // the ordinary nights: one tier-B miss, a couple of 429s, the rate-limit marker — not an outage
  assert.equal(chainOutage({ fail: ["b:ROKU"] }), null);
  assert.equal(chainOutage({ fail: ["b:ROKU", "cb:ROKU:http 404", "cb:BRK.B:no options", "cb:ABC:http 429", "cb:rate-limited after 6"] }), null);
  assert.equal(chainOutage({ fail: [] }), null); assert.equal(chainOutage(null), null); assert.equal(chainOutage({}), null);
  // nine misses with mixed errors is still noise; the tenth with the same error tips it
  const mixed = Array.from({ length: 9 }, (_, i) => `cb:S${i}:${i % 2 ? "http 404" : "no options"}`);
  assert.equal(chainOutage({ fail: mixed }), null);
  assert.ok(chainOutage({ fail: Array.from({ length: 10 }, (_, i) => `cb:S${i}:http 403`) }));
  // no chain write anywhere yet → since is null rather than 0, so the banner leaves the "last good update" clause out
  assert.equal(chainOutage({ fail: tierB, chainAt: 0 }, 0).since, null);
});
