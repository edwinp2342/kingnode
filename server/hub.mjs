// WebSocket hub: many browser tabs, one engine. Clients say which symbols they want; the hub keeps the engine's ref-counts, fans ticks
// out, coalesces bursts (at most four price updates a second per symbol per client, bars and status immediately), heartbeats every
// ten seconds and drops clients that stop answering. Nothing a client sends reaches the provider except symbol names.
//
//   client → {op:"sub", syms:[…]} · {op:"unsub", syms:[…]} · {op:"ping"}
//   hub    → {type:"hello", status} · {type:"snap", sym, …} · {type:"tick", sym, price, t, size, bar, session, feedType}
//            {type:"bar", sym, bar, final} · {type:"bbo", sym, bid, ask} · {type:"status", …} · {type:"hb", t} · {type:"error", msg}
import { WebSocketServer } from "ws";

export function attachHub(httpServer, engine, { path = "/ws", rest = null, heartbeatMs = 10000, tickEveryMs = 250, log = (...a) => console.log("[hub]", ...a), maxSubsPerClient = 60 } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const clients = new Set();
  httpServer.on("upgrade", (req, socket, head) => { let u; try { u = new URL(req.url, "http://x"); } catch { socket.destroy(); return; } if (u.pathname !== path) { socket.destroy(); return; } wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req)); });
  const send = (ws, obj) => { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} } };
  const snapFor = sym => { const s = engine.snapshot(sym); return s ? { type: "snap", sym, price: s.price, t: s.t, prev: s.prev, bid: s.bid, ask: s.ask, bar: s.bar, bars: s.bars.slice(-30), daily: s.daily, unavailable: s.unavailable || false, provider: s.provider, feedType: s.feedType } : { type: "snap", sym, price: null }; };
  wss.on("connection", ws => {
    const c = { ws, subs: new Set(), alive: true, pendingTicks: new Map(), pendingBbo: new Map(), flush: null };
    clients.add(c); send(ws, { type: "hello", protocol: 1, status: engine.status() });
    ws.on("pong", () => { c.alive = true; });
    ws.on("message", async raw => {
      let m; try { m = JSON.parse(String(raw).slice(0, 4096)); } catch { return send(ws, { type: "error", msg: "bad json" }); }
      if (m.op === "ping") return send(ws, { type: "hb", t: Date.now() });
      const syms = (Array.isArray(m.syms) ? m.syms : []).map(s => String(s || "").toUpperCase().trim()).filter(s => /^[A-Z][A-Z.\-]{0,9}$/.test(s)).slice(0, maxSubsPerClient);
      if (m.op === "sub") {
        const fresh = syms.filter(s => !c.subs.has(s)); if (c.subs.size + fresh.length > maxSubsPerClient) return send(ws, { type: "error", msg: `at most ${maxSubsPerClient} symbols per client` });
        for (const s of fresh) c.subs.add(s); const added = engine.subscribe(fresh);
        for (const s of fresh) send(ws, snapFor(s));
        if (added.length && rest) seed(added).catch(e => log("seed", e.message));
        send(ws, { type: "status", ...engine.status() });
      } else if (m.op === "unsub") { const had = syms.filter(s => c.subs.has(s)); for (const s of had) c.subs.delete(s); engine.unsubscribe(had); }
      else send(ws, { type: "error", msg: "unknown op" });
    });
    ws.on("close", () => { engine.unsubscribe([...c.subs]); clients.delete(c); clearTimeout(c.flush); });
    ws.on("error", () => {});
  });
  // previous close / daily figures from REST for symbols the stream will not announce by itself; a symbol the provider rejects is marked unavailable
  async function seed(syms) {
    try { const snaps = await rest.snapshots(syms); for (const [sym, s] of Object.entries(snaps)) { if (s.error) { engine.markUnavailable(sym, s.error); } else { engine.seed(sym, { prev: s.prev, price: s.price, t: s.t, daily: s.open != null ? [s.t || Date.now(), s.open, s.high, s.low, s.price, s.volume || 0] : null }); } broadcast(sym, snapFor(sym)); } }
    catch (e) { log("snapshots", e.message); }
  }
  const broadcast = (sym, obj) => { for (const c of clients) if (c.subs.has(sym)) send(c.ws, obj); };
  const scheduleFlush = c => { if (c.flush) return; c.flush = setTimeout(() => { c.flush = null; for (const [, t] of c.pendingTicks) send(c.ws, t); c.pendingTicks.clear(); for (const [, b] of c.pendingBbo) send(c.ws, b); c.pendingBbo.clear(); }, tickEveryMs); };
  engine.on("tick", t => { const msg = { type: "tick", ...t }; for (const c of clients) if (c.subs.has(t.sym)) { c.pendingTicks.set(t.sym, msg); scheduleFlush(c); } });
  engine.on("bbo", b => { const msg = { type: "bbo", ...b }; for (const c of clients) if (c.subs.has(b.sym)) { c.pendingBbo.set(b.sym, msg); scheduleFlush(c); } });
  engine.on("bar", b => broadcast(b.sym, { type: "bar", ...b }));
  engine.on("status", s => { const msg = { type: "status", ...s }; for (const c of clients) send(c.ws, msg); });
  const hb = setInterval(() => { for (const c of clients) { if (!c.alive) { try { c.ws.terminate(); } catch {} continue; } c.alive = false; try { c.ws.ping(); } catch {} send(c.ws, { type: "hb", t: Date.now(), state: engine.state }); } }, heartbeatMs); hb.unref?.();
  return { wss, clients, close() { clearInterval(hb); for (const c of clients) { try { c.ws.close(); } catch {} } wss.close(); } };
}
