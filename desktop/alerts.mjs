// Kingnode background alerts — runs with the tab closed. Polls the watchlist's chains every N minutes during market hours,
// posts to Discord when spot is within ALERT_PCT of a wall or the flip, or when the walls move.
//   DISCORD_WEBHOOK=... node desktop/alerts.mjs SPX IWM TLT
// Add to pm2 or a cron line (MAINTENANCE.md) to keep it running.
import { fetchChain } from "../api/_lib/data.js";
import { computeLevels, fmt, money } from "../api/_lib/levels.js";
import { config } from "dotenv";
config({ path: new URL("../.env.local", import.meta.url).pathname });

const syms = process.argv.slice(2).map(s => s.toUpperCase()); if (!syms.length) { console.error("Usage: node alerts.mjs SPX IWM TLT"); process.exit(1); }
const hook = process.env.DISCORD_WEBHOOK, pct = Number(process.env.ALERT_PCT || 0.2) / 100, every = Number(process.env.ALERT_EVERY_MIN || 5);
const last = new Map(); const fired = new Map();
async function post(text) { console.log(text); if (!hook) return; try { await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text }) }); } catch (e) { console.error("webhook", e.message); } }
function marketOpen() { const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })); const m = et.getHours() * 60 + et.getMinutes(); return et.getDay() % 6 !== 0 && m >= 570 && m <= 965; }
async function tick() {
  if (!marketOpen()) return;
  for (const sym of syms) {
    try {
      const l = computeLevels(await fetchChain(sym), 4, 8); const prev = last.get(sym); last.set(sym, l);
      for (const [name, K] of [["put wall", l.putWall], ["call wall", l.callWall], ["flip", l.flip]]) {
        if (!K) continue; const key = `${sym}|${name}|${K}`; const dist = Math.abs(l.spot / K - 1);
        if (dist < pct && Date.now() - (fired.get(key) || 0) > 30 * 60e3) { fired.set(key, Date.now()); await post(`📍 **${sym}** ${fmt(l.spot, 2)} is within ${(dist * 100).toFixed(2)}% of the ${name} ${fmt(K)} · net gamma ${money(l.total)}`); }
      }
      if (prev && (prev.callWall !== l.callWall || prev.putWall !== l.putWall)) await post(`🔁 **${sym}** walls moved: PW ${fmt(prev.putWall)}→${fmt(l.putWall)} · CW ${fmt(prev.callWall)}→${fmt(l.callWall)}`);
    } catch (e) { console.error(sym, e.message); }
  }
}
await post(`Kingnode alerts running for ${syms.join(", ")} (every ${every} min, ${(pct * 100).toFixed(2)}% proximity).`);
tick(); setInterval(tick, every * 60e3);
