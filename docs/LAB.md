# Kingnode Lab — research engine, architecture, roadmap

The Lab is Kingnode's answer to "QuantPad, but better where it matters": a research environment that runs on the data the feed
already produces, inside the terminal you already use, with Ava as the analyst. This document is the engineering record the
build directive asked for — what exists, how it is wired, what it can claim, what it costs, and what comes next.

## 1. Architecture assessment (what Kingnode is, honestly)

| Area | State | Notes |
|---|---|---|
| Frontend | **working** | one file, `app.html` (vanilla JS, canvas charts, no framework, no build step); PWA with `sw.js` |
| Hosting | **working** | GitHub Pages (static) and the preview artifact; optional self-hosted `desktop/server.js` (Railway-ready) |
| Data feed | **working** | `scripts/snapshot.mjs` on GitHub Actions: quotes/1-minute bars (Yahoo), chains (Cboe, 15-min delayed), market sweep of 5,000+ optionable names, breadth, levels history, macro (BLS/NY Fed/Treasury), closing read, anomalies, and now ten-year daily history |
| Storage | **working, local** | `localStorage` in the browser (journal, playbook, settings, Lab research journal, Ava memory); the data branch on GitHub for feed output; no database |
| Authentication / profiles / authorization | **not implemented** | single-user by design; the Railway server has an `ASK_KEY` password for Ava's key, nothing else |
| AI | **working** | Ava = Claude Messages API with native tools, from the browser with the user's key or through the server's key; prompt caching; audited writes with on-screen consent |
| Charting | **working** | own canvas engine (candles, indicators, levels); the Lab adds equity/drawdown charts on the same canvas approach |
| Python sandbox / code execution | **not implemented** | nothing runs user or model code; the Lab runs *specs* through a deterministic JS engine |
| Options data (historical) | **not available** | only the live delayed chain and the feed's own daily levels history (since 2026-10-15); no historical option prices → no honest options backtests yet |
| Fundamentals / SEC | **partial** | insider filings only; no financial statements |
| Macro | **working** | BLS, NY Fed, Treasury readings + verified release calendar; FRED optional with a key |
| Trading / execution | **never** | by design |
| Tests | **working** | 50 node tests + a headless-browser smoke run |

Integration map: `scripts/lab.mjs` (engine, ESM, no imports) → inlined into `app.html` by `scripts/inline-lab.mjs` as `window.KNLab`
(the test suite fails if the inline copy is stale) → used by the Lab tab (`viewLab`, `labBuilder`, `labResults`, `labJournalView`)
and by Ava's tools (`lab_run`, `lab_study`, `lab_last`, `lab_journal`, `lab_save`) → data from `data/hist/SYM.json` (ten years,
adjusted; `scripts/history.mjs`) merged with `SYM-daily.json` (the live year), positioning from `levels-history.json`. Ava works
without the Lab; the Lab works without Ava.

## 2. What the Lab does today (Milestone 1, delivered)

**Spec, not code.** A strategy is JSON: universe, side, entry conditions (feature · operator · value or another feature), exits
(target / stop / trailing in % or ATRs, time, or a rule), sizing, costs, fill model, date range, benchmark. Templates cover the
questions a buy-low trader asks: RSI dip in an uptrend, pullback to the 50-day in ATRs, z-score mean reversion, 55-day breakout
with a trailing stop, gap-down fade, three red days, and a positioning template (dip into the put wall in positive gamma).

**Engine.** Event-driven daily simulation: signals on the close, fills at the next open (no look-ahead), slippage on every
fill, stops before targets inside a bar, gaps fill at the open, equity-based sizing with a cap on open positions, a ranking
rule when there are more signals than slots, long and short, cash accounting, a complete ledger with MAE/MFE and the exit reason.

**Statistics.** CAGR, Sharpe, Sortino, Calmar, max drawdown and its length, profit factor, win rate, expectancy, exposure,
turnover, alpha/beta vs the benchmark; a t-test on the trades; bootstrap interval on the mean trade; Monte Carlo over resampled
trade sequences (drawdown and outcome distributions); Kelly from the ledger; **walk-forward** (parameters chosen on three years,
judged on the next, stitched out-of-sample curve, decay); **parameter sensitivity** grids; a **multiple-testing** note that counts
the variants you have tried of a named idea and says what Sharpe pure noise would reach; a **conditional probability study**
(hit rates with Wilson 95% intervals next to the base rate of all days, two-proportion test, mean/median/percentiles, target-
before-stop share with median days to each, excursions), pooled across symbols.

**Validation report** on every result: look-ahead, survivorship, sample size, costs, significance, data mining, out-of-sample,
span, data notes, exposure — each marked ok / note / warn, repeated verbatim to Ava.

**Research journal** (this browser, included in backups): title, question, note, the spec, market context at save time, metrics,
sampled equity curves, validation, walk-forward, sensitivity, Monte Carlo; search; side-by-side comparison; **rerun on today's
data** with the trades since you saved it; export/import JSON; CSV of trades.

**Ava.** Builds specs from plain English with the condition grammar, runs them, reads the journal, saves with consent, and is
instructed to report the validation lines before the returns.

## 3. Competitive comparison with QuantPad (provisional)

Sources: QuantPad's Trustpilot page (30 reviews, 3.7/5, pricing complaints: founders' $59.99 → public $169.99/month; themes:
data access valued, backtest/data errors, credits consumed by failed runs, hanging chats, Discord-only support) and public
profiles of its founder. The product site could not be fetched from this environment, so feature claims about QuantPad are
limited to what reviewers describe: AI-assisted Python strategy coding, bundled market data, backtesting, a chat/notebook
workflow, usage credits.

| | QuantPad (as described publicly) | Kingnode Lab |
|---|---|---|
| Research model | model writes Python, runs it | deterministic spec engine; model builds the spec and explains |
| Reproducibility | depends on generated code | the same spec → the same result, saved with the data version |
| Failure mode | credits burn on failed runs | nothing to burn; a bad spec is an error message |
| Data depth | bundled datasets (depth unverified here) | 10 years daily for ~210 names, 1 year for 5,000+; no intraday, no historical options |
| Positioning features | none known | walls, flip, gamma regime per name per day (young: since 2026-10-15) |
| Validation | not described in reviews | built in: intervals, base rates, walk-forward, Monte Carlo, variant counting |
| Options research | unknown | live delayed chain only; no historical options backtests (flagged, not faked) |
| Fundamentals / macro | unknown | macro readings and calendar; no financial statements |
| Price | $169.99/month public | $0 (static hosting) + the user's own Anthropic usage for Ava |
| Where it runs | their servers | your browser (and your Railway server if you want) |

Where Kingnode is behind: free-form Python research, machine learning, intraday and options history, breadth of asset classes.
Where it is ahead, measurably: cost, reproducibility, positioning data, and the honesty layer. No claim of overall superiority is
made; the benchmark table above is what can be verified today.

## 4. Roadmap

| Milestone | Scope | Acceptance |
|---|---|---|
| **1 — Research foundation** (done, v51) | history job, engine, Lab tab, journal, Ava tools, tests | 50 tests green; a real question runs end to end on feed data and is saved |
| 2 — Journal depth | tags/projects, notebook-style notes with embedded results, Ava retrieving "my NVDA thesis from last month" across entries, export to PDF | search by tag; Ava answers a journal question with citations to entries |
| 3 — Wider data | ten-year history for every optionable name in weekly batches (≈ 800 MB on the data branch — needs a size decision), FRED series as features (rates, CPI) once a key is set, breadth history as a feature | a macro-conditioned study runs ("momentum when CPI > 4%") |
| 4 — Positioning-conditioned research | levels history ≥ 6 months → the put-wall template and regime filters have a sample; closing-read grades and anomaly grades as features | ≥ 100 events in a positioning study |
| 5 — Options research | historical options data is the gate: ORATS/Polygon options history ($200–300/month) or a cheaper end-of-day source; then vertical/straddle backtests with real prices, never derived from stock moves | an options backtest cites its data source and spread assumptions |
| 6 — Code mode | Pyodide (Python in the browser) with pandas/numpy, the Lab's data frames pre-loaded, no network; Ava writes Python only here, results shown next to the spec engine's | a notebook cell runs offline in the browser with resource limits |
| 7 — Automation | scheduled reruns of journal entries after each close, drift alerts ("the strategy's last 10 trades fell outside its historical range") | an alert fires from a rerun |

## 5. Costs (monthly, honest)

| Item | Mandatory | Cost |
|---|---|---|
| Hosting (GitHub Pages + Actions feed) | yes | $0 on the free tier |
| Ava (Anthropic API, user's key) | for Ava only | cents per conversation; a heavy research day ~$1–3 |
| Railway server (optional, for Ava's key on the server and same-origin data) | no | ~$5–10 |
| Real-time quotes/chain (Tradier) | no | $10 |
| Historical options data (ORATS, Polygon options) | only for options backtests | $200–300 |
| Intraday history (Polygon/Massive stocks) | only for intraday research | $99–199 |
| FRED | no | free with a key |

Total for everything the Lab does today: **$0 plus Ava's usage.**

## 6. Limits stated plainly

- Daily bars only; no intraday backtests. Yahoo's adjusted history is good but not audited; splits and dividends are applied as
  Yahoo reports them.
- The universe is today's list of names (survivorship) — the validator says so on every run.
- Positioning features exist only since the feed began recording levels (2026-10-15); studies on them are tiny for now.
- No historical options prices, so no options backtests — the Lab refuses to manufacture them from stock moves.
- The research journal lives in the browser; export it or keep backups on.
