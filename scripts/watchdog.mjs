// Cron watchdog: the hourly schedule used to start a full loop that cancelled the healthy one (every restart costs two minutes of
// warm-up and a stale tape). Now a scheduled run only looks: if the feed wrote within ten minutes it exits; otherwise it dispatches a
// fresh loop (workflow_dispatch), which takes over through the loop's own concurrency group.
const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
let at = 0;
try { const r = await fetch(`https://api.github.com/repos/${repo}/contents/index.json?ref=data`, { headers, signal: AbortSignal.timeout(20000) }); if (r.ok) { const j = await r.json(); const idx = JSON.parse(Buffer.from(j.content, "base64").toString("utf8")); at = Math.max(idx.at || 0, idx.fast?.at || 0); } } catch (e) { console.error("index read failed", e.message); }
const ageMin = at ? (Date.now() - at) / 60000 : Infinity;
console.log(`feed last wrote ${at ? ageMin.toFixed(1) + " min ago" : "never"}`);
if (ageMin < 10) { console.log("healthy — nothing to do"); process.exit(0); }
const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${process.env.FEED_WORKFLOW || "data.yml"}/dispatches`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ ref: process.env.FEED_REF || "main" }), signal: AbortSignal.timeout(20000) });
console.log(`stale — dispatched a fresh loop: http ${r.status}`); if (!r.ok) { console.error(await r.text()); process.exit(1); }
