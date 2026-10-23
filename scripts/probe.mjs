// One-off reachability probe for data sources the feed might use. Writes probe/probe.json to the `probe` branch.
// Run it with the probe workflow (workflow_dispatch); edit the targets below for whatever question is open.
// Current question (Oct 22 2026, 23:30 ET): who carries overnight (20:00–04:00 ET) prices for US stocks, and what does Yahoo return after 20:00?
import fs from "node:fs"; import { execSync } from "node:child_process";
const UA = "Mozilla/5.0 (Kingnode feed; +https://github.com/edwinp2342/kingnode)";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const targets = {
  yahooNVDA: "https://query1.finance.yahoo.com/v8/finance/chart/NVDA?interval=1m&range=1d&includePrePost=true",
  yahooAAPL: "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1m&range=1d&includePrePost=true",
  yahooSPY: "https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1m&range=1d&includePrePost=true",
  yahooSPX: "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1m&range=1d&includePrePost=true",
  yahooSOFI: "https://query1.finance.yahoo.com/v8/finance/chart/SOFI?interval=1m&range=1d&includePrePost=true",
  yahooNVDA5d: "https://query1.finance.yahoo.com/v8/finance/chart/NVDA?interval=5m&range=5d&includePrePost=true",
  webullBatch: "https://quotes-gw.webullfintech.com/api/bgw/quote/realtime?ids=913257561,913256135&includeSecu=1&delay=0&more=1",
};
const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const out = { at: new Date().toISOString(), et: ET.format(new Date()), results: {} };
for (const [k, u] of Object.entries(targets)) {
  const t0 = Date.now();
  try {
    const opts = { headers: { "user-agent": /google|investing|marketwatch|webull|robinhood|nasdaq/.test(k) ? BROWSER_UA : UA, accept: "application/json,text/plain,*/*", "accept-language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(25000) };
    if (k === "tradingviewScan") { opts.method = "POST"; opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify({ symbols: { tickers: ["NASDAQ:NVDA", "NASDAQ:AAPL"] }, columns: ["close", "change", "premarket_close", "postmarket_close", "update_mode", "time", "overnight_close", "overnight_change", "premarket_change", "postmarket_change", "rtc", "rch", "rchp", "rtc_time"] }); }
    if (k === "webullQuote" || k === "webullBatch" || k === "webullSearch") { opts.headers.did = "kingnode0000000000000000000000000"; opts.headers["app"] = "global"; opts.headers["os"] = "web"; opts.headers["ver"] = "4.9.0"; opts.headers["platform"] = "web"; }
    const r = await fetch(u, opts);
    const txt = await r.text(); const h = {}; for (const key of ["access-control-allow-origin", "cache-control", "content-type", "content-length"]) h[key] = r.headers.get(key);
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
