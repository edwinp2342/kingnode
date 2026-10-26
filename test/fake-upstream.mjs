// A stand-in for Alpaca's stream for end-to-end runs without credentials: `node test/fake-upstream.mjs 4899` then start the server with
//   MARKET_STREAM=alpaca ALPACA_KEY=x ALPACA_SECRET=y ALPACA_STREAM_URL=ws://127.0.0.1:4899 node desktop/server.js
// It authenticates anything, confirms subscriptions and prints a synthetic random walk for every subscribed symbol (clearly not market
// data: every price starts at 100.00). Never point the app at this and call it live.
import { WebSocketServer } from "ws";
const port = Number(process.argv[2] || 4899); const wss = new WebSocketServer({ port }); const px = new Map();
wss.on("connection", ws => {
  const subs = new Set(); ws.send(JSON.stringify([{ T: "success", msg: "connected" }]));
  ws.on("message", raw => { const m = JSON.parse(String(raw)); if (m.action === "auth") ws.send(JSON.stringify([{ T: "success", msg: "authenticated" }])); if (m.action === "subscribe") { for (const s of m.trades || []) subs.add(s); ws.send(JSON.stringify([{ T: "subscription", trades: [...subs], quotes: [...subs], bars: [...subs] }])); } if (m.action === "unsubscribe") for (const s of m.trades || []) subs.delete(s); });
  const timer = setInterval(() => { if (ws.readyState !== 1) return; const now = new Date(); const out = [];
    for (const s of subs) { const p = +((px.get(s) || 100) * (1 + (Math.random() - 0.5) * 0.002)).toFixed(2); px.set(s, p); out.push({ T: "t", S: s, p, s: 100, t: now.toISOString(), c: ["@"] }); if (now.getSeconds() === 0 && now.getMilliseconds() < 400) out.push({ T: "b", S: s, o: p, h: p * 1.001, l: p * 0.999, c: p, v: 1000, t: new Date(Math.floor((now.getTime() - 60000) / 60000) * 60000).toISOString() }); }
    if (out.length) ws.send(JSON.stringify(out)); }, 350);
  ws.on("close", () => clearInterval(timer));
});
console.log(`fake Alpaca stream on ws://127.0.0.1:${port} (synthetic prices — not market data)`);
