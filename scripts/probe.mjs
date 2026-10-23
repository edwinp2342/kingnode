// One-off reachability probe for data sources the feed might use. Writes probe/probe.json to the `probe` branch.
// Run it with the probe workflow (workflow_dispatch); edit the targets below for whatever question is open.
// Current question (Oct 22 2026, 23:30 ET): who carries overnight (20:00–04:00 ET) prices for US stocks, and what does Yahoo return after 20:00?
import fs from "node:fs"; import { execSync } from "node:child_process";
const UA = "Mozilla/5.0 (Kingnode feed; +https://github.com/edwinp2342/kingnode)";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const targets = {
  yahooChart1m: "https://query1.finance.yahoo.com/v8/finance/chart/NVDA?interval=1m&range=1d&includePrePost=true",
  yahooChart1m2d: "https://query2.finance.yahoo.com/v8/finance/chart/NVDA?interval=1m&range=2d&includePrePost=true",
  yahooSpark: "https://query1.finance.yahoo.com/v7/finance/spark?symbols=NVDA,AAPL&range=1d&interval=1m&includePrePost=true",
  yahooQuoteV7: "https://query1.finance.yahoo.com/v7/finance/quote?symbols=NVDA,AAPL",
  yahooQuoteV6: "https://query1.finance.yahoo.com/v6/finance/quote?symbols=NVDA,AAPL",
  yahooQuoteType: "https://query1.finance.yahoo.com/v1/finance/quoteType/?symbol=NVDA",
  webullSearch: "https://quotes-gw.webullfintech.com/api/search/pc/tickers?keyword=NVDA&pageIndex=1&pageSize=3&regionId=6",
  webullQuote: "https://quotes-gw.webullfintech.com/api/quote/tickerRealTimes/v5/?tickerIds=913257561&includeSecu=1&delay=0&more=1",
  webullBatch: "https://quotes-gw.webullfintech.com/api/bgw/quote/realtime?ids=913257561,913256135&includeSecu=1&delay=0&more=1",
  stocktwitsQL: "https://ql.stocktwits.com/batch?symbols=NVDA,AAPL",
  stocktwitsQuote: "https://api.stocktwits.com/api/2/symbols/NVDA/quote.json",
  cnbcQuote: "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=NVDA|AAPL&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json",
  robinhoodQuote: "https://api.robinhood.com/quotes/?symbols=NVDA",
  robinhoodMarketdata: "https://api.robinhood.com/marketdata/quotes/NVDA/?bounds=24_7",
  nasdaqExtended: "https://api.nasdaq.com/api/quote/NVDA/extended-trading?assetclass=stocks&markettype=post",
  nasdaqInfo: "https://api.nasdaq.com/api/quote/NVDA/info?assetclass=stocks",
  finnhubQuote: "https://finnhub.io/api/v1/quote?symbol=NVDA",
  twelveData: "https://api.twelvedata.com/price?symbol=NVDA",
  alpacaLatest: "https://data.alpaca.markets/v2/stocks/NVDA/trades/latest?feed=iex",
  googleFinance: "https://www.google.com/finance/quote/NVDA:NASDAQ",
  investingOvernight: "https://www.investing.com/equities/nvidia-corp",
  marketwatch: "https://www.marketwatch.com/investing/stock/nvda",
  tradingviewScan: "https://scanner.tradingview.com/america/scan",
  cboeBook: "https://www.cboe.com/json/bzx/book/NVDA",
  cboeDelayedQuote: "https://cdn.cboe.com/api/global/delayed_quotes/quotes/NVDA.json",
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
      if (k.startsWith("yahooChart")) { const res0 = j.chart?.result?.[0]; const ts = res0?.timestamp || []; const m = res0?.meta || {}; sample = JSON.stringify({ metaKeys: Object.keys(m), ctp: m.currentTradingPeriod, tradingPeriodsKeys: m.tradingPeriods ? Object.keys(m.tradingPeriods) : null, nBars: ts.length, firstET: ts.length ? ET.format(new Date(ts[0] * 1000)) : null, lastET: ts.length ? ET.format(new Date(ts[ts.length - 1] * 1000)) : null, lastClose: res0?.indicators?.quote?.[0]?.close?.at(-1), regularMarketPrice: m.regularMarketPrice, regularMarketTime: m.regularMarketTime ? ET.format(new Date(m.regularMarketTime * 1000)) : null, postMarketPrice: m.postMarketPrice, postMarketTime: m.postMarketTime, hasPrePost: m.hasPrePostMarketData, marketState: m.marketState }); }
      else if (k === "yahooSpark") sample = JSON.stringify(j).slice(0, 600);
      else if (k.startsWith("webull")) sample = JSON.stringify(j).slice(0, 900);
      else if (k === "tradingviewScan") sample = JSON.stringify(j).slice(0, 900);
      else sample = JSON.stringify(j).slice(0, 600); } catch {}
    if (/google|investing|marketwatch/.test(k)) { const m = txt.match(/(After hours|Overnight|after-hours|overnight|Pre-market)[^<]{0,80}/i); sample = (m ? m[0] : "no overnight text") + " · " + txt.slice(0, 120).replace(/\s+/g, " "); }
    out.results[k] = { status: r.status, ms: Date.now() - t0, bytes: txt.length, headers: h, sample };
  } catch (e) { out.results[k] = { error: e.message, ms: Date.now() - t0 }; }
}
console.log(JSON.stringify(out, null, 1));
fs.mkdirSync("probe", { recursive: true }); fs.writeFileSync("probe/probe.json", JSON.stringify(out, null, 1));
execSync(`cd probe && git init -q -b probe && git config user.name kingnode-bot && git config user.email bot@users.noreply.github.com && git add -A && git commit -q -m probe && git push -q -f https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git probe:probe`, { stdio: "inherit" });
