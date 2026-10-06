// Snapshots the chains, bars and quotes the terminal needs and writes them to ./data as compact JSON, then pushes.
// Runs as a loop inside one GitHub Actions job (LOOP_MINUTES), so the feed refreshes about every minute for free:
//   quotes + bars (Yahoo, near real-time incl. pre/after-hours) every cycle; chains (Cboe, 15-min delayed) every 3rd cycle.
import { fetchChain, fetchBars } from "../api/_lib/data.js";
import fs from "node:fs";
import { execSync } from "node:child_process";

const SYMS = (process.env.SNAPSHOT_SYMBOLS || "SPX,SPY,QQQ,IWM,VIX,NDX,RUT,DIA,TLT,NVDA,TSLA,AAPL,AMZN,MSFT,META,GOOGL,AMD,TSM,GLD,SLV,COIN,PLTR,NFLX,XSP,AVGO,MU,ARM,MRVL,INTC,AMAT,LRCX,KLAC,SMH,XLE,XOM,FCX,CAT,CEG,VST,VRT,CRWD,PANW,ANET,ORCL,HOOD,MSTR,UBER,SHOP,LLY,UNH,JPM,BA,GE,DE,HYG,XLF,KRE,XBI,ARKK,IBIT,SOFI,RKLB,IONQ,APP,RDDT,OKLO,BABA,NIO,RIVN,MARA,DELL,ABNB,CMG,COST,WMT,HD,NKE").split(",").map(s => s.trim()).filter(Boolean);
// bars for a much wider list (cheap: one small Yahoo request each), so every ticker in the app has a chart
// every ticker the app knows: its built-in search universe + halal list + the extra list below
const appHtml = fs.readFileSync(new URL("../app.html", import.meta.url), "utf8");
const fromApp = [...appHtml.matchAll(/\["([A-Z.]{1,6})","[^"]+"\]/g)].map(m => m[1]);
const BAR_SYMS = [...new Set([...SYMS, ...fromApp, ...(process.env.BAR_SYMBOLS || "AVGO,QCOM,TXN,MU,ARM,ASML,AMAT,LRCX,KLAC,INTC,MRVL,ADBE,CRM,ORCL,NOW,CRWD,PANW,NET,DDOG,SNOW,ANET,CSCO,SHOP,ABNB,UBER,LLY,NVO,ISRG,JNJ,MRK,ABBV,AMGN,GILD,PFE,TEM,HIMS,XOM,CVX,COP,OXY,SLB,XLE,XOP,FCX,NEM,CAT,DE,GE,UPS,FDX,VRT,CEG,VST,ENPH,FSLR,PG,COST,WMT,HD,LOW,NKE,LULU,TJX,CMG,ELF,CELH,KO,PEP,RKLB,ASTS,IONQ,RGTI,APP,RDDT,DUOL,SPOT,DIS,JPM,BAC,GS,V,MA,HOOD,DKNG,BA,T,VZ,F,GM,CCL,LMT,RTX,SMH,XLF,KRE,XBI,XLK,XLV,XLI,XLU,XLP,XLY,ARKK,HYG,EEM,FXI,BITO,IBIT,UVXY,SQQQ,TQQQ,SOXL,UUP,SPUS,HLAL,SPSK,MSTR,SOFI,SQ,PYPL,AFRM,RBLX,DELL,HPQ,IBM,ADP,INTU,WDAY,TEAM,OKTA,ZS,MDB,ZM,TTD,ROKU,MELI,SE,BABA,PDD,JD,NIO,RIVN,LCID,MARA,RIOT,CLSK,OKLO,SMR,LUNR,NRG,CAVA,CRCL,CRWV,NBIS,SBET,MRNA,CVS,BMY,DAL,UAL,AAL,LUV,RCL,MAR,TGT,ISRG").split(",").map(s=>s.trim()).filter(Boolean)])];
const TAPE = ["SPX","NDX","RUT","VIX","SPY","QQQ","IWM","DIA"];
const YAHOO = { SPX:"^GSPC", NDX:"^NDX", RUT:"^RUT", VIX:"^VIX", DJX:"^DJI", XSP:"^GSPC" };
const LOOP_MIN = Number(process.env.LOOP_MINUTES || 0), EVERY = Number(process.env.EVERY_SEC || 60), PUSH = process.env.PUSH === "1";
fs.mkdirSync("data", { recursive: true });

async function quote(sym) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO[sym] || sym)}?interval=1m&range=1d&includePrePost=true`, { headers: { "user-agent": "Mozilla/5.0 (Kingnode)" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("http " + r.status);
  const j = await r.json(), res0 = j.chart?.result?.[0], m = res0?.meta; if (!m) throw new Error("no meta");
  const q = res0.indicators?.quote?.[0], closes = (q?.close || []), ts = res0.timestamp || [];
  let last = +m.regularMarketPrice || 0, lastT = (m.regularMarketTime || 0) * 1000;
  for (let i = closes.length - 1; i >= 0; i--) if (closes[i] != null) { last = closes[i]; lastT = ts[i] * 1000; break; }
  const price = +m.regularMarketPrice || last, prev = +(m.chartPreviousClose ?? m.previousClose ?? price);
  const div = sym === "XSP" ? 10 : 1;
  return { symbol: sym, price: price / div, prev: prev / div, last: last / div, state: m.marketState || null, t: lastT, regT: (m.regularMarketTime || 0) * 1000 };
}
async function cycle(n) {
  const t0 = Date.now(); const ok = [], fail = [];
  // quotes for the tape (fast, near real-time, extended hours)
  const quotes = [];
  for (const sym of TAPE) { try { quotes.push(await quote(sym)); } catch (e) { fail.push(`q:${sym}:${e.message}`); } }
  const spx = quotes.find(q => q.symbol === "SPX"); if (spx) quotes.push({ ...spx, symbol: "XSP", price: spx.price / 10, prev: spx.prev / 10, last: spx.last / 10 });
  fs.writeFileSync("data/quotes.json", JSON.stringify({ at: Date.now(), quotes }));
  // bars for every symbol (Yahoo, extended) every cycle; chains every 3rd cycle (they're big and 15-min delayed anyway)
  // bars for every ticker in the app, 8 at a time
  for (let i = 0; i < BAR_SYMS.length; i += 8) {
    await Promise.all(BAR_SYMS.slice(i, i + 8).map(async sym => {
      try { const b = await fetchBars(sym, "5m", "5d", true); fs.writeFileSync(`data/${sym}-bars.json`, JSON.stringify({ ...b, bars: b.bars.slice(-800), snapshotAt: Date.now() })); } catch (e) { fail.push(`b:${sym}`); }
      if (n % 9 === 0) { try { const d = await fetchBars(sym, "1d", "1y", false); fs.writeFileSync(`data/${sym}-daily.json`, JSON.stringify({ ...d, bars: d.bars.slice(-300), snapshotAt: Date.now() })); } catch {} }
    }));
  }
  for (const sym of SYMS) {
    if (n % 3 === 0) {
      try {
        const c = await fetchChain(sym);
        const exps = [...new Set(c.rows.map(r => r[0]))].sort().slice(0, 8), keep = new Set(exps);
        const rows = c.rows.filter(r => keep.has(r[0]) && Math.abs(r[2] / c.spot - 1) <= 0.15).map(r => r.map((v, i) => typeof v === "number" && i >= 3 ? +v.toPrecision(6) : v));
        fs.writeFileSync(`data/${sym}.json`, JSON.stringify({ ...c, rows, snapshotAt: Date.now() })); ok.push(sym);
      } catch (e) { fail.push(`c:${sym}:${e.message}`); }
    }
  }
  fs.writeFileSync("data/index.json", JSON.stringify({ at: Date.now(), cycle: n, ok, fail }));
  await watchdog(n, ok, fail);
  console.log(`cycle ${n} · ${((Date.now() - t0) / 1000).toFixed(1)}s · quotes ${quotes.length} · chains ${ok.length}${fail.length ? " · fail " + fail.join(" ") : ""}`);
  if (PUSH) push();
}
let badStreak = 0;
async function watchdog(n, ok, fail) {
  const hook = process.env.DISCORD_WEBHOOK; const chainCycle = n % 3 === 0;
  const spxDown = chainCycle && !ok.includes("SPX"); const manyFails = fail.length > 12;
  if (spxDown || manyFails) badStreak++; else badStreak = 0;
  if (badStreak === 2 && hook) { try { await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `⚠️ Kingnode feed: ${spxDown ? "SPX chain failed twice in a row" : fail.length + " fetch failures"} (cycle ${n}). ${fail.slice(0, 6).join(" ")}` }) }); } catch {} }
}
function push() {
  try {
    execSync(`cd data && ([ -d .git ] || git init -q -b data) && git config user.name kingnode-bot && git config user.email bot@users.noreply.github.com && git add -A && git commit -qm "snapshot $(date -u +%FT%TZ)" >/dev/null 2>&1; git push -q --force "https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git" data`, { stdio: "inherit", shell: "/bin/bash", timeout: 90000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  } catch (e) { console.error("push failed", e.message); }
}
const end = Date.now() + LOOP_MIN * 60e3; let n = 0;
do { await cycle(n++); if (LOOP_MIN) { const wait = Math.max(5, EVERY - 1) * 1000; await new Promise(r => setTimeout(r, wait)); } } while (Date.now() < end);
