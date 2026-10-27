// The streaming tier against a fake upstream: an in-process WebSocket server that speaks Alpaca's (and Polygon's) message format.
// Fixtures here are synthetic and labelled so; nothing in them is market data. `node --test test/stream.test.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer, WebSocket as WsClient } from "ws";
import { MarketEngine, CandleBuilder, normalizeAlpaca, normalizePolygon, tradeUpdatesLast, alpacaRangeStart, engineFromEnv } from "../server/market.mjs";
import { attachHub } from "../server/hub.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(15); } return false; };
// a fake Alpaca stream: authenticates any key, confirms subscriptions, lets the test inject messages and drop connections
function fakeUpstream({ provider = "alpaca", rejectAuth = false } = {}) {
  const wss = new WebSocketServer({ port: 0 }); const conns = []; const subs = new Set();
  wss.on("connection", ws => { conns.push(ws); ws.send(JSON.stringify(provider === "alpaca" ? [{ T: "success", msg: "connected" }] : [{ ev: "status", status: "connected", message: "Connected" }]));
    ws.on("message", raw => { const m = JSON.parse(String(raw));
      if (m.action === "auth") ws.send(JSON.stringify(provider === "alpaca" ? (rejectAuth ? [{ T: "error", code: 402, msg: "auth failed" }] : [{ T: "success", msg: "authenticated" }]) : [{ ev: "status", status: rejectAuth ? "auth_failed" : "auth_success" }]));
      if (m.action === "subscribe") { for (const s of (m.trades || (m.params || "").split(",").filter(x => x.startsWith("T.")).map(x => x.slice(2)))) subs.add(s); if (provider === "alpaca") ws.send(JSON.stringify([{ T: "subscription", trades: [...subs], quotes: [...subs], bars: [...subs] }])); }
      if (m.action === "unsubscribe") for (const s of (m.trades || (m.params || "").split(",").filter(x => x.startsWith("T.")).map(x => x.slice(2)))) subs.delete(s); }); });
  const url = `ws://127.0.0.1:${wss.address().port}`;
  return { url, subs, conns, send: obj => { for (const c of conns) if (c.readyState === 1) c.send(JSON.stringify(obj)); }, dropAll: () => { for (const c of conns) c.terminate(); conns.length = 0; }, close: () => new Promise(r => wss.close(r)) };
}
const tradeAt = (sym, p, iso, s = 100, c = []) => ({ T: "t", S: sym, p, s, t: iso, c });

test("normalization: Alpaca and Polygon messages become the same engine events", () => {
  const a = normalizeAlpaca([tradeAt("AAPL", 200.5, "2026-10-26T14:30:00.123Z", 50), { T: "q", S: "AAPL", bp: 200.4, ap: 200.6, bs: 3, as: 2, t: "2026-10-26T14:30:00.200Z" }, { T: "b", S: "AAPL", o: 200, h: 201, l: 199.5, c: 200.5, v: 1234, t: "2026-10-26T14:30:00Z" }, { T: "success", msg: "authenticated" }, { T: "error", code: 406, msg: "connection limit exceeded" }]);
  assert.equal(a[0].type, "trade"); assert.equal(a[0].price, 200.5); assert.equal(a[0].t, Date.parse("2026-10-26T14:30:00.123Z"));
  assert.equal(a[1].type, "quote"); assert.equal(a[1].bid, 200.4); assert.equal(a[2].type, "bar"); assert.deepEqual(a[2].bar, [Date.parse("2026-10-26T14:30:00Z"), 200, 201, 199.5, 200.5, 1234]); assert.equal(a[2].final, true);
  assert.equal(a[3].kind, "authenticated"); assert.equal(a[4].kind, "error"); assert.equal(a[4].code, 406);
  const p = normalizePolygon([{ ev: "T", sym: "AAPL", p: 200.5, s: 50, t: 1793000000123 }, { ev: "AM", sym: "AAPL", o: 200, h: 201, l: 199.5, c: 200.5, v: 1234, s: 1793000000000, e: 1793000060000 }, { ev: "status", status: "auth_success" }]);
  assert.equal(p[0].type, "trade"); assert.equal(p[0].t, 1793000000123); assert.equal(p[1].type, "bar"); assert.equal(p[1].final, true); assert.equal(p[2].kind, "authenticated");
  assert.ok(tradeUpdatesLast(["@"])); assert.ok(!tradeUpdatesLast(["Z"]), "a late print (Z) does not move the last price"); assert.ok(!tradeUpdatesLast(["I"]), "odd lots do not either");
  assert.equal(normalizeAlpaca("garbage").length, 0); assert.equal(normalizeAlpaca([{ T: "t", S: "X", p: -1, t: "2026-01-01T00:00:00Z" }]).length, 0, "a non-positive price is not a trade");
});

test("candle builder: trades form a 1-minute bar, the next minute opens a new one, late prints do not rewrite closed bars, provider bars win", () => {
  const cb = new CandleBuilder(60e3); const m0 = Date.parse("2026-10-26T14:30:00Z");
  let r = cb.trade(100, 10, m0 + 1000); assert.deepEqual(r.bar, [m0, 100, 100, 100, 100, 10]); assert.equal(r.closed, null);
  r = cb.trade(101, 5, m0 + 20000); assert.deepEqual(r.bar, [m0, 100, 101, 100, 101, 15]);
  r = cb.trade(99, 5, m0 + 10000); assert.deepEqual(r.bar, [m0, 100, 101, 99, 101, 20], "an out-of-order print inside the bar stretches low and adds volume but keeps the newer close");
  r = cb.trade(102, 7, m0 + 61000); assert.deepEqual(r.closed, [m0, 100, 101, 99, 101, 20], "minute one is closed when minute two opens"); assert.deepEqual(r.bar, [m0 + 60e3, 102, 102, 102, 102, 7]);
  assert.equal(cb.trade(50, 1, m0 + 30000), null, "a print for an already-closed minute is ignored");
  const pb = cb.providerBar([m0 + 60e3, 102, 103, 101.5, 102.5, 900]); assert.deepEqual(pb, [m0 + 60e3, 102, 103, 101.5, 102.5, 900], "the provider's aggregate replaces what trades built");
  assert.equal(cb.trade(0, 1, m0 + 70000), null); assert.equal(cb.trade(100, 1, NaN), null);
});

test("engine: authenticates, subscribes once per symbol (ref-counted), builds candles from trades, drops stale/out-of-order prints, unsubscribes when the last client leaves", async () => {
  const up = fakeUpstream(); const eng = new MarketEngine({ provider: "alpaca", keys: { key: "k", secret: "s" }, url: up.url, log: () => {} });
  const ticks = []; eng.on("tick", t => ticks.push(t)); eng.start();
  assert.ok(await until(() => eng.state === "live"), "live after auth: " + eng.state);
  eng.subscribe(["aapl", "AAPL", "bad symbol!", "MSFT"]); eng.subscribe(["AAPL"]);
  assert.ok(await until(() => up.subs.has("AAPL") && up.subs.has("MSFT"))); assert.equal(eng.refs.get("AAPL"), 3); assert.equal(up.subs.size, 2, "the invalid symbol never reached the provider");
  const m0 = Date.parse("2026-10-26T14:30:00Z");
  up.send([tradeAt("AAPL", 200, "2026-10-26T14:30:01Z"), tradeAt("AAPL", 201, "2026-10-26T14:30:30Z", 10), tradeAt("AAPL", 150, "2026-10-26T14:29:00Z", 1), tradeAt("AAPL", 199, "2026-10-26T14:30:20Z", 2, ["Z"]), tradeAt("TSLA", 1, "2026-10-26T14:30:00Z")]);
  assert.ok(await until(() => ticks.length >= 2)); await sleep(50); const s = eng.snapshot("AAPL");
  assert.equal(ticks.length, 2, "two prints in order make two ticks; the 90-second-old print, the 10-second-late print and TSLA (not subscribed) make none");
  assert.equal(s.price, 201); assert.equal(s.t, Date.parse("2026-10-26T14:30:30Z"));
  assert.deepEqual(s.bar, [m0, 200, 201, 200, 201, 110], "the forming bar is built from the prints that arrived in order"); assert.ok(eng.dropped >= 3, "dropped: " + eng.dropped);
  up.send([{ T: "b", S: "AAPL", o: 200, h: 201, l: 199, c: 200.8, v: 5000, t: "2026-10-26T14:30:00Z" }, tradeAt("AAPL", 202, "2026-10-26T14:31:02Z")]);
  assert.ok(await until(() => eng.snapshot("AAPL").bars.length >= 1)); assert.deepEqual(eng.snapshot("AAPL").bars[0], [m0, 200, 201, 199, 200.8, 5000], "the provider's final bar is the record");
  assert.equal(eng.snapshot("AAPL").bar[0], m0 + 60e3, "a new minute is forming");
  eng.unsubscribe(["AAPL"]); eng.unsubscribe(["AAPL"]); assert.ok(up.subs.has("AAPL"), "two of three clients left: still subscribed"); eng.unsubscribe(["AAPL"]); assert.ok(await until(() => !up.subs.has("AAPL")), "the last client gone: unsubscribed upstream");
  const st = eng.status(); assert.equal(st.feedType, "iex"); assert.equal(st.realtime, true); assert.equal(st.consolidated, false, "Alpaca's free stream is one exchange's prints, never called consolidated");
  eng.stop(); await up.close();
});

test("engine: reconnects with backoff and restores subscriptions; stale detection in market hours; auth failure stops cleanly; missing credentials never connect", async () => {
  const up = fakeUpstream(); let now = Date.parse("2026-10-26T15:00:00Z"); // a Monday, regular hours
  const eng = new MarketEngine({ provider: "alpaca", keys: { key: "k", secret: "s" }, url: up.url, log: () => {}, now: () => now, staleAfterMs: 2500 });
  const states = []; eng.on("status", s => states.push(s.state)); eng.start(); assert.ok(await until(() => eng.state === "live"));
  eng.subscribe(["AAPL"]); assert.ok(await until(() => up.subs.has("AAPL")));
  up.subs.clear(); up.dropAll();
  assert.ok(await until(() => eng.state === "reconnecting")); assert.equal(eng.reconnects, 1); assert.ok(eng.backoffMs >= 2000, "backoff doubled: " + eng.backoffMs);
  assert.ok(await until(() => eng.state === "live" && up.subs.has("AAPL"), 5000), "back live with the subscription restored");
  // quiet feed in market hours → stale, then live again when a message lands
  up.send([tradeAt("AAPL", 200, "2026-10-26T15:00:01Z")]); assert.ok(await until(() => eng.lastMsgAt > 0)); now += 1000; eng.checkStale(); assert.equal(eng.state, "live", "a second of quiet is fine"); now += 2000; eng.checkStale(); assert.equal(eng.state, "stale", "three seconds past the threshold in market hours");
  up.send([tradeAt("AAPL", 200.1, "2026-10-26T15:00:04Z")]); assert.ok(await until(() => eng.lastMsgAt === now)); eng.checkStale(); assert.equal(eng.state, "live", "a print brings it back");
  eng.stop(); await up.close();
  // overnight / weekend quiet is not stale
  const eng2 = new MarketEngine({ provider: "alpaca", keys: { key: "k", secret: "s" }, url: "ws://127.0.0.1:1", log: () => {}, now: () => Date.parse("2026-10-25T15:00:00Z"), staleAfterMs: 1 }); eng2.state = "live"; eng2.refs.set("AAPL", 1); eng2.lastMsgAt = 1; eng2.checkStale(); assert.equal(eng2.state, "live", "a Sunday afternoon with no prints is simply closed");
  // rejected auth → error state, no retry storm
  const bad = fakeUpstream({ rejectAuth: true }); const eng3 = new MarketEngine({ provider: "alpaca", keys: { key: "k", secret: "wrong" }, url: bad.url, log: () => {} }); eng3.start();
  assert.ok(await until(() => eng3.state === "error")); assert.ok(eng3.errors.some(e => /auth/.test(e.msg))); await bad.close();
  // no keys → never connects, status says why
  const eng4 = engineFromEnv({ MARKET_STREAM: "alpaca" }); eng4.start(); assert.equal(eng4.state, "error"); assert.match(eng4.errors[0].msg, /credentials missing/);
  const eng5 = engineFromEnv({}); eng5.start(); assert.equal(eng5.state, "disabled"); assert.equal(eng5.status().realtime, false);
  const eng6 = engineFromEnv({ MARKET_STREAM: "massive", MASSIVE_KEY: "x" }); assert.equal(eng6.provider, "polygon"); assert.equal(eng6.feedType, "sip"); assert.match(eng6.url, /socket\.polygon\.io/);
  const eng7 = engineFromEnv({ MARKET_STREAM: "polygon", POLYGON_KEY: "x", POLYGON_DELAYED: "1" }); assert.equal(eng7.feedType, "delayed", "a delayed plan is labelled delayed");
});

test("hub: a browser subscribes, gets a snapshot, coalesced ticks, bars and heartbeats; a second tab shares the one upstream subscription", async () => {
  const up = fakeUpstream(); const eng = new MarketEngine({ provider: "alpaca", keys: { key: "k", secret: "s" }, url: up.url, log: () => {} }); eng.start(); assert.ok(await until(() => eng.state === "live"));
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); }); const hub = attachHub(srv, eng, { heartbeatMs: 200, tickEveryMs: 50, log: () => {} });
  await new Promise(r => srv.listen(0, "127.0.0.1", r)); const port = srv.address().port;
  const open = async () => { const ws = new WsClient(`ws://127.0.0.1:${port}/ws`); const got = []; ws.on("message", raw => got.push(JSON.parse(String(raw)))); await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); }); return { ws, got }; };
  const a = await open(); assert.ok(await until(() => a.got.some(m => m.type === "hello"))); assert.equal(a.got[0].status.provider, "alpaca");
  a.ws.send(JSON.stringify({ op: "sub", syms: ["AAPL", "nope!!"] })); assert.ok(await until(() => a.got.some(m => m.type === "snap" && m.sym === "AAPL"))); assert.ok(await until(() => up.subs.has("AAPL")));
  const b = await open(); b.ws.send(JSON.stringify({ op: "sub", syms: ["AAPL"] })); await until(() => b.got.some(m => m.type === "snap")); assert.equal(eng.refs.get("AAPL"), 2); assert.equal(up.conns.length, 1, "two tabs, one upstream connection");
  for (let i = 0; i < 20; i++) up.send([tradeAt("AAPL", 200 + i * 0.01, `2026-10-26T14:30:${String(i).padStart(2, "0")}Z`)]);
  assert.ok(await until(() => a.got.some(m => m.type === "tick" && Math.abs(m.price - 200.19) < 1e-9), 3000), "the last tick reaches the client");
  const ticksA = a.got.filter(m => m.type === "tick"); assert.ok(ticksA.length < 20, `bursts are coalesced (${ticksA.length} of 20 delivered)`);
  up.send([{ T: "b", S: "AAPL", o: 200, h: 200.2, l: 200, c: 200.19, v: 2000, t: "2026-10-26T14:30:00Z" }]); assert.ok(await until(() => b.got.some(m => m.type === "bar" && m.final)));
  assert.ok(await until(() => a.got.filter(m => m.type === "hb").length >= 1, 1500), "heartbeats arrive");
  a.ws.send(JSON.stringify({ op: "ping" })); assert.ok(await until(() => a.got.filter(m => m.type === "hb").length >= 2));
  a.ws.send(JSON.stringify({ op: "bogus" })); assert.ok(await until(() => a.got.some(m => m.type === "error")));
  a.ws.close(); await until(() => eng.refs.get("AAPL") === 1); b.ws.close(); assert.ok(await until(() => !eng.refs.has("AAPL") && !up.subs.has("AAPL")), "the last tab closing releases the upstream subscription");
  const w = new WsClient(`ws://127.0.0.1:${port}/elsewhere`); const refused = await new Promise(r => { w.on("error", () => r(true)); w.on("open", () => r(false)); }); assert.ok(refused, "only /ws upgrades");
  hub.close(); eng.stop(); await new Promise(r => srv.close(r)); await up.close();
});

test("REST helpers: range starts and the 429 contract", () => {
  const now = Date.parse("2026-10-26T15:00:00Z"); assert.equal(alpacaRangeStart("1d", now), now - 86400e3); assert.equal(alpacaRangeStart("ytd", now), Date.UTC(2026, 0, 1)); assert.ok(alpacaRangeStart("max", now) < now - 365 * 86400e3 * 10);
});

test("hub: origin check — same host and listed origins pass, others are refused; connections per address are capped", async () => {
  const up = fakeUpstream(); const eng = new MarketEngine({ provider: "alpaca", keys: { key: "k", secret: "s" }, url: up.url, log: () => {} }); eng.start(); assert.ok(await until(() => eng.state === "live"));
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); }); const hub = attachHub(srv, eng, { log: () => {}, allowedOrigins: ["https://edwinp2342.github.io"], maxClientsPerIp: 2 });
  await new Promise(r => srv.listen(0, "127.0.0.1", r)); const port = srv.address().port;
  const tryOpen = origin => new Promise(r => { const ws = new WsClient(`ws://127.0.0.1:${port}/ws`, origin ? { headers: { origin } } : {}); ws.on("open", () => r({ ok: true, ws })); ws.on("error", () => r({ ok: false })); });
  const a = await tryOpen(`http://127.0.0.1:${port}`); assert.ok(a.ok, "same host");
  const b = await tryOpen("https://edwinp2342.github.io"); assert.ok(b.ok, "listed origin");
  const c = await tryOpen("https://evil.example"); assert.ok(!c.ok, "an unlisted origin is refused");
  const d = await tryOpen(null); assert.ok(!d.ok, "a third connection from the same address is refused (cap 2)");
  a.ws.close(); b.ws.close(); await sleep(50); const e = await tryOpen(null); assert.ok(e.ok, "room again after a close"); e.ws.close();
  hub.close(); eng.stop(); await new Promise(r => srv.close(r)); await up.close();
});

test("local server: private paths are never served, security headers are set, the API answers, the rate limit trips", async () => {
  const { startServer } = await import("../desktop/server.js"); const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const port = await startServer(root, 4899 + Math.floor(Math.random() * 100)); const get = p => fetch(`http://127.0.0.1:${port}${p}`);
  assert.equal((await get("/app.html")).status, 200); assert.equal((await get("/index.html")).status, 200);
  for (const p of ["/.env.example", "/.git/config", "/node_modules/ws/package.json", "/server/market.mjs", "/desktop/server.js", "/scripts/snapshot.mjs", "/test/stream.test.mjs", "/../etc/passwd"]) assert.equal((await get(p)).status, 404, p + " must not be served");
  const st = await get("/api/status"); assert.equal(st.status, 200); assert.equal(st.headers.get("x-content-type-options"), "nosniff"); const j = await st.json(); assert.equal(j.stream.state, "disabled", "no keys in the test environment: the stream says so");
  const kn = globalThis.__kingnode; kn.engine.stop();
  let limited = false; for (let i = 0; i < 260; i++) { const r = await get("/api/status"); if (r.status === 429) { limited = true; break; } } assert.ok(limited, "the per-address rate limit trips within a minute of hammering");
  kn.hub.close(); await new Promise(r => kn.server.close(r));
});
