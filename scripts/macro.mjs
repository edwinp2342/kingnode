// Macro readings and the release calendar for Ava and the Calendar tab — data/macro.json, refreshed hourly by the feed loop.
//
//   readings  BLS public API v1 (no key): CPI-U all items and core (SA) → month-over-month and year-over-year; unemployment rate; nonfarm
//             payrolls (level → monthly change); average hourly earnings YoY. NY Fed markets API: the effective fed funds rate, from which
//             the target range is inferred (EFFR always trades inside the 25 bp band). Yahoo: Treasury yields (^IRX 3-month, ^FVX 5-year,
//             ^TNX 10-year, ^TYX 30-year). Every reading carries its period and the date it was fetched; nothing is estimated.
//   calendar  data-static/macro-calendar.json — the publishers' own dates (BLS, BEA, FOMC), verified by hand — plus, when FRED_API_KEY is
//             set, the FRED release calendar for the next 60 days (fred/releases/dates), which keeps the schedule current without edits.
//
// Every source fails independently and says so in `sources`; the file is written with whatever came back.
import { readJSON, writeJSON } from "./market.mjs";

const UA = "Mozilla/5.0 (Kingnode feed; macro readings for a personal terminal)";
const BLS = { CUSR0000SA0: "cpi", CUSR0000SA0L1E: "cpiCore", LNS14000000: "unemployment", CES0000000001: "payrolls", CES0500000003: "hourlyEarnings" };
const FRED_IMPACT = [[/employment situation|consumer price index|fomc|personal income and outlays|gross domestic product/i, 3], [/producer price|retail|jolts|ism|consumer confidence|michigan|housing starts|existing home|new residential|durable goods|industrial production|trade/i, 2]];

export async function fetchMacro({ now = Date.now(), fredKey = process.env.FRED_API_KEY || "" } = {}) {
  const out = { at: now, sources: {}, data: {}, releases: [], fomc: [] };
  const cal = readJSON("data-static/macro-calendar.json", null);
  if (cal) { out.releases = (cal.releases || []).map(r => ({ ...r })); out.fomc = cal.fomc || []; out.calendarVerified = cal.verified || null; out.data.fedFunds = cal.fedFunds ? { range: cal.fedFunds.range, asOf: cal.fedFunds.asOf, src: "static" } : undefined; out.sources.calendar = `static · verified ${cal.verified}`; }
  await Promise.all([
    blsReadings(out).catch(e => { out.sources.bls = "error: " + e.message; }),
    effr(out).catch(e => { out.sources.nyfed = "error: " + e.message; }),
    yields(out).catch(e => { out.sources.yields = "error: " + e.message; }),
    fredKey ? fredReleases(out, fredKey, now).catch(e => { out.sources.fred = "error: " + e.message; }) : Promise.resolve(),
  ]);
  out.releases = dedupeReleases(out.releases).filter(r => r.date >= new Date(now - 2 * 86400e3).toISOString().slice(0, 10)).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return out;
}

// ---------- BLS: the index levels, turned into the numbers people quote ----------
export function blsSeriesToReadings(series, now = Date.now()) {
  const byId = {}; for (const s of series || []) byId[s.seriesID] = (s.data || []).filter(d => /^M(0[1-9]|1[0-2])$/.test(d.period)).map(d => ({ period: `${d.year}-${d.period.slice(1)}`, value: +d.value })).sort((a, b) => a.period.localeCompare(b.period));
  const data = {}; const periodMinus = (p, n) => { let [y, m] = p.split("-").map(Number); m -= n; while (m < 1) { m += 12; y--; } return `${y}-${String(m).padStart(2, "0")}`; }; const monthsBack = (arr, n) => { const want = periodMinus(arr[arr.length - 1].period, n); return arr.find(x => x.period === want) || null; }; // by calendar month, so a gap in the series never shifts the comparison
  const pctChange = (a, b) => a && b && b.value ? +((a.value / b.value - 1) * 100).toFixed(2) : null;
  const cpi = byId.CUSR0000SA0, core = byId.CUSR0000SA0L1E;
  if (cpi?.length) { const last = cpi.at(-1); data.cpi = { period: last.period, index: last.value, mom: pctChange(last, monthsBack(cpi, 1)), yoy: pctChange(last, monthsBack(cpi, 12)) }; if (core?.length) { const c = core.at(-1); data.cpi.coreMom = pctChange(c, monthsBack(core, 1)); data.cpi.coreYoy = pctChange(c, monthsBack(core, 12)); data.cpi.corePeriod = c.period; } }
  const un = byId.LNS14000000; if (un?.length) { const last = un.at(-1); data.unemployment = { period: last.period, rate: last.value, prior: monthsBack(un, 1)?.value ?? null }; }
  const pay = byId.CES0000000001; if (pay?.length) { const last = pay.at(-1), prev = monthsBack(pay, 1), prev2 = monthsBack(pay, 2); data.payrolls = { period: last.period, level: last.value, change: prev ? Math.round(last.value - prev.value) : null, priorChange: prev && prev2 ? Math.round(prev.value - prev2.value) : null, unit: "thousands" }; }
  const ahe = byId.CES0500000003; if (ahe?.length) { const last = ahe.at(-1); data.hourlyEarnings = { period: last.period, level: last.value, yoy: pctChange(last, monthsBack(ahe, 12)), mom: pctChange(last, monthsBack(ahe, 1)) }; }
  for (const k of Object.keys(data)) data[k].src = "bls"; data.asOf = new Date(now).toISOString();
  return data;
}
async function blsReadings(out) {
  const y = new Date().getUTCFullYear();
  const r = await fetch("https://api.bls.gov/publicAPI/v1/timeseries/data/", { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify({ seriesid: Object.keys(BLS), startyear: String(y - 1), endyear: String(y) }), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("http " + r.status);
  const j = await r.json(); if (j.status !== "REQUEST_SUCCEEDED") throw new Error((j.message || []).join("; ") || j.status);
  const data = blsSeriesToReadings(j.Results?.series, out.at); Object.assign(out.data, data); out.sources.bls = `ok · ${Object.keys(data).filter(k => k !== "asOf").join(", ")}`;
}

// ---------- NY Fed: the effective rate; the target range is the 25 bp band it sits in ----------
export function targetRangeFromEffr(rate) { if (!(rate > 0)) return null; const lo = Math.floor(rate * 4) / 4; return `${lo.toFixed(2)}–${(lo + 0.25).toFixed(2)}%`; }
async function effr(out) {
  const r = await fetch("https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("http " + r.status);
  const j = await r.json(); const row = (j.refRates || [])[0]; if (!row) throw new Error("no rate");
  const rate = +row.percentRate; out.data.effr = { date: row.effectiveDate, rate, src: "nyfed" };
  out.data.fedFunds = { range: targetRangeFromEffr(rate), asOf: row.effectiveDate, src: "inferred from EFFR" }; out.sources.nyfed = `ok · EFFR ${rate}% on ${row.effectiveDate}`;
}

// ---------- Treasury yields from Yahoo's index quotes ----------
async function yields(out) {
  const map = { "^IRX": "t3m", "^FVX": "t5y", "^TNX": "t10y", "^TYX": "t30y" }; const y = {}; let okN = 0;
  await Promise.all(Object.entries(map).map(async ([sym, key]) => { try { const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(12000) }); if (!r.ok) throw new Error("http " + r.status); const j = await r.json(); const m = j.chart?.result?.[0]?.meta; const v = +m?.regularMarketPrice; if (v > 0) { y[key] = +v.toFixed(3); y[key + "Prev"] = +(+m.chartPreviousClose || +m.previousClose || 0).toFixed(3) || null; okN++; } } catch {} }));
  if (!okN) throw new Error("no yields"); y.asOf = new Date(out.at).toISOString(); y.src = "yahoo"; out.data.yields = y; out.sources.yields = `ok · ${okN}/4`;
}

// ---------- FRED release calendar (optional, with a key): the next 60 days of named releases ----------
export function fredDatesToReleases(j) {
  const out = []; for (const d of j?.release_dates || []) { const name = d.release_name || ""; if (!name || !d.date) continue; let impact = 1; for (const [re, n] of FRED_IMPACT) if (re.test(name)) { impact = n; break; } out.push({ date: d.date, time: "08:30", name, impact, src: "fred" }); }
  return out;
}
async function fredReleases(out, key, now) {
  const start = new Date(now).toISOString().slice(0, 10), end = new Date(now + 60 * 86400e3).toISOString().slice(0, 10);
  const r = await fetch(`https://api.stlouisfed.org/fred/releases/dates?api_key=${encodeURIComponent(key)}&file_type=json&include_release_dates_with_no_data=true&realtime_start=${start}&realtime_end=${end}&sort_order=asc&limit=1000`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("http " + r.status);
  const rel = fredDatesToReleases(await r.json()).filter(x => x.impact >= 2); out.releases.push(...rel); out.sources.fred = `ok · ${rel.length} releases`;
}
// the same release from two sources keeps the hand-verified line (it carries the time and the plain name)
export function dedupeReleases(list) {
  const key = r => r.date + "|" + r.name.toLowerCase().replace(/[^a-z]/g, "").slice(0, 12); const seen = new Map();
  for (const r of list) { const k = key(r); const cur = seen.get(k); if (!cur || (cur.src === "fred" && r.src !== "fred")) seen.set(k, r); }
  // a FRED line that names what a static line already covers on the same day (CPI, jobs, PCE, GDP, PPI, JOLTS)
  const byDate = {}; for (const r of seen.values()) (byDate[r.date] ||= []).push(r);
  const out = []; const topic = n => /consumer price|\bcpi\b/i.test(n) ? "cpi" : /employment situation|jobs report|nonfarm|payrolls/i.test(n) ? "jobs" : /personal income|\bpce\b/i.test(n) ? "pce" : /gross domestic|\bgdp\b/i.test(n) ? "gdp" : /producer price|\bppi\b/i.test(n) ? "ppi" : /jolts|job openings/i.test(n) ? "jolts" : /fomc/i.test(n) ? "fomc" : null;
  for (const rows of Object.values(byDate)) { const covered = new Set(rows.filter(r => r.src !== "fred").map(r => topic(r.name)).filter(Boolean)); for (const r of rows) { if (r.src === "fred" && covered.has(topic(r.name))) continue; out.push(r); } }
  return out;
}

export async function refreshMacro(path = "data/macro.json") { const doc = await fetchMacro(); writeJSON(path, doc); return doc; }

if (process.argv[1] && /macro\.mjs$/.test(process.argv[1])) { const doc = await refreshMacro(process.argv[2] || "data/macro.json"); console.log(JSON.stringify({ sources: doc.sources, data: doc.data, releases: doc.releases.length }, null, 1)); }
