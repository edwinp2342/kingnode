# KINGNODE — code review pack

Paste these files into ChatGPT (or any reviewer) in order. 00 is the map; 01–0N is the terminal's JavaScript split into chunks under ~45K characters each; 10 is the server/feed code; 20 is the markup and CSS.

## What it is
A personal options terminal (single-page web app, no framework, no build step) that turns an options chain into dealer-positioning analytics, plus flow, a rules-based trade engine, a journal with a coach, and a market-maker-style pricing desk. Hosted as static files on GitHub Pages; data comes from a GitHub Actions loop that snapshots Cboe/Yahoo every ~minute to a `data` branch, or from an optional local Node server / Cloudflare proxy.

## Files
- `app.html` — the whole terminal: ~304K chars (CSS 20K, JS 278K). Vanilla JS, one IIFE, DOM built with a tiny `h()` helper, SVG/canvas drawn by hand.
- `index.html` — landing page. `sw.js`, `manifest.webmanifest` — installable PWA.
- `api/_lib/data.js` — data providers (Cboe delayed, Tradier, Polygon) → one chain shape. `api/_lib/levels.js` — server copy of the levels math.
- `api/chain.js`, `bars.js`, `quotes.js`, `flow.js`, `insiders.js`, `shortvol.js`, `search.js`, `generate.js`, `notify.js`, `health.js`, `cron/morning.js` — serverless-style handlers.
- `scripts/snapshot.mjs` + `.github/workflows/data.yml` — the feed loop. `desktop/server.js` + `main.js` — local server + Electron wrapper. `collector/flow-collector.mjs` — Polygon websocket flow collector. `desktop/alerts.mjs` — background alerts. `proxy/cloudflare-worker.js` — CORS proxy.

## Data shape (everything downstream assumes this)
chain = { symbol, spot, asOf, delayed, source, change, changePct, rows: [[exp, type("C"|"P"), strike, oi, vol, iv, gamma, delta, bid, ask, last, last_trade_time?], …] }
bars = [[t_ms, open, high, low, close, volume], …]

## Core math (computeFrom)
- Dealer gamma per contract: sign · gamma · OI · 100 · spot² · 1%, sign = +1 calls / −1 puts under the standard model (dealers long calls, short puts); "short all" model = −1 for both.
- Vanna (VEX): Black-Scholes r=0, vanna = −φ(d1)·d2/σ; VEX = sign · vanna · OI · 100 · spot · 1%. Dealer delta (DEX) = −delta · OI · 100 · spot.
- Call wall = strike above spot with max call gamma; put wall = strike below spot with max put gamma; gamma flip = strike where cumulative net gamma changes sign, nearest spot; max pain for the nearest expiry; expected move = ATM straddle mid; "fresh positioning" = contracts with vol/OI ≥ 1.5.
- Charm into close: Δdelta over one day on 0–3 DTE × OI × 100 × spot, dealer-signed.

## Modules in the JS (search for the section banners)
1. Settings/state (`DEFAULTS`, `S`), helpers (`h`, `fmt`, `money`, `bsPrice`, `erf`).
2. Data: `load()` (server → snapshot → direct Cboe → proxy → demo), `cboeDirect`, `cboeBars`, `snapshotJson`, derived flow from volume deltas (`deriveFlow`).
3. Math: `computeFrom`, `hedgeFlows`, `trackLevelTests`, history/seeker recording.
4. Views: Heatseeker grid (`viewSeeker`) + session map (`viewSeekerSession`), Positioning (`viewHeat`), profile, skew, chain, flow (`viewFlow`, `viewContractFlow`), Ideas (`analyzeTicker`, `runIdeas`), Playbook (`flowSetups`, `planTrade`), Book (`bookRows`), Journal (`coachReport`, `aiCoach`), Brief (`buildBrief`), Macro, Quant desk (`quantCandidates`, `analytic`, `monteCarlo`, `rankQuant`, `quantCard`), Halal (`HALAL_UNIVERSE`), Institutions, chart (`viewChart` with zoom/pan/draw).
5. Alerts (`checkFlowAlerts`, `fireAlert`, `notify`), tape (`loadTape`), events calendar, status card, boot.

## What a reviewer should look at
- Correctness of the dealer-positioning conventions and the flip/wall definitions.
- The Monte Carlo (Student-t(4) shocks at realized vol, structure repriced daily with constant IV, exit rules) — fat-tail scaling and the anchoring to the model's t=0 value.
- The derived-flow heuristic (side from last trade vs prior bid/ask; sweep/block tagging) — known to be approximate.
- Robustness: everything is client-side state in localStorage; no auth; no tests beyond Playwright smoke scripts.
- Performance: the Heatseeker grid is an HTML table; the session map and the smooth heatmap are canvas; `rankQuant` does numeric integration per candidate (240 steps) and the MC runs 3,000 paths on demand.

## Known limitations (stated in-app)
Free feed is 15-minute delayed; flow is derived, not a trade tape; IV held constant in simulations; halal classifications are from recent screening-app results, not live balance sheets; no broker sync.
