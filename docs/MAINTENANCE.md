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
- Lab: a "compare to buy-and-hold of the same names" line in the KPI header.
- Closing read: show the 3:50 and 3:58 reads side by side on the card when they differ.
- Suspicious flow: per-sector roll-up (which sectors are drawing the money today).
- Macro tab: FRED series as Lab features once a FRED key is configured.
- Docs: keep README's feature list and test counts current.
- Macro: CPI yoy falls back to a labelled 13-month comparison when the prior-year month was never published (Oct 2025 shutdown gap).

## Entries

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
