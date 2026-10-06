# Kingnode

A personal options terminal. It reads the options chain the way a dealer desk does and shows where price gets pinned (dealers long gamma) and where it accelerates (dealers short), who is positioned where (the king node), and whether the trade you want is priced fairly. Around that: a flow tape, a rules engine (Ideas, backtested), a market-maker-style pricing desk (Quant), a journal with a coach, a book with stress tests, a macro calendar with notifications, a halal screen, and Ava, a desk assistant that knows the screen.

**Run it:** https://edwinp2342.github.io/kingnode/app.html (install from the browser as an app; see DESKTOP.md). Data: a GitHub Actions loop snapshots Cboe (chains, 15-min delayed) and Yahoo (bars/quotes, near real-time, pre/after-hours) about once a minute to the `data` branch; the site reads from there. Options: a Cloudflare proxy (proxy/), the desktop server (desktop/), or a vendor key for real-time (LIVE.md).

**Tests:** `node --test test/` (math) and `python3 test/smoke.py` (every tab in a headless browser). CI runs the math tests on push. `node scripts/backtest.mjs` re-runs the Ideas validation.

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

## Layout (v3)

Ticker tape (TradingView) → toolbar with search and quick tickers → symbol row with a live TradingView quote → **TradingView Advanced Chart** (58vh, EMA/VWAP/RSI preloaded, symbol search and extended hours inside the widget) → tabs (Positioning, Flow, Institutions, Gamma profile, Skew, Fresh, Chain, Watchlist, Tracked, Drift, Built-in chart) with a right rail for key levels, the read and alerts. Flat, dense, TradingView-style dark theme; light theme via the moon button.

**Pricing:** the quote and chart are TradingView (live for indexes, exchange-dependent for stocks). The options analytics still come from your chain provider, so the **Chain spot** row in Key levels shows the price the levels were computed against — with `cboe` that's 15 minutes behind the TradingView print, which is expected. Set `DATA_PROVIDER=polygon` for a real-time chain.

**TradingView widgets** load from s3.tradingview.com on your own domain. They can't load inside the claude.ai preview (its security policy blocks third-party scripts), so the preview falls back to the built-in chart automatically. TradingView's widget terms require leaving their logo/attribution visible, which the widgets do themselves.

## Live data with no server: the GitHub Action feed

`.github/workflows/data.yml` runs `scripts/snapshot.mjs` every 5 minutes during market hours (free on a public repo). It pulls the chain, 5-minute bars (with extended hours) and daily bars for 20 tickers plus the tape quotes, writes compact JSON, and force-pushes it to the `data` branch. The site reads `raw.githubusercontent.com/edwinp2342/kingnode/data/…`, which allows browser requests, so the static site and the phone app are live (15-minute delayed) with nothing running on your machine. Order of sources in the app: local server → snapshot feed → direct Cboe → proxy → demo. Add tickers with the `SNAPSHOT_SYMBOLS` variable in the workflow or just edit the list in `scripts/snapshot.mjs`.

## Running it live on the free feed (static site, no server)

The GitHub Pages build pulls everything from Cboe's delayed feed directly in your browser: chain (OI, volume, IV, greeks), intraday and daily bars. Quote and levels are 15 minutes behind. What you get without a server:
- **Chain, Heatseeker, ladder, Positioning, Gamma profile, Skew, Chain, Watchlist, Drift, Playbook** — real.
- **Flow, Contract flow, alerts, Playbook scanner** — built from **volume changes between refreshes** ("derived tape"): each print is a contract whose volume rose since the last refresh, size = the change, side = last trade vs the prior bid/ask. Direction and size are real; timing is 15-min delayed and resolution is one refresh. Leave the tab open and it fills in through the session. Saved per ticker per day.
- **Data status** card (right rail) shows which feed is live, demo, or failed. Red row → screenshot it plus the console (F12) and send it.
- Institutions and Ask the desk need the server version (desktop app).


- **Blackout theme (default):** true-black background for OLED and late sessions. The moon button cycles blackout → dark → light; TradingView widgets follow.
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
- **Built-in chart:** scroll to zoom, drag to pan, range buttons load the whole range; "Show" sets a bar window.
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
