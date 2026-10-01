// Morning levels post. Vercel cron hits this on weekdays (see vercel.json); you can also call it by hand:
//   curl -H "Authorization: Bearer $CRON_SECRET" https://yoursite/api/cron/morning
// Posts to DISCORD_WEBHOOK (or LEAD_WEBHOOK) and returns the text. Tickers from MORNING_TICKERS (default SPX,SPY,QQQ,IWM).
import { fetchChain } from "../_lib/data.js";
import { computeLevels, fmt, money } from "../_lib/levels.js";

export default async function handler(req, res) {
  const auth = req.headers.authorization || "";
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: "unauthorized" });
  const tickers = (process.env.MORNING_TICKERS || "SPX,SPY,QQQ,IWM").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const lines = [], errors = [];
  for (const sym of tickers) {
    try {
      const l = computeLevels(await fetchChain(sym), 4, 8);
      lines.push(`**${sym}** ${fmt(l.spot, 2)} · ${l.total > 0 ? "+γ (pinned)" : "−γ (trending)"} ${money(l.total)} · PW ${fmt(l.putWall)} · flip ${fmt(l.flip)} · CW ${fmt(l.callWall)} · EM ±${fmt(l.expectedMove, 1)} (${fmt(l.expectedPct, 2)}%)`);
    } catch (e) { errors.push(`${sym}: ${e.message}`); }
  }
  const date = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });
  const text = `📈 **Levels — ${date}** (dealer gamma, nearest 4 expirations)\n${lines.join("\n")}${errors.length ? `\n⚠️ ${errors.join("; ")}` : ""}\n_Not investment advice._`;
  const hook = process.env.DISCORD_WEBHOOK || process.env.LEAD_WEBHOOK;
  let posted = false;
  if (hook && lines.length) {
    try { const r = await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text, text }) }); posted = r.ok; }
    catch (e) { errors.push("webhook: " + e.message); }
  }
  console.log("MORNING", JSON.stringify({ posted, errors }));
  return res.status(errors.length && !lines.length ? 502 : 200).json({ posted, text, errors });
}
