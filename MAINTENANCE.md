# Daily maintenance

Two things run every day without you, and one agent checks on them.

## 1. Morning levels (automatic)
`vercel.json` schedules `/api/cron/morning` at 13:05 UTC on weekdays (9:05 ET during daylight time; change to `5 14 * * 1-5` after the November clock change). It pulls the chain for `MORNING_TICKERS`, computes walls/flip/expected move with the same math as the terminal, and posts to `DISCORD_WEBHOOK`. Run it by hand any time:

    curl -H "Authorization: Bearer $CRON_SECRET" https://YOURSITE/api/cron/morning

## 2. Flow collector (you start it)
Real-time options prints need a websocket that stays open, which serverless can't do. Run the collector on your laptop or a $5 VPS during market hours:

    cd collector && npm install
    POLYGON_KEY=... FLOW_SECRET=... SITE_URL=https://YOURSITE node flow-collector.mjs SPY QQQ NVDA TSLA

It exits if the socket drops; wrap it in `pm2` (`npm i -g pm2 && pm2 start flow-collector.mjs -- SPY QQQ`) so it restarts itself. The Flow tab shows **Live** when prints arrived in the last 5 minutes, **Collector offline** otherwise, and **Demo flow** when nothing has ever been ingested.

## 3. The health check + a scheduled Claude Code agent
`/api/health` tests the data provider, bars, and every required env var, and returns 503 if anything is broken. Point a scheduled Claude Code task at it so something notices before you do.

Create `~/kingnode-check.md`:

    Every weekday at 8:45 ET:
    1. curl https://YOURSITE/api/health and read the JSON.
    2. If ok is false: open the kingnode repo, look at the failing check, and fix it (a provider field rename, an expired key, a cron mis-schedule). Run `vercel --prod` when the fix is verified locally with `vercel dev`.
    3. curl the morning endpoint with the CRON_SECRET and confirm it returned posted:true.
    4. Report in one paragraph: what was checked, what was fixed, what needs me.

Then schedule it (macOS/Linux):

    crontab -e
    45 8 * * 1-5  cd ~/kingnode && claude -p "$(cat ~/kingnode-check.md)" >> ~/kingnode-check.log 2>&1

Claude Code runs with your repo, your env, and your Vercel login, so it can actually deploy fixes. Read the log once a week.

## When a provider changes a field name
That's the most common failure. The fix is always in one file, `api/_lib/data.js`, in the provider's `*Chain()` function — the rest of the app never sees vendor field names.
