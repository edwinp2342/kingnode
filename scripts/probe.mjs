// One-off reachability probe for data sources the feed might use. Writes probe/probe.json to the `probe` branch.
// Run it with the probe workflow (workflow_dispatch); edit the targets below for whatever question is open.
// Current question (Nov 23 2026, 00:20 ET): cdn.cboe.com has answered every chain request with http 403 since 2026-11-19 17:21 ET.
// Is it the feed's user agent ("Mozilla/5.0 (Kingnode)"), the missing browser headers, or the runner's IP? Same URL, different request shapes.
import fs from "node:fs"; import { execSync } from "node:child_process";
const UA = "Mozilla/5.0 (Kingnode feed; +https://github.com/edwinp2342/kingnode)";
const FEED_UA = "Mozilla/5.0 (Kingnode)";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const CHAIN = "https://cdn.cboe.com/api/global/delayed_quotes/options/SPY.json";
const BROWSER_HEADERS = { "user-agent": BROWSER_UA, accept: "application/json, text/plain, */*", "accept-language": "en-US,en;q=0.9", referer: "https://www.cboe.com/", origin: "https://www.cboe.com", "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-site" };
const targets = {
  cboeChainFeedUA: { url: CHAIN, headers: { "user-agent": FEED_UA } },
  cboeChainNoUA: { url: CHAIN, headers: { "user-agent": "" } },
  cboeChainCurlUA: { url: CHAIN, headers: { "user-agent": "curl/8.5.0" } },
  cboeChainBrowserUA: { url: CHAIN, headers: { "user-agent": BROWSER_UA } },
  cboeChainBrowserHeaders: { url: CHAIN, headers: BROWSER_HEADERS },
  cboeChainSPXBrowserHeaders: { url: "https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json", headers: BROWSER_HEADERS },
  cboeIntradayFeedUA: { url: "https://cdn.cboe.com/api/global/delayed_quotes/charts/intraday/SPY.json", headers: { "user-agent": FEED_UA } },
  cboeIntradayBrowserHeaders: { url: "https://cdn.cboe.com/api/global/delayed_quotes/charts/intraday/SPY.json", headers: BROWSER_HEADERS },
  cboeDirFeedUA: { url: "https://www.cboe.com/us/options/symboldir/equity_index_options/?download=csv", headers: { "user-agent": UA } },
  yahooSPY: { url: "https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1m&range=1d&includePrePost=true", headers: { "user-agent": UA } },
};
const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const out = { at: new Date().toISOString(), et: ET.format(new Date()), results: {} };
for (const [k, t] of Object.entries(targets)) {
  const u = t.url; const t0 = Date.now();
  try {
    const opts = { headers: { ...t.headers }, signal: AbortSignal.timeout(25000) };
    if (k === "tradingviewScan") { opts.method = "POST"; opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify({ symbols: { tickers: ["NASDAQ:NVDA", "NASDAQ:AAPL"] }, columns: ["close", "change", "premarket_close", "postmarket_close", "update_mode", "time", "overnight_close", "overnight_change", "premarket_change", "postmarket_change", "rtc", "rch", "rchp", "rtc_time"] }); }
    if (k === "webullQuote" || k === "webullBatch" || k === "webullSearch") { opts.headers.did = "kingnode0000000000000000000000000"; opts.headers["app"] = "global"; opts.headers["os"] = "web"; opts.headers["ver"] = "4.9.0"; opts.headers["platform"] = "web"; }
    const r = await fetch(u, opts);
    const txt = await r.text(); const h = {}; for (const key of ["access-control-allow-origin", "cache-control", "content-type", "content-length", "server", "cf-ray", "cf-mitigated", "x-cache", "x-served-by", "via", "x-akamai-request-id", "x-reference-error"]) h[key] = r.headers.get(key);
    let sample = txt.slice(0, 400);
    try { const j = JSON.parse(txt);
      if (k.startsWith("yahoo")) { const res0 = j.chart?.result?.[0]; const ts = res0?.timestamp || []; const m = res0?.meta || {}; sample = JSON.stringify({ metaKeys: Object.keys(m), ctp: m.currentTradingPeriod, tradingPeriodsKeys: m.tradingPeriods ? Object.keys(m.tradingPeriods) : null, nBars: ts.length, firstET: ts.length ? ET.format(new Date(ts[0] * 1000)) : null, lastET: ts.length ? ET.format(new Date(ts[ts.length - 1] * 1000)) : null, lastClose: res0?.indicators?.quote?.[0]?.close?.at(-1), regularMarketPrice: m.regularMarketPrice, fulldayPrice: m.fulldayPrice, fulldayChange: m.fulldayChange, fulldayChangePercent: m.fulldayChangePercent, chartPreviousClose: m.chartPreviousClose, previousClose: m.previousClose, tradingPeriods: m.tradingPeriods, regularMarketTime: m.regularMarketTime ? ET.format(new Date(m.regularMarketTime * 1000)) : null, postMarketPrice: m.postMarketPrice, postMarketTime: m.postMarketTime, hasPrePost: m.hasPrePostMarketData, marketState: m.marketState }); }
      else if (k === "yahooSpark") sample = JSON.stringify(j).slice(0, 600);
      else if (k.startsWith("webull")) sample = JSON.stringify(j).slice(0, 3000);
      else if (k === "tradingviewScan") sample = JSON.stringify(j).slice(0, 900);
      else sample = JSON.stringify(j).slice(0, 600); } catch {}
    if (/google|investing|marketwatch/.test(k)) { const m = txt.match(/(After hours|Overnight|after-hours|overnight|Pre-market)[^<]{0,80}/i); sample = (m ? m[0] : "no overnight text") + " · " + txt.slice(0, 120).replace(/\s+/g, " "); }
    out.results[k] = { status: r.status, ms: Date.now() - t0, bytes: txt.length, headers: h, sample };
  } catch (e) { out.results[k] = { error: e.message, ms: Date.now() - t0 }; }
}
console.log(JSON.stringify(out, null, 1));
fs.mkdirSync("probe", { recursive: true }); fs.writeFileSync("probe/probe.json", JSON.stringify(out, null, 1));
execSync(`cd probe && git init -q -b probe && git config user.name kingnode-bot && git config user.email bot@users.noreply.github.com && git add -A && git commit -q -m probe && git push -q -f https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git probe:probe`, { stdio: "inherit" });
