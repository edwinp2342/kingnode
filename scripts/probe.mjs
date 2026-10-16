// One-off reachability probe for data sources the feed might use. Writes probe/probe.json to the `probe` branch.
import fs from "node:fs"; import { execSync } from "node:child_process";
const UA = "Mozilla/5.0 (Kingnode feed; +https://github.com/edwinp2342/kingnode)";
const targets = {
  cboeChain: "https://cdn.cboe.com/api/global/delayed_quotes/options/HOOD.json",
  cboeDir: "https://www.cboe.com/us/options/symboldir/equity_index_options/?download=csv",
  nasdaqScreener: "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25&offset=0&download=true",
  nasdaqIpo: "https://api.nasdaq.com/api/ipo/calendar?date=2026-10",
  secTickers: "https://www.sec.gov/files/company_tickers.json",
  yahooQuoteBatch: "https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL,MSFT,HOOD",
  yahooChart: "https://query1.finance.yahoo.com/v8/finance/chart/HOOD?interval=1m&range=1d",
  nasdaqTraded: "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqtraded.txt",
};
const out = { at: new Date().toISOString(), results: {} };
for (const [k, u] of Object.entries(targets)) {
  const t0 = Date.now();
  try { const r = await fetch(u, { headers: { "user-agent": UA, accept: "application/json,text/plain,*/*", origin: "https://edwinp2342.github.io" }, signal: AbortSignal.timeout(25000) });
    const txt = await r.text(); const h = {}; for (const key of ["access-control-allow-origin", "cache-control", "content-type", "content-length"]) h[key] = r.headers.get(key);
    let sample = txt.slice(0, 300); let rows = null;
    try { const j = JSON.parse(txt); if (k === "nasdaqScreener") { rows = j?.data?.rows?.length ?? j?.data?.table?.rows?.length ?? null; sample = JSON.stringify((j?.data?.rows || j?.data?.table?.rows || []).slice(0, 2)); } if (k === "nasdaqIpo") sample = JSON.stringify(j?.data?.priced?.rows?.slice(0, 2) || j?.data).slice(0, 400); if (k === "cboeChain") sample = JSON.stringify({ keys: Object.keys(j), n: j?.data?.options?.length }); if (k === "secTickers") sample = JSON.stringify(Object.values(j).slice(0, 2)); } catch {}
    if (k === "nasdaqTraded") rows = txt.split("\n").length;
    out.results[k] = { status: r.status, ms: Date.now() - t0, bytes: txt.length, headers: h, rows, sample };
  } catch (e) { out.results[k] = { error: e.message, ms: Date.now() - t0 }; }
}
console.log(JSON.stringify(out, null, 1));
fs.mkdirSync("probe", { recursive: true }); fs.writeFileSync("probe/probe.json", JSON.stringify(out, null, 1));
execSync(`cd probe && git init -q -b probe && git config user.name kingnode-bot && git config user.email bot@users.noreply.github.com && git add -A && git commit -q -m probe && git push -q -f https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git probe:probe`, { stdio: "inherit" });
