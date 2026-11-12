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

## Entries

### 2026-11-12 — manual, before the first scheduled run
- Fixed: the closing read counted SPX/NDX pseudo-volume as dollar flow and reported trillions; indexes are now excluded and a
  test covers it (CLOSE_READ_VERSION 2). Feed redispatched.
- State: 50 tests green, smoke clean; app v51; feed loop running; ten-year history at 77+ symbols and climbing.
