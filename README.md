# Kingnode

A personal options terminal. It reads the options chain the way a dealer desk does and shows where price gets pinned (dealers long gamma) and where it accelerates (dealers short), who is positioned where (the king node), and whether the trade you want is priced fairly. Around that: a flow tape, a rules engine (Ideas, backtested), a market-maker-style pricing desk (Quant), a journal with a coach, a book with stress tests, a macro calendar with notifications, a halal screen, and Ava, a desk assistant that knows the screen.

**Run it:** https://edwinp2342.github.io/kingnode/app.html (install from the browser as an app; see DESKTOP.md). Data: a GitHub Actions loop snapshots Cboe (chains, 15-min delayed) and Yahoo (bars/quotes, near real-time, pre/after-hours) about once a minute to the `data` branch; the site reads from there. Options: a Cloudflare proxy (proxy/), the desktop server (desktop/), or a vendor key for real-time (LIVE.md).

**Tests:** `node --test test/math.test.mjs` (math, 14 cases) and `python3 test/smoke.py` (every tab in a headless browser). CI runs the math tests on push. `node scripts/backtest.mjs` re-runs the Ideas validation (v2: regime, relative-strength and ATR-stop variants; `DATA_DIR=<local copy of the data branch>` to run offline).

## Files

| File | What it does |
|---|---|
| `index.html` | Landing page. Edit `CONFIG` at the bottom for contact email and plan copy. |
| `app.html` | The terminal. All analytics run in the browser from a chain snapshot. |
| `api/bars.js` | 5-minute price bars for the Chart tab (Yahoo, delayed, unofficial — replace with your vendor). |
| `api/_lib/data.js` | Provider layer: Cboe / Tradier / Polygon → one chain shape. Bars too. |
| `api/_lib/levels.js` | Server copy of the levels math (used by the morning cron). |
| `api/cron/morning.js` | Scheduled morning-levels Discord post. |
| `api/health.js` | Health check for the maintenance agent. |
| `api/flow.js` + `collector/` | Flow tape ingest and the websocket collector. |
| `api/chain.js` | Fetches and normalizes the options chain (OI, volume, IV, greeks). Gates non-SPX/SPY tickers to Pro. |
| `api/generate.js` | "Ask the desk" — sends the computed levels plus the trader's question to Claude. Pro only. |

## Layout

Index tape (the feed's quotes, every 20 s in regular hours) → toolbar with search over every US-listed symbol and quick tickers → symbol row with the freshest real price for the name (tape → feed minute quote → market sweep) and a badge saying where it came from, plus relative volume → **the chart** (canvas, one toolbar row: interval, range, Indicators ▾, Levels ▾, extended hours, fit, full screen; drag the grip under it to resize, `F` for full screen) → tabs (Map · Flow · Trade · Desk · Lists) with a right rail for key levels, the read, alerts, events and data status.

**The chart.** One base series per ticker — the session's 1-minute bars for the core names, 5-minute bars (5 days) for the ~300 charted names, daily bars or the nightly closes for everything else — aggregated on the client to the interval you pick (5m → 15m/30m/1h is instant, no refetch; hourly bars sit on the 09:30 grid). The last candles are patched from the live buckets every 15 s and the latest print folds into the forming bar, so a core name's chart moves with the tape. Walls, flip, expected-move band, max pain, prior-day H/L/C, opening range, your own horizontal lines (click to drop, click again to remove), EMAs, VWAP, Bollinger, RSI and volume are drawn on the canvas with the values as pills on the right axis. The **Chain spot** row in Key levels (and a gold "chain spot" line when it differs from the print) shows the price the levels were computed against — with `cboe` that is 15 minutes behind the print, which is expected. Set `DATA_PROVIDER=polygon` for a real-time chain.


## Live data with no server: the GitHub Action feed

`.github/workflows/data.yml` runs `scripts/snapshot.mjs` as a 5.5-hour loop (free on a public repo). Every ~60 s while the market is open it pulls the tape quotes and 5-minute bars (extended hours) for ~300 tickers, every 3rd cycle the Cboe chains for 80 tickers, every 9th the daily bars, and once an hour FINRA's off-exchange short-volume file; it writes compact JSON and force-pushes it to the `data` branch. The site reads `raw.githubusercontent.com/edwinp2342/kingnode/data/…`, which allows browser requests, so the static site and the phone app are live (15-minute delayed chains, near-real-time prices) with nothing running on your machine.

**The loop keeps itself alive.** GitHub does not guarantee cron (it fired once on Fri 10/9 and once on Mon 10/12, leaving the terminal dark for a session and a half), so four minutes before a run ends it dispatches its own successor with `workflow_dispatch`; the successor's start cancels it (concurrency group). The hourly cron is only a watchdog (`scripts/watchdog.mjs`): it reads `index.json` through the API and dispatches a loop only when nothing was written for ten minutes, so it never cancels a healthy run. When the market is closed the loop idles at one heartbeat per 10 minutes.

**Freshness, measured.** GitHub's raw CDN caches every path for five minutes and ignores the query string (`x-cache: HIT` on a unique `?t=`), so a file rewritten every 20 seconds reaches a browser every five minutes. The feed therefore also writes the tape as `live/q-<20-second bucket>.json` and the universe as `live/u-<minute bucket>.json`; a path nobody has fetched is a cache miss, so the app asks for the bucket ~30 s behind now and sees the tape 15–40 s old. The 20-second bucket carries a quote **and the last eight 1-minute bars for every core name** (the fast loop pulls one Yahoo chart per core name each tick, a dozen in flight, ~800 ms for 77 names), and the minute bucket carries the last three 5-minute bars for all ~300 charted names — so the chart's forming candle moves with the tape, and the full-session files behind it (`SYM-1m.json` every minute, `SYM-bars.json` every cycle) can sit in the CDN cache without the chart falling behind. Chains and everything else ride the five-minute cache (they are 15-minute delayed anyway). The local git repo on the runner is re-created every 40 pushes with auto-gc off — amended commits left a pile of loose objects whose foreground gc stalled the loop for minutes. `scripts/market-clock.mjs` holds the NYSE calendar (holidays, 1 PM closes); the app has the same table.

Files on the `data` branch: `index.json` (phase, cycle, when chains/bars were last written — the app shows a **Feed stale** banner when this stops moving during market hours), `quotes.json` (a quote and the last 1-minute bars for every core name), `universe.json` (last/prev/regular price plus the last 5-minute bars for every charted ticker: watchlist, halal screen, movers, chart patches), `SYM.json` (chain, 8 expiries, ±15%), `SYM-1m.json` (the session's 1-minute bars, core names), `SYM-bars.json` (5-minute, 5 days), `SYM-daily.json` (1 year), `shortvol.json` (FINRA, 10 days), `scan.json` (one line per chain ticker: premium, call share, unusual contract, IV, levels; `core` + `tierB` = the 150 most active optionable names, re-picked from the sweep every 15 minutes and refreshed a dozen per cycle so Cboe's rate limiter stays quiet), `symbols.json` (every US-listed common stock and ETF from Nasdaq Trader with Cboe's options flag and a first-seen date per symbol — the IPO watch), `market.json` (last / previous close / change / volume / 20-day average volume for every optionable name, swept every 5 minutes in regular hours — relative volume in the app comes from this), `closes.json` (60 daily closes and the 20-day average volume per optionable name, nightly), `breadth.json` (after every sweep: advancers / decliners, up- vs down-dollar volume, share of stocks above their 20- and 50-EMA, 60-day highs and lows, plus the session's series — common stocks over $5 only), `levels-history.json` (one row per ticker per day of spot, walls, flip, gamma, expected move and its expiry, IV and flow — the only history the force-pushed branch keeps; the app scores each close's expected move against the next session from it, and `scripts/backtest.mjs` uses it to test the positioning overlay once 40 entries are covered).

Order of sources in the app: local server → snapshot feed → direct Cboe → proxy → demo. A real snapshot is never thrown away for being old: the app shows **stale** with its age (only during market hours — a Friday close on a Saturday is simply the last session). Demo appears only when there is no real data at all, and it says so everywhere. Add tickers with the `SNAPSHOT_SYMBOLS` variable in the workflow or just edit the list in `scripts/snapshot.mjs`. To restart the feed from the app, put a fine-grained GitHub token with **Actions: write** on this repo in ⚙ Settings; the stale banner then has a one-click **Restart feed**.

## Running it live on the free feed (static site, no server)

The GitHub Pages build pulls everything from Cboe's delayed feed directly in your browser: chain (OI, volume, IV, greeks), intraday and daily bars. Quote and levels are 15 minutes behind. What you get without a server:
- **Chain, Heatseeker, ladder, Positioning, Gamma profile, Skew, Chain, Watchlist, Drift, Playbook** — real.
- **Flow, Contract flow, alerts, Playbook scanner** — built from **volume changes between refreshes** ("derived tape"): each print is a contract whose volume rose since the last refresh, size = the change, side = last trade vs the prior bid/ask. Direction and size are real; timing is 15-min delayed and resolution is one refresh. Leave the tab open and it fills in through the session. Saved per ticker per day.
- **Data status** card (right rail) shows which feed is live, demo, or failed. Red row → screenshot it plus the console (F12) and send it.
- Institutions and Ask the desk need the server version (desktop app).


- **Blackout theme (default):** true-black background for OLED and late sessions. The moon button cycles blackout → dark → light.
- **Contract "What if":** in the inspector, sliders for price move, days forward and IV change show the estimated contract price (Black-Scholes from the quoted IV, scaled to the live mid). This is the theta/vol-crush check before you buy.
- **Positions with live Greeks:** the Playbook's positions table shows mark, P&L, delta, theta/day, breakeven and three scenarios (+1% today, flat 3 days, −1% today) for any position on the current ticker. Add positions you already hold.
- **⚑ Flag:** one button that posts a note plus the screen context (ticker, tab, expirations, levels) to your Discord. Use it while testing; it's how feedback arrives with context.

- **Heatseeker (default tab):** strike × time map of dealer exposure through the session (GEX / VEX / DEX), price path drawn over it, walls and flip marked. Snapshots are recorded every 3 minutes while the tab is open (per ticker, per day, in the browser); demo mode synthesizes a session.
- **Playbook:** your rules as software. Set account size, max risk per trade (default 5%), max open positions (3) and minimum DTE (30). It scans today's tape for contracts bought at the ask with size and ≥ min DTE, scores them (premium, % at ask, vol/OI, sweeps, alignment with walls/flip), sizes them at max risk assuming a 50% premium stop, and turns one into a trade plan (entry, size, risk, underlying target = opposite wall, invalidation = flip or near wall). Added positions show DTE countdown; under 21 DTE turns red.
- **Suspicious-flow alerts (Alerts card):** rules for min premium, sweeps only, ask side only, min vol/OI, min DTE. Fires browser notifications and, for Pro, posts to Discord via `/api/notify`. Flow is polled in the background every 20s while rules are on. Level alerts (wall/flip proximity) are in the same card.
- **Chart:** prior-day high/low/close, opening range (first 15 minutes), and click-to-draw horizontal lines (click near a line to remove; saved per ticker).

- **Exposures:** GEX (gamma), **VEX (vanna)** and **DEX (dealer delta)** per strike and per cell. Regime box shows both gamma and vanna sign; Key levels adds the vanna peak. Gamma profile has a GEX/VEX/DEX switch; the heatmap "Show" menu includes VEX and DEX. Vanna is Black-Scholes with r=0 from the quoted IV: vanna = −φ(d1)·d2/σ; VEX = sign · vanna · OI · 100 · spot · 1%.
- **Heatmap:** canvas-rendered, smoothed across strikes (5-tap gaussian) with spot, walls and flip drawn on, expected-move band, top nodes flagged. "Grid" shows exact cells.
- **Flow:** net-premium timeline (bullish − bearish, cumulative), expiry filter, new prints flash gold as they arrive, 10-second polling when the collector is live.
- **Contract flow:** every contract that printed, aggregated: premium, prints, average size, % at ask/bid, lean, sweeps/blocks, and a sparkline of cumulative ask-minus-bid premium.
- **Chart:** scroll to zoom about the cursor, drag to pan, pinch on a phone, double-click or **Fit** to snap back to the latest bars; the crosshair row shows O/H/L/C, the bar's change and volume plus every indicator's value.
- **Live indicator:** pulsing LIVE badge with a countdown to the next chain refresh (Settings → refresh seconds; 15s minimum).

- **Search:** ticker or company name; 250 built-in names plus `/api/search` (Yahoo) for anything listed. Press `/` to focus it.
- **Institutions tab:** composite lean built from options flow at the ask, accumulation/distribution and Chaikin money flow (bars), FINRA off-exchange short-volume trend (`/api/shortvol`), block-sized intraday bars, and SEC Form 4 insider filings (`/api/insiders`, set `SEC_USER_AGENT` to your name+email as the SEC requires).
- **Extended hours:** chart toggle shades pre-market/after-hours bars; the header shows a PRE/AH price badge when the last extended bar is outside the regular session.

- **Chart:** 1m–1d candles (Yahoo delayed via `api/bars.js`), EMA overlays (lengths editable, default 21/50/200), session VWAP, volume, crosshair OHLC readout, walls/flip/max pain and the expected-move band drawn on price. Off-screen levels show as arrows on the right edge.
- **Heatmap:** dealer gamma by strike × expiration; switch to call-only, put-only, open interest or volume. Click any cell to open the **contract inspector**.
- **Contract inspector:** OI, volume, vol/OI, bid/ask/mid, IV, delta, gamma, OI and volume notional, dealer gamma $, distance from spot, DTE — for both the call and the put at that strike/expiry. **Track** pins a contract to the Tracked tab, where OI/vol/mid/IV are snapshotted every few minutes (change since tracked is shown).
- **Gamma profile, Skew & expected move, Fresh positioning, Chain, Morning levels (multi-ticker + Copy for Discord), Today's drift** (walls and flip recorded through the session).
- **Settings (⚙):** default ticker, refresh interval, default expiration count, strike range, dealer model, alert distance, fresh-positioning thresholds. Chart settings live on the chart toolbar. Everything persists in the browser.
- **Personal use:** set `GATE_SYMBOLS=false` to make every ticker free while it's just you.

## Ava (desk assistant)

Ava is Claude. Without an Anthropic API key in ⚙ Settings she is an offline rule engine and says so on every answer; with one she reads the screen, your rules, open book, last 12 journal entries and her own memory, and talks like a colleague. Model is selectable (Sonnet 5.5 default, Opus 5.5, Haiku 5.5). Her context is the whole market, not just the loaded ticker: the index tape, movers across ~300 names, `data/scan.json` (the feed's one-line read of every chain ticker: premium today and call share, the unusual contract, ATM IV, walls/flip/expected move), macro momentum, the calendar. She has real tools (Anthropic tool use, streamed): `peek_ticker`, `price_history` (trend, RSI, ATR, realized vol, 52-week range), `scan_market` (premium / calls / puts / unusual / wall / iv / gainers / losers), `session_flow`, `quant_structures` (the Quant desk on any name), `idea_score` (the Ideas engine), `journal`, `calendar`, `log_trade`, `close_trade`, `remember` (fact / plan / lesson / feedback) and `load_ticker`. She can write to the app: tell her a trade you took, shares you bought or a position you closed and she appends `<<kn {...}>>` action lines that the app executes (journal + playbook) and shows as green chips under her reply; she keeps durable facts in **Memory** (the button in her header; delete anything with ×). Answers render as light markdown and stream in; there is a mic (dictate) and a read-aloud toggle where the browser supports them. The static part of her prompt is cached (cheaper, faster). Everything stays in this browser — use Back up / Restore to carry it over.

## The math

- **Dealer gamma per cell** = gamma × OI × 100 × spot² × 1%. Calls positive, puts negative (standard "dealers long calls, short puts" convention; a magnitude-only model is available in the controls).
- **Call wall / put wall** = strike above/below spot with the largest call/put gamma.
- **Gamma flip** = strike where cumulative net gamma changes sign, nearest to spot.
- **Max pain** = strike minimizing total option payout for the nearest expiration.
- **Expected move** = ATM straddle mid for each expiration.
- **Fresh positioning** = contracts trading ≥1.5× their open interest today, ranked by notional.

## Data providers

`api/_lib/data.js` normalizes three vendors into one chain shape; set `DATA_PROVIDER` and the matching key:

| Provider | Cost | Chain | Bars | Flow tape | Notes |
|---|---|---|---|---|---|
| `cboe` (default) | free | 15-min delayed, OI/vol/IV/greeks | Yahoo, delayed | no | Personal use only — Cboe's terms don't allow reselling it |
| `tradier` | free sandbox (delayed) / paid real-time | yes, greeks included | Yahoo | no | Easiest real vendor; sandbox key from developer.tradier.com in minutes |
| `polygon` | options plans from ~$30/mo; trades stream on higher tiers | yes | real-time | **yes** via `collector/` | The one to pick if you want Flowseeker-style prints |

Switching vendors changes nothing in the terminal. If a vendor renames a field, fix it in that one function.

## Flow (Flowseeker equivalent)
`collector/flow-collector.mjs` subscribes to Polygon's options trade + quote stream, tags each print sweep/block and ask/bid/mid against the live quote, filters below `MIN_PREMIUM`, and ships batches to `/api/flow`. The **Flow** tab shows the tape with premium/type/side filters, a call-vs-put premium bar, and the most active contracts (click any to open the inspector). See MAINTENANCE.md to run it.

## Daily jobs
`/api/cron/morning` posts the day's levels to Discord at 9:05 ET; `/api/health` is the endpoint a scheduled Claude Code agent checks (MAINTENANCE.md has the exact prompt and crontab line).

## Setup

```bash
unzip kingnode.zip && cd kingnode
npm install
git init && git add -A && git commit -m "Kingnode"
cp .env.example .env.local && echo "APP_SECRET=$(openssl rand -hex 32)" >> .env.local
npm i -g vercel && vercel && vercel env add APP_SECRET   # repeat for each variable
vercel --prod
```

Then: Stripe → Settings → Billing → Customer portal → enable cancel and plan switching. Anthropic Console → Limits → set a spend cap. Test the whole loop with card `4242 4242 4242 4242`.

## Personal-use quick start (no Stripe, no Anthropic key)

    unzip kingnode.zip && cd kingnode && npm install
    cp .env.example .env.local
    # set APP_SECRET, and either leave DATA_PROVIDER=cboe or add a TRADIER_TOKEN/POLYGON_KEY
    npx vercel dev          # http://localhost:3000/app.html

Deploy the same way with `vercel --prod`, add the env vars in the Vercel dashboard, attach a Blob store (Storage tab) if you run the collector.


## Roadmap ideas (what would justify more than $19)

Real-time flow tape (sweeps, blocks) once you have a licensed feed; intraday history of the walls and flip; a Discord/Telegram bot that posts the morning levels; a watchlist with per-ticker alerts.
