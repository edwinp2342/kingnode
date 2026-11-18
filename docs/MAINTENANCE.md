# Maintenance log

A scheduled session runs every night at 12:00 AM ET: health checks on the feed and the app, the test suite, bug fixes, and at
most one small improvement from the backlog when everything is clean. Each run appends an entry here (newest first) and pushes.

## How a run works
1. `cd /home/claude/kingnode || git clone https://github.com/edwinp2342/kingnode /home/claude/kingnode`; `git pull --ff-only`; `npm install`.
2. `npm test` and `python3 test/smoke.py` — both must be green before anything else is touched.
3. Health, from the data branch (`https://raw.githubusercontent.com/edwinp2342/kingnode/data/…`, add `?x=<timestamp>` to dodge the CDN):
   `index.json` (fresh within the last 10 minutes during market hours, within a few hours otherwise; `status.*` sane),
   the feed workflow (`gh run list --workflow=data.yml --limit 3` — one run in progress, not failing in a loop),
   `close-read.json` (on a trading day: a 15:50/15:58 read exists, flow totals in the billions not trillions, an outcome after 16:03),
   `anomalies.json` (counts sane, no single symbol dominating), `hist/index.json` (coverage climbing toward the whole core list,
   no symbol older than 7 days), `macro.json` (readings dated this month or last), `breadth.json`, `scan.json` (rows for the chain list).
4. Fix what the checks and tests reveal. Small, safe, tested changes only: no architecture rewrites, keep the single-file app,
   keep tests green, add a test for every bug fixed.
5. When `app.html` changed: bump `KN_VERSION`, the `CACHE` name in `sw.js`, and "Personal build · vNN" in `index.html`;
   `node scripts/inline-lab.mjs` if `scripts/lab.mjs` changed. When feed code changed (`scripts/*.mjs` used by `snapshot.mjs`):
   cancel the in-progress feed run, wait for it to finish, redispatch
   (`gh api -X POST repos/edwinp2342/kingnode/actions/workflows/data.yml/dispatches -f ref=main -f 'inputs[loop_minutes]=330'`).
6. Commit with the attribution trailer, push `main`, republish the preview artifact when the app changed, append the entry below.

## Rules
- Never print, log, commit or paste a token or key. Keys live in ⚙ Settings in the browser or in Railway Variables.
- No live trading, no orders, no purchases, no changes to the other scheduled tasks.
- Prefer finishing one small thing over starting a big one. A risky or large change becomes a proposal in the Backlog, not a commit.
- Say plainly in the entry what was not checked or could not be verified.

## Backlog (pick at most one per clean night)
- Lab: ten-year history for the rest of the chain list once the data-branch size is settled (see docs/LAB.md milestone 3).
- Lab: tag/project field on journal entries and a filter chip row.
- Suspicious flow: per-sector roll-up (which sectors are drawing the money today).
- Macro tab: FRED series as Lab features once a FRED key is configured.
- Docs: keep README's feature list and test counts current.

## Entries

### 2026-11-18 — scheduled run 6
- Checked: 56 tests and smoke green before changes. Feed loop in progress on `da29dd6` (run 44210647051, overnight cadence, cycle 193, index.json
  under a minute old, fast 77/77 with 0 fails, sweep 5059/5059, 0 429s; `fail` carries only `b:ROKU`, the usual tier-B miss). close-read.json is
  Tuesday's 15:58 read (v2, $34.88B core total, $88.9B market, BALANCED grade D +9, outcome resolved at 16:03: SPY +0.18%); close-reads.json holds
  both 11-17 reads (15:50 D −1 and 15:58 D +9 — same call, so the 11-17 side-by-side block correctly stays hidden). anomalies.json dated 2026-11-17
  (2 A / 30 B / 8 C, BAC three times at most). hist 77/77, oldest 6.3 days — the weekly refresh (`maxAgeDays` 7, 40 per cycle) is due during
  11-18; check tomorrow that the oldest age fell. macro (EFFR 3.88% on 11-16, yields 4/4, BLS Oct, `yoy13` 4.08) ok. breadth `day: 2026-11-17`,
  66 points 09:34–16:00. scan 332 rows (core 77 + tier B 150 + extras); levels-history 24 session days, the 11-17 row has 15 columns for 374 symbols.
- Found: nothing broken. Took the backlog item "compare to buy-and-hold of the same names".
- Improved: `universeCurve()` / `curveSummary()` in scripts/lab.mjs — an equal slice of the capital in every name the strategy traded, bought at its
  first close in range (a slice sits in cash until its name prints), held to the end; `backtest()` returns `names` on the strategy's calendar and
  `metrics.names {totalReturn, cagr, maxDD, n}`. The KPI header's Total-return cell shows "SPY +6% · the 2 names held +4%", the split-chart note
  and a new "vs holding the same names" statistics line carry the CAGR and drawdown, and Ava's summary gets `sameNamesBuyAndHold`. New test in
  test/lab.test.mjs (pair that doubles/halves, a late name in cash, a name without bars left out of the split, the engine's curve equal to the
  helper's). App v54 (KN_VERSION, sw.js CACHE, index.html); README and docs/LAB.md test counts updated. Commit c8c89b2. Rendered the results card
  headlessly with synthetic bars: the new text appears, no page errors.
- State: 57 tests green, smoke clean; feed code unchanged, loop left running; preview artifact republished (version 25).
- Not verified: github.io (unreachable from here); the names line on a real ten-year run needs the browser with the data branch — covered by the unit
  test and the headless render only; the hist weekly refresh has not run yet tonight.

### 2026-11-17 — scheduled run 5
- Checked: 55 tests and smoke green before changes. Feed loop in progress on `adae753` (run 44007143054, overnight cadence, cycle 100, index.json
  1 min old, fast 77/77 with 0 fails, sweep 5055/5055, 0 429s; `fail` carries `b:ROKU` again plus two tier-B 429s — the overnight pace, transient).
  close-read.json is Monday's 15:58 read (v2, $34.86B core total, $90.2B market, outcome resolved at 16:03: SPY +0.1%, balanced/not judged).
  anomalies.json dated 2026-11-16 (3 A / 29 B / 8 C, no symbol more than twice). hist 77/77, oldest 5.3 days (weekly refresh due ~11-18). macro
  (EFFR 3.88% on 11-13, yields 4/4, BLS Oct, `yoy13` 4.08 from 2025-09) ok. breadth `day: 2026-11-16` with 70 points 09:34–16:05 — the Monday
  session reset works. scan 330 rows (core 77 + tier B 150 + Monday's extras). levels-history: the 11-16 row has 15 columns (cDeep/pDeep) for
  331 symbols and the `cols` header now lists 15 names — both items deferred from 11-14/11-16 are verified.
- Found: nothing broken. Took the backlog item "3:50 and 3:58 side by side": close-reads.json already holds both reads of a session.
- Improved: new `closeReadShift(first, last)` in app.html pairs the day's 15:50 read with the 15:58 when side or grade changed and lists each
  scored factor (core flow, whole market, indexes, breadth) that moved 5+ points, biggest first; the card shows the two reads as small cells with
  an arrow and a one-line "what moved" under them. Same call → nothing extra. New test in test/close-read.test.mjs (reads the function out of
  app.html through vm; the vm-realm arrays need `Array.from`/spread before deepEqual). App v53 (KN_VERSION, sw.js CACHE, index.html); README
  closing-read paragraph updated. Commit f25ec2a. Rendered the card headlessly with a synthetic 3:50 B(+42) → 3:58 D(+5) pair to check the layout.
- State: 56 tests green, smoke clean; feed code unchanged, so the loop was left running; preview artifact republished (version 24).
- Note for future runs: the clone sits on a detached HEAD after `git pull --ff-only origin main`, so `git push origin main` pushes the stale local
  branch and is rejected — `git branch -f main HEAD && git checkout main` first, then push.
- Not verified: github.io (unreachable from here); the side-by-side block needs a session where the 3:58 call differs from the 3:50 one to be seen
  live — covered by the unit test and the headless render only.

### 2026-11-16 — scheduled run 4
- Checked: 54 tests and smoke green before changes. Feed loop in progress on `b97aa15` (run 43795445951, overnight cadence, cycle 95, index.json
  1.3 min old, fast 77/77 with 0 fails, sweep 5057/5057, 0 429s; one tier-B bar miss `b:ROKU` this cycle, transient). close-read.json still Friday's
  15:58 read (v2, billions, outcome resolved) — no session since. anomalies.json dated 2026-11-13 (4 A / 26 B / 10 C, no symbol more than twice).
  hist 77/77, oldest 4.3 days; macro (EFFR 3.88% on 11-12, yields 4/4, BLS Oct) ok; breadth `day: 2026-11-13` with a one-point series — the 11-15
  session-keying fix holding over the weekend; scan 228 rows = core 77 + tier B 150 + 1; levels-history 22 session days, no weekend rows.
- Found: nothing broken. Took the CPI backlog item instead: CPI y/y showed a dash because BLS never published October 2025 CPI (shutdown gap) and
  the comparison is by exact calendar month.
- Improved: `blsSeriesToReadings()` keeps `yoy`/`coreYoy` null when the prior-year month is missing (a 13-month change is never passed off as y/y)
  and adds `yoy13`/`yoyFrom` (and `coreYoy13`/`coreYoyFrom`) from the month before; the Macro/Calendar readings line prints "CPI +4.1% over
  13 mo vs Sep 2025 … · prior-year month never published" and goes back to plain y/y on its own once the 2026-11 print lands. New test in
  test/macro.test.mjs; README line updated. App v52 (KN_VERSION, sw.js CACHE, index.html). Commit df79641.
- State: 55 tests green, smoke clean; feed redispatched (run 43808963701, loop_minutes 330) after cancelling 43795445951; verified on its first
  cycle: macro.json carries `yoy13: 4.08, yoyFrom: 2025-09` (core 2.87). Preview artifact republished (version 23).
- Not verified: github.io (unreachable from here); the levels-history 15-column row (cDeep/pDeep) and the Monday breadth-series reset still
  need a trading day — check the 11-16 row and breadth `day` tomorrow night. The levels-history `cols` header still reads 12 names until the
  open rewrites the file (the write path returns early while closed) — expected, not a bug.

### 2026-11-15 — scheduled run 3
- Checked: 53 tests and smoke green before changes. Feed loop in progress on `d836ff0` (run 43670840096, overnight cadence, index.json 3 min old,
  fast 77/77 with 0 fails, sweep 5057/5057, 0 429s; the "cancelled" runs before it are the designed 5.5-hour handoffs). close-read.json is
  still Friday's 15:58 read (v2, billions, outcome resolved) — no session since. anomalies.json dated 2026-11-13 (session-keyed, 4 A / 30 B / 6 C);
  COP is down from a 50×+ A surge to 4.2× with $305M of $324M set aside as deep-ITM — the 11-14 split is working on tier B too. hist 77/77,
  oldest 3.3 days; macro (EFFR 3.88% on 11-12, yields 4/4 with prev one session back, BLS Oct) ok; scan 228 rows = core 77 + tier B 150 + 1;
  levels-history 22 session days, no weekend rows.
- Found: breadth.json said `day: 2026-11-14` (a Saturday) with a 4-point flat series — the series was keyed by the ET calendar date, so weekend
  heartbeat sweeps formed a "day" of their own, and Monday's 00:00–09:30 sweeps of Friday's closes would have put ~57 flat points in front of
  the open, squeezing the real session into the right part of the breadth spark.
- Fixed: `computeBreadth()` keys the series by `sessionDate()` and records a point while the market trades plus one on the first sweep after
  the close (the 20-hour window is gone — a session's series now lives until the next open). New test/breadth.test.mjs. Commit 82c1bc0.
- State: 54 tests green, smoke clean; app unchanged (v51); feed redispatched (run 43680207318, loop_minutes 330) after cancelling 43670840096;
  verified on its first cycle: breadth.json now reads `day: 2026-11-13` with a one-point series.
- Not verified: github.io (unreachable from here); the levels-history 15-column row (cDeep/pDeep) still needs a trading day — check the 11-16 row
  tomorrow; the Monday-open series reset is covered by the unit test only. Backlog untouched.

### 2026-11-14 — scheduled run 2
- Checked: 51 tests and smoke green before changes. Feed loop in progress on `4caa3fd` (run 43549567265, overnight cadence, index.json 2 min old,
  sweep 5053/5053, 0 429s in the fast loop; tier-B chains hit 429 after 74 — expected at the overnight pace); close-read.json is Friday's 15:58 read
  in billions (v2: $6.68B net on $27.36B, grade B, outcome resolved 16:03, flat) — the trillions bug from 11-12 is confirmed fixed; macro (EFFR,
  yields 4/4 with prev now one session back, BLS) ok; breadth 1461/1287; scan 328 rows; hist 77/77, oldest 2.3 days.
- Found: anomalies.json graded XOM, COP, MMM, SO and BIL as A-grade premium surges (50–134× pace, 0% puts). All were the dividend-capture trade
  the day before an ex-dividend date — tens of thousands of |delta| ≥ 0.9 calls (XOM: 18k of the Nov-20 155C alone), a financing trade with no view.
- Fixed: the scan row now carries `cDeep`/`pDeep` (deep-ITM premium, via a new exported `chainPremium()`), the levels history records them at
  indexes 13/14, and surge, skew and the 20-day baselines measure the premium outside that bucket. Items keep the day's whole premium in `prem`
  and say how much was set aside (`deep`, and in the text when ≥ 25%). ANOMALIES_VERSION 2. Rows written before the split count whole, so
  baselines run a little high for up to 20 sessions — conservative. README updated. Commit 2eb5976.
- State: 53 tests green, smoke clean; app unchanged (v51). Feed redispatched (run 43561108504, loop_minutes 330) after cancelling 43549567265.
  Verified on the new run's first cycle: XOM's row shows cDeep $948M of $963M and XOM is off the anomaly list; COP/MMM/SO/BIL are tier-B rows
  still from the old build (tier B refreshes every 6 h while closed) and clear as those chains roll.
- Observed, not changed: CPI `yoy`/`coreYoy` are null because BLS never published October 2025 CPI (shutdown gap) and the comparison is by exact
  calendar month — correct behaviour, but the Macro tab shows no CPI yoy until the 2026-11 print. Backlog: consider a labelled 13-month fallback.
- Not verified: github.io (unreachable from here); the levels-history write path for cDeep/pDeep only runs on a trading day (Saturday tonight) —
  covered by the unit test, check the 11-16 row has 15 columns tomorrow.

### 2026-11-13 — scheduled run 1
- Checked: 50 tests and smoke green before changes. Feed loop in progress on `ad00524` (run 43356383650, overnight cadence, 0 fails,
  0 429s); index.json fresh; sweep 5056/5056; breadth, scan (351 rows), macro (BLS/NY Fed/yields ok) and hist (77/77, oldest 1.3 days) all
  sane; anomalies 14 A / 26 B, no symbol dominating. close-read.json still shows the 11-12 15:58 read in trillions (`v:1`): that read was
  produced before the 16:37 ET fix landed; Friday's read is the first on the fixed code — verify tomorrow night.
- Fixed: `levels-history.json` recorded a row under every calendar date, so each Saturday and Sunday (and any holiday) became a "session"
  duplicating Friday — tripling Fridays in the anomaly baselines and handing the expected-move scorecard and IV percentile free zero-move
  rows. New `sessionDate()` in market-clock.mjs; the levels history now writes only from the open through midnight ET of a trading day and
  purges the weekend rows it already holds; the anomaly pass keys, dates and baselines by session, so nothing re-fires as "new" at midnight.
- Fixed: macro yields' `*Prev` came from Yahoo's `chartPreviousClose` on a 5-day range — the close before the range, so a week's move read as a
  day's (10y 5.10 vs "prev" 4.86). Prev is now the bar before the last in the daily series.
- State: 51 tests green, smoke clean; app unchanged (v51); feed redispatched (run 43371067156, loop_minutes 330) and verified writing:
  the levels history dropped its 8 weekend rows (30 → 22 days), anomalies.json is dated 2026-11-12 with the old keys. The `2026-11-13` row
  the old build wrote at 00:11 ET still holds Thursday's chains until the open overwrites it. Commits 4639ab6, 1a1a359. Backlog untouched.
- Not verified: github.io (unreachable from here); live Yahoo responses (403 from this sandbox) — the yields fix is covered by the fake upstream only.

### 2026-11-12 — manual, before the first scheduled run
- Fixed: the closing read counted SPX/NDX pseudo-volume as dollar flow and reported trillions; indexes are now excluded and a
  test covers it (CLOSE_READ_VERSION 2). Feed redispatched.
- State: 50 tests green, smoke clean; app v51; feed loop running; ten-year history at 77+ symbols and climbing.
