// The server in cloud shape: PORT → 0.0.0.0, /data served from DATA_DIR without caching, /api/ping, /api/ava locked and unconfigured
// answers, the private tree still hidden, and the feed child supervised when FEED=1.   `node --test test/server.test.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../desktop/server.js";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 150)); } return false; };
const get = (port, p, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers });

test("cloud shape: data route from a volume, ping, Ava endpoint answers, private paths hidden", async () => {
  const vol = fs.mkdtempSync(path.join(os.tmpdir(), "kn-vol-")); const prevLink = path.join(root, "data"); const hadData = fs.existsSync(prevLink);
  const saved = { ...process.env }; Object.assign(process.env, { PORT: "0", DATA_DIR: vol, MARKET_STREAM: "none", ASK_KEY: "", ANTHROPIC_API_KEY: "" }); delete process.env.FEED;
  let port; try {
    if (hadData) { /* leave a real ./data alone: the link step only acts on a missing or empty ./data */ }
    port = await startServer(root, 0);
    fs.writeFileSync(path.join(vol, "index.json"), JSON.stringify({ at: Date.now(), cycle: 1 })); fs.mkdirSync(path.join(vol, "live"), { recursive: true }); fs.writeFileSync(path.join(vol, "live", "q-1.json"), '{"at":1}');
    const ping = await get(port, "/api/ping"); assert.equal(ping.status, 200); assert.equal((await ping.json()).ok, true);
    if (!hadData) {
      const d = await get(port, "/data/index.json"); assert.equal(d.status, 200); assert.equal(d.headers.get("cache-control"), "no-store"); assert.equal(d.headers.get("access-control-allow-origin"), "*"); assert.equal((await d.json()).cycle, 1);
      assert.equal((await get(port, "/data/live/q-1.json")).status, 200);
      assert.equal((await get(port, "/data/%2e%2e%2fpackage.json")).status, 404, "no escaping the data dir");
      assert.equal((await get(port, "/data/.secret")).status, 404);
    }
    assert.equal((await get(port, "/data/nope.json")).status, 404);
    for (const p of ["/.env", "/server/hub.mjs", "/desktop/server.js", "/scripts/snapshot.mjs", "/test/server.test.mjs", "/node_modules/ws/package.json"]) assert.equal((await get(port, p)).status, 404, p + " must be hidden");
    assert.equal((await get(port, "/app.html")).status, 200); assert.equal((await get(port, "/")).status, 200);
    // Ava: not configured → GET says so; POST is 503 before any auth question on loopback
    const g = await get(port, "/api/ava"); assert.equal(g.status, 200); const gj = await g.json(); assert.equal(gj.configured, false); assert.equal(gj.local, true);
    const p1 = await fetch(`http://127.0.0.1:${port}/api/ava`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: { messages: [{ role: "user", content: "hi" }] } }) }); assert.equal(p1.status, 503);
    // a public host (any non-loopback Host header) with a key but no ASK_KEY is locked; with ASK_KEY it needs the right one
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const locked = await fetch(`http://127.0.0.1:${port}/api/ava`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.5" }, body: JSON.stringify({ body: { messages: [{ role: "user", content: "hi" }] } }) }); assert.equal(locked.status, 401); assert.equal((await locked.json()).error, "locked");
    process.env.ASK_KEY = "open-sesame";
    const bad = await fetch(`http://127.0.0.1:${port}/api/ava`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.5", "x-ask-key": "wrong" }, body: JSON.stringify({ body: { messages: [{ role: "user", content: "hi" }] } }) }); assert.equal(bad.status, 401); assert.equal((await bad.json()).error, "bad_key");
    const g2 = await fetch(`http://127.0.0.1:${port}/api/ava`, { headers: { "x-forwarded-for": "203.0.113.5" } }); const gj2 = await g2.json(); assert.equal(gj2.configured, true); assert.equal(gj2.locked, true); assert.equal(gj2.local, false);
    const malformed = await fetch(`http://127.0.0.1:${port}/api/ava`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.5", "x-ask-key": "open-sesame" }, body: JSON.stringify({ body: { nope: 1 } }) }); assert.equal(malformed.status, 400);
  } finally {
    const kn = globalThis.__kingnode; try { kn?.hub?.close(); } catch {} await new Promise(r => kn?.server ? kn.server.close(() => r()) : r()); try { kn?.engine?.stop?.(); } catch {}
    if (!hadData) { try { fs.unlinkSync(prevLink); } catch {} }
    fs.rmSync(vol, { recursive: true, force: true }); for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved);
  }
});

test("FEED=1 runs the snapshot loop as a child and writes into the data dir; the child is stopped with the server", async () => {
  const vol = fs.mkdtempSync(path.join(os.tmpdir(), "kn-vol-")); const prevLink = path.join(root, "data"); const hadData = fs.existsSync(prevLink);
  const saved = { ...process.env }; Object.assign(process.env, { PORT: "0", DATA_DIR: vol, MARKET_STREAM: "none", FEED: "1", SEED_FROM: "http://127.0.0.1:9/", EVERY_SEC: "60", LOOP_MINUTES: "1" });
  // the child inherits a fetch that cannot reach anything (no network here): it still boots, seeds nothing, writes its index, and keeps running
  let port; try {
    port = await startServer(root, 0); const kn = globalThis.__kingnode; assert.ok(kn.feed?.state.child?.pid > 0, "feed child spawned");
    const wrote = await until(() => fs.existsSync(path.join(hadData ? prevLink : vol, "index.json")), 60000);
    assert.ok(wrote, "the feed wrote data/index.json within a minute");
    const idx = JSON.parse(fs.readFileSync(path.join(hadData ? prevLink : vol, "index.json"), "utf8")); assert.ok(idx.at > 0, "the index carries a timestamp"); // the phase arrives with the first full cycle, which needs the market
    if (!hadData) { const d = await get(port, "/data/index.json"); assert.equal(d.status, 200); }
    kn.feed.stop(); await until(() => kn.feed.state.child.exitCode != null || kn.feed.state.child.signalCode != null, 10000);
  } finally {
    const kn = globalThis.__kingnode; try { kn?.feed?.stop(); } catch {} try { kn?.hub?.close(); } catch {} await new Promise(r => kn?.server ? kn.server.close(() => r()) : r()); try { kn?.engine?.stop?.(); } catch {}
    if (!hadData) { try { fs.unlinkSync(prevLink); } catch {} }
    fs.rmSync(vol, { recursive: true, force: true }); for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved);
  }
});
