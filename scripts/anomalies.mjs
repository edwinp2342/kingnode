// Suspicious flow — what in today's options tape does not look like a normal day for that name.
//
// Works from the scan (every chain ticker: today's call/put premium, the biggest contracts with their aggressor side, vol/OI outliers) and
// the levels history (each name's daily premium for the last sessions), so "large" is always relative to the name's own baseline, paced
// for the time of day. Four kinds:
//   surge   today's premium, projected to the full session, is a multiple of the name's 20-day median
//   block   one contract carrying an outsized premium — fresh when its volume beats its open interest; the side says who paid: at the
//           ask (bought), at the bid (sold), or mid
//   skew    an unusual day that is also one-sided: ≥ 78% puts or ≥ 78% calls by premium
//   volOi   a contract trading many times its open interest (the scan's "unusual" row)
// Each item has a score 0–100 and a grade (A ≥ 78, B ≥ 62, C). Indexes and the big ETFs use higher dollar bars than single names.
// A block and a vol/OI outlier on the same contract are one observation (the block keeps it); a one-sided day on a name that already surged folds into the surge.
import { etNow } from "./market-clock.mjs";

export const ANOMALIES_VERSION = 1;
const INDEXISH = new Set(["SPX", "SPY", "QQQ", "IWM", "DIA", "VIX", "XSP", "NDX", "RUT", "TLT", "GLD", "HYG"]);
const money = v => { const a = Math.abs(v); return (v < 0 ? "−$" : "$") + (a >= 1e9 ? (a / 1e9).toFixed(2) + "B" : a >= 1e6 ? (a / 1e6).toFixed(1) + "M" : (a / 1e3).toFixed(0) + "k"); };
const fmtK = k => Number.isInteger(k) ? String(k) : String(+k.toFixed(2));
const sideWord = s => s === "A" ? "at the ask (bought)" : s === "B" ? "at the bid (sold)" : "near mid";
export const gradeOf = score => score >= 78 ? "A" : score >= 62 ? "B" : "C";

// each name's daily total premium for the sessions before today: median and a robust spread
export function baselines(history, today) {
  const out = {}; const days = Object.keys(history?.days || {}).filter(d => d < today).sort().slice(-20);
  for (const d of days) for (const [sym, row] of Object.entries(history.days[d] || {})) { const v = (row?.[10] || 0) + (row?.[11] || 0); if (v > 0) (out[sym] ||= []).push(v); }
  const res = {}; for (const [sym, vals] of Object.entries(out)) { if (vals.length < 5) continue; const s = [...vals].sort((a, b) => a - b); const med = s[Math.floor(s.length / 2)]; const mad = [...s.map(v => Math.abs(v - med))].sort((a, b) => a - b)[Math.floor(s.length / 2)] || med * 0.3; res[sym] = { median: med, mad, n: vals.length, max: s[s.length - 1] }; }
  return res;
}
// how much of the regular session has run, as a fraction (floor 0.12 so the first minutes do not project absurdly)
export function sessionFraction(etMin) { return Math.max(0.12, Math.min(1, (etMin - 570) / 390)); }

export function detectAnomalies({ scan, history, now = Date.now(), et = etNow(new Date(now)), log = null }) {
  const rows = scan?.rows || {}; const base = baselines(history, et.date); const frac = et.min >= 570 && et.min < 960 ? sessionFraction(et.min) : 1; const items = [];
  for (const [sym, r] of Object.entries(rows)) {
    if (!r || !(r.spot > 0)) continue; const idx = INDEXISH.has(sym); const total = (r.cPrem || 0) + (r.pPrem || 0); if (!(total > 0)) continue;
    const b = base[sym]; const paced = total / frac; const ratio = b ? paced / b.median : null; const z = b ? (paced - b.median) / Math.max(b.mad * 1.4826, b.median * 0.25) : null;
    const putShare = total > 0 ? (r.pPrem || 0) / total : 0.5; const side = putShare >= 0.65 ? "puts" : putShare <= 0.35 ? "calls" : "both";
    const levels = { cw: r.cw ?? null, pw: r.pw ?? null, flip: r.flip ?? null, em: r.em ?? null, iv30: r.iv30 ?? null };
    const common = { sym, idx, spot: r.spot, chg: r.chg ?? null, prem: Math.round(total), paced: Math.round(paced), baseline: b ? Math.round(b.median) : null, ratio: ratio != null ? +ratio.toFixed(2) : null, putShare: +putShare.toFixed(2), levels };
    // surge
    if (ratio != null && frac >= 0.15 && ratio >= 2.5 && paced >= (idx ? 5e7 : 3e6)) {
      const sizePts = paced >= 1e8 ? 20 : paced >= 3e7 ? 15 : paced >= 1e7 ? 10 : paced >= 5e6 ? 5 : 0; /* a multiple on a small name is not the same as a multiple on $50M */
      const score = Math.min(100, 35 + Math.min(40, 15 * (ratio - 2.5)) + sizePts + (z >= 6 ? 5 : 0)); items.push({ ...common, kind: "surge", side, score: Math.round(score), text: `${sym} · ${side} · premium ${ratio.toFixed(1)}× its 20-day pace (${money(paced)} projected vs ${money(b.median)} typical; ${Math.round(putShare * 100)}% puts) · spot ${fmtK(r.spot)}${r.chg != null ? ` (${r.chg >= 0 ? "+" : ""}${r.chg}%)` : ""}` });
    }
    // blocks: the biggest contracts (top) plus any the scan kept as big
    const cands = [...(r.top || []), ...(r.big || [])]; const seen = new Set();
    for (const c of cands) { const [exp, type, K, vol, oi, prem, s] = c; const key = `${exp}|${type}|${K}`; if (seen.has(key) || !(prem > 0)) continue; seen.add(key);
      const fresh = oi > 0 ? vol / oi : (vol > 0 ? 99 : 0); const bar = Math.max(idx ? 2.5e7 : 5e6, (b?.median || 0) * 0.02), bar2 = Math.max(idx ? 5e7 : 1e7, (b?.median || 0) * 0.05); // a block is big relative to the name: 2% of a normal day's premium when fresh, 5% regardless
      if ((prem >= bar && fresh >= 2) || prem >= bar2) { const score = Math.min(100, 50 + 10 * Math.log2(prem / bar) + (fresh >= 5 ? 10 : fresh >= 2 ? 5 : 0)); items.push({ ...common, kind: "block", side: type === "C" ? "calls" : "puts", aggr: s, contract: [exp, type, K, vol, oi, Math.round(prem), s], score: Math.round(score), text: `${sym} · ${type === "C" ? "calls" : "puts"} · ${money(prem)} in ${exp} ${fmtK(K)}${type} ${sideWord(s)} (vol ${vol.toLocaleString()} vs OI ${oi.toLocaleString()}${fresh >= 2 ? ", fresh" : ""}) · spot ${fmtK(r.spot)}${r.chg != null ? ` (${r.chg >= 0 ? "+" : ""}${r.chg}%)` : ""}` }); }
    }
    // skew
    if (ratio != null && frac >= 0.15 && ratio >= 1.5 && total >= (idx ? 3e7 : 5e6) && (putShare >= 0.78 || putShare <= 0.22)) items.push({ ...common, kind: "skew", side: putShare >= 0.78 ? "puts" : "calls", score: Math.round(Math.min(100, 45 + 10 * (ratio - 1.5))), text: `${sym} · ${putShare >= 0.78 ? "puts" : "calls"} · one-sided day: ${Math.round((putShare >= 0.78 ? putShare : 1 - putShare) * 100)}% of ${money(total)} premium on one side, ${ratio.toFixed(1)}× pace · spot ${fmtK(r.spot)}` });
    // vol/OI
    const u = r.unusual; if (u) { const [exp, type, K, vol, oi, s, volOi] = u; if (volOi >= 10 && vol >= 500) { const priced = cands.find(c => c[0] === exp && c[1] === type && c[2] === K); const prem = priced ? priced[5] : null; const bar2 = Math.max(idx ? 5e7 : 1e7, (b?.median || 0) * 0.05);
      const score = Math.min(100, 35 + Math.min(25, volOi / 2) + (vol >= 5000 ? 10 : vol >= 2000 ? 5 : 0) + (prem >= bar2 ? 20 : prem >= bar2 / 2 ? 10 : 0)); /* volume over open interest alone tops out at B; with real money behind it, A */
      items.push({ ...common, kind: "volOi", side: type === "C" ? "calls" : "puts", aggr: s, contract: [exp, type, K, vol, oi, prem != null ? Math.round(prem) : null, s], score: Math.round(score), text: `${sym} · ${type === "C" ? "calls" : "puts"} · ${exp} ${fmtK(K)}${type} traded ${vol.toLocaleString()} against ${oi.toLocaleString()} open (${volOi.toFixed(0)}× OI)${prem ? `, ${money(prem)}` : ""} ${sideWord(s)} · spot ${fmtK(r.spot)}` }); } }
  }
  // one item per name and kind, best score first, capped
  const best = new Map(); for (const it of items) { const k = it.sym + "|" + it.kind; if (!best.has(k) || best.get(k).score < it.score) best.set(k, it); }
  for (const it of [...best.values()]) {
    if (it.kind === "volOi") { const blk = best.get(it.sym + "|block"); if (blk && blk.contract && it.contract && blk.contract[0] === it.contract[0] && blk.contract[1] === it.contract[1] && blk.contract[2] === it.contract[2]) { const mult = it.contract[4] > 0 ? it.contract[3] / it.contract[4] : null; blk.score = Math.min(100, blk.score + 5); if (mult) blk.text = blk.text.replace(/\)( · spot)/, `, ${mult.toFixed(0)}× OI)$1`); best.delete(it.sym + "|volOi"); } }
    if (it.kind === "skew") { const sg = best.get(it.sym + "|surge"); if (sg) { sg.score = Math.min(100, sg.score + 5); best.delete(it.sym + "|skew"); } }
  }
  const list = [...best.values()].map(it => ({ ...it, grade: gradeOf(it.score) })).sort((a, b) => b.score - a.score).slice(0, 40);
  // first-seen times from the log, so the app and Ava can say what is new
  const seenLog = { ...(log?.items || {}) }; const cutoff = now - 2 * 86400e3; for (const [k, t] of Object.entries(seenLog)) if (t < cutoff) delete seenLog[k];
  for (const it of list) { const k = `${et.date}|${it.sym}|${it.kind}|${it.contract ? it.contract.slice(0, 3).join("/") : ""}`; if (!seenLog[k]) seenLog[k] = now; it.firstSeen = seenLog[k]; it.key = k; }
  return { v: ANOMALIES_VERSION, at: now, date: et.date, frac: +frac.toFixed(2), n: list.length, counts: { A: list.filter(x => x.grade === "A").length, B: list.filter(x => x.grade === "B").length, C: list.filter(x => x.grade === "C").length }, items: list, log: { items: seenLog } };
}
