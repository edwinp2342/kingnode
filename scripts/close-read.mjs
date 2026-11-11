// The closing read — Kingnode's 3:50 PM call on which way the close is leaning, with a grade.
//
// The NYSE and Nasdaq publish their closing-auction imbalances (the real "MOC") at 3:50 and 3:55 through paid feeds; nothing free carries
// them. This is the honest substitute: everything measurable about the last half hour, combined into one side and one grade, and then
// scored against what the close actually did, so the grade earns or loses trust on its record.
//
//   flow     signed dollar volume over the last 30 minutes, 1-minute bars of the ~80 core names (SPY, QQQ, IWM, DIA and the big liquid names):
//            an up-bar's volume counts as buying, a down-bar's as selling  → net / total  (−1 … +1)
//   market   the whole optionable market from the 5-minute sweep: dollar volume in the last 30 minutes split by which way each name moved
//            between sweeps (5,000+ names)                                                              → net / total  (−1 … +1)
//   index    SPY, QQQ, IWM: above or below the day's VWAP, and the last 30 minutes' change
//   breadth  the share of up-dollar volume across the market right now, and its change over 30 minutes
//   pace     volume in the last 10 minutes against the day's per-minute average — the auction's size is not visible, but its footprint is
//   gamma    SPX against its flip and walls: positive gamma near a wall pins (damped), negative gamma trends (amplified)
//
// score = 0.35·flow + 0.25·market + 0.20·index + 0.20·breadth, × pace multiplier, × pin damping  →  −100 … +100
// side  = BUY (> +15) · SELL (< −15) · BALANCED;   grade = A ≥ 60 · B ≥ 40 · C ≥ 20 · D below, on |score|
// resolve: SPY's move from the 3:50 print to the official close, and whether it went the graded way.

export const CLOSE_READ_VERSION = 1;
const INDEX_ETFS = ["SPY", "QQQ", "IWM", "DIA"];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v, d = 2) => v == null || !isFinite(v) ? null : +v.toFixed(d);

// Yahoo's 1-minute series sometimes stamps the day's cumulative volume into a random bar (a 200M-share minute in NVDA): any bar above 20×
// the day's median minute is capped at that, so one glitch cannot own the read
export function cleanBars(bars) {
  const vols = (bars || []).filter(b => b[5] > 0).map(b => b[5]).sort((a, b) => a - b); if (vols.length < 20) return bars || [];
  const med = vols[Math.floor(vols.length / 2)], cap = med * 20; return bars.map(b => b[5] > cap ? [b[0], b[1], b[2], b[3], b[4], cap] : b);
}
// signed dollar volume for 1-minute bars inside [fromT, toT)
export function signedFlow(bars, fromT, toT) {
  let up = 0, dn = 0, vol = 0, n = 0, prevClose = null;
  for (const b of bars || []) {
    const [t, o, , , c, v] = b; if (!(v > 0)) { prevClose = c; continue; }
    if (t < fromT || t >= toT) { if (t < fromT) prevClose = c; continue; }
    const dir = c > o ? 1 : c < o ? -1 : prevClose != null ? Math.sign(c - prevClose) : 0; const $ = v * c;
    if (dir > 0) up += $; else if (dir < 0) dn += $; else { up += $ / 2; dn += $ / 2; }
    vol += v; n++; prevClose = c;
  }
  const total = up + dn; return { up, dn, net: up - dn, total, ratio: total > 0 ? (up - dn) / total : 0, vol, n };
}
// the day's VWAP from 1-minute bars with volume, on or after dayStartT
export function vwap(bars, dayStartT) { let pv = 0, v = 0; for (const b of bars || []) { if (b[0] < dayStartT || !(b[5] > 0)) continue; pv += b[4] * b[5]; v += b[5]; } return v > 0 ? pv / v : null; }
const priceAt = (bars, t) => { let px = null; for (const b of bars || []) { if (b[0] <= t && b[5] > 0) px = b[4]; else if (b[0] > t) break; } return px; };
const lastPrice = bars => { for (let i = (bars || []).length - 1; i >= 0; i--) if (bars[i][5] > 0) return bars[i][4]; return null; };

// one sweep against the previous: market-wide dollar volume by direction. q: {sym: [last, prevClose, chgPct, volume, lastT, state, avgVol20, fullPrice]}
export function sweepDelta(prevQ, q, at) {
  let up = 0, dn = 0, vol = 0, n = 0;
  for (const [sym, row] of Object.entries(q || {})) { const p = prevQ?.[sym]; if (!p || !row) continue; const dv = (row[3] || 0) - (p[3] || 0); if (!(dv > 0) || !(row[0] > 0)) continue; const $ = dv * row[0]; const dir = Math.sign(row[0] - p[0]); if (dir > 0) up += $; else if (dir < 0) dn += $; else { up += $ / 2; dn += $ / 2; } vol += dv; n++; }
  return { at, up, dn, net: up - dn, total: up + dn, vol, n };
}

export function gradeOf(score) { const a = Math.abs(score); return a >= 60 ? "A" : a >= 40 ? "B" : a >= 20 ? "C" : "D"; }
export function sideOf(score) { return score > 15 ? "BUY" : score < -15 ? "SELL" : "BALANCED"; }

// the read itself. bars1m: {sym: bars}; quotes: {sym: {price, prev}}; breadth: data/breadth.json; sweeps: sweepDelta() results (oldest first); scan: scan.json rows
export function computeCloseRead({ now = Date.now(), et, bars1m = {}, quotes = {}, breadth = null, sweeps = [], scan = null, label = "15:50" }) {
  const win = 30 * 60e3, from = now - win; const dayStart = now - ((et?.min ?? 950) - 570) * 60e3; // 09:30 ET today
  bars1m = Object.fromEntries(Object.entries(bars1m).map(([s, b]) => [s, cleanBars((b || []).filter(x => x[0] < now))]));
  // 1. flow: the core names, 1-minute bars
  let fUp = 0, fDn = 0, fVol = 0; const perName = [];
  for (const [sym, bars] of Object.entries(bars1m)) { const f = signedFlow(bars, from, now); if (!f.total) continue; fUp += f.up; fDn += f.dn; fVol += f.vol; perName.push({ sym, net: f.net, total: f.total }); }
  const flowRatio = fUp + fDn > 0 ? (fUp - fDn) / (fUp + fDn) : 0; const flowScore = clamp(flowRatio * 250, -100, 100);
  perName.sort((a, b) => b.net - a.net); const leaders = perName.slice(0, 5).filter(x => x.net > 0), laggards = perName.slice(-5).reverse().filter(x => x.net < 0);
  // 2. market: the sweeps inside the window
  const sw = (sweeps || []).filter(s => s.at >= from - 5 * 60e3 && s.at <= now + 60e3); let mUp = 0, mDn = 0, mN = 0; for (const s of sw) { mUp += s.up; mDn += s.dn; mN = Math.max(mN, s.n); }
  const marketRatio = mUp + mDn > 0 ? (mUp - mDn) / (mUp + mDn) : null; const marketScore = marketRatio == null ? null : clamp(marketRatio * 250, -100, 100);
  // 3. index ETFs against VWAP and 30 minutes ago
  const idx = {}; let iSum = 0, iN = 0;
  for (const sym of ["SPY", "QQQ", "IWM"]) { const bars = bars1m[sym]; if (!bars?.length) continue; const px = lastPrice(bars), vw = vwap(bars, dayStart), p30 = priceAt(bars, from); if (!(px > 0)) continue;
    const vsVwap = vw ? (px / vw - 1) * 100 : null, vs30 = p30 ? (px / p30 - 1) * 100 : null; const s = clamp((vsVwap ?? 0) * 100 + (vs30 ?? 0) * 150, -100, 100); idx[sym] = { px: round(px), vwap: round(vw), vsVwapPct: round(vsVwap), vs30Pct: round(vs30), score: round(s, 0) }; iSum += s; iN++; }
  const indexScore = iN ? iSum / iN : null;
  // 4. breadth: up-dollar share now and 30 minutes ago (series rows: t adv dec above50pct upDollarPct)
  let breadthScore = null, br = null;
  if (breadth?.series?.length) { const rows = breadth.series.filter(r => r[0] <= now + 60e3); const last = rows[rows.length - 1]; const ago = rows.filter(r => r[0] <= from).pop() || rows[0];
    if (last) { const upNow = last[4], upAgo = ago ? ago[4] : null; const advShare = last[1] + last[2] > 0 ? last[1] / (last[1] + last[2]) * 100 : null; breadthScore = clamp(clamp((upNow - 50) * 2.5, -50, 50) + (upAgo != null ? clamp((upNow - upAgo) * 15, -60, 60) : 0), -100, 100); /* the level is the day's story, the change is the last half hour's */ br = { upDollarPct: round(upNow, 1), upDollarPctAgo: round(upAgo, 1), advPct: round(advShare, 1), adv: last[1], dec: last[2], at: last[0] }; } }
  // 5. pace: last 10 minutes of core volume against the day's per-minute average
  let pace = null; { const mins = Math.max(1, (now - dayStart) / 60e3); const paces = []; for (const bars of Object.values(bars1m)) { let v10 = 0, vDay = 0; for (const b of bars || []) { if (b[0] < dayStart || !(b[5] > 0)) continue; vDay += b[5]; if (b[0] >= now - 10 * 60e3 && b[0] < now) v10 += b[5]; } if (vDay > 0) paces.push((v10 / 10) / (vDay / mins)); } if (paces.length) { paces.sort((a, b) => a - b); pace = paces[Math.floor(paces.length / 2)]; } } // the median name's pace: no single series can distort it
  const paceMult = pace == null ? 1 : clamp(1 + 0.25 * (pace - 1), 0.85, 1.35); // a heavy last ten minutes makes the lean more believable, a thin one less
  // 6. gamma: SPX from the scan
  let gamma = null, pinMult = 1; const spx = scan?.SPX; if (spx?.spot > 0) { const nearest = [spx.cw, spx.pw].filter(k => k > 0).map(k => ({ k, d: Math.abs(spx.spot - k) / spx.spot * 100 })).sort((a, b) => a.d - b.d)[0]; const positive = spx.flip > 0 ? spx.spot > spx.flip : (spx.gex || 0) > 0; const pinned = positive && nearest && nearest.d < 0.35; if (pinned) pinMult = 0.8; if (!positive) pinMult = 1.1;
    gamma = { regime: positive ? "positive" : "negative", flip: spx.flip, cw: spx.cw, pw: spx.pw, spot: spx.spot, nearestWall: nearest?.k ?? null, distPct: round(nearest?.d, 2), pinned: !!pinned }; }
  // composite: weights renormalized over the factors that exist
  const parts = [["flow", flowScore, 0.35], ["market", marketScore, 0.25], ["index", indexScore, 0.20], ["breadth", breadthScore, 0.20]].filter(p => p[1] != null); const wsum = parts.reduce((a, p) => a + p[2], 0) || 1;
  const raw = parts.reduce((a, p) => a + p[1] * p[2], 0) / wsum; const score = clamp(raw * paceMult * pinMult, -100, 100);
  const side = sideOf(score), grade = gradeOf(score);
  const read = { v: CLOSE_READ_VERSION, at: now, label, date: et?.date || null, side, grade, score: round(score, 0), confidence: round(Math.abs(score), 0),
    factors: { flow: { net: Math.round(fUp - fDn), total: Math.round(fUp + fDn), ratio: round(flowRatio, 3), names: perName.length, score: round(flowScore, 0) },
      market: marketRatio == null ? null : { net: Math.round(mUp - mDn), total: Math.round(mUp + mDn), ratio: round(marketRatio, 3), names: mN, sweeps: sw.length, score: round(marketScore, 0) },
      index: iN ? { ...idx, score: round(indexScore, 0) } : null, breadth: br ? { ...br, score: round(breadthScore, 0) } : null,
      pace: pace == null ? null : { x: round(pace, 2), mult: round(paceMult, 2) }, gamma },
    leaders: leaders.map(x => ({ sym: x.sym, net: Math.round(x.net) })), laggards: laggards.map(x => ({ sym: x.sym, net: Math.round(x.net) })),
    spy: { px: round(lastPrice(bars1m.SPY)), prev: quotes.SPY?.prev ?? null }, note: "a proxy built from flow, breadth and positioning — not the exchanges' auction imbalance feed" };
  read.text = closeReadText(read); return read;
}

const money = v => { const a = Math.abs(v); const s = a >= 1e9 ? (a / 1e9).toFixed(2) + "B" : a >= 1e6 ? (a / 1e6).toFixed(0) + "M" : (a / 1e3).toFixed(0) + "k"; return (v < 0 ? "−$" : "$") + s; };
export function closeReadText(r) {
  const f = r.factors; const bits = [];
  bits.push(`${r.side === "BALANCED" ? "Balanced" : r.side === "BUY" ? "Buy-side" : "Sell-side"} into the close · grade ${r.grade} (${r.score > 0 ? "+" : ""}${r.score}).`);
  if (f.flow?.total) bits.push(`Last 30 min across ${f.flow.names} core names: ${money(f.flow.net)} net ${f.flow.net >= 0 ? "buying" : "selling"} on ${money(f.flow.total)} traded (${(f.flow.ratio * 100).toFixed(0)}% skew).`);
  if (f.market?.total) bits.push(`Whole market (${f.market.names} names, ${f.market.sweeps} sweeps): ${money(f.market.net)} net, ${(f.market.ratio * 100).toFixed(0)}% skew.`);
  if (f.index?.SPY) { const s = f.index.SPY; bits.push(`SPY ${s.px} is ${s.vsVwapPct >= 0 ? "above" : "below"} VWAP (${s.vsVwapPct >= 0 ? "+" : ""}${s.vsVwapPct}%)${s.vs30Pct != null ? `, ${s.vs30Pct >= 0 ? "+" : ""}${s.vs30Pct}% in the last 30 min` : ""}.`); }
  if (f.breadth) bits.push(`Up-dollar share ${f.breadth.upDollarPct}%${f.breadth.upDollarPctAgo != null ? ` (${f.breadth.upDollarPctAgo}% half an hour ago)` : ""}, ${f.breadth.adv} up / ${f.breadth.dec} down.`);
  if (f.pace) bits.push(`Volume running ${f.pace.x}× the day's pace in the last 10 min${f.pace.x >= 1.5 ? " — a big auction footprint" : f.pace.x <= 0.7 ? " — thin" : ""}.`);
  if (f.gamma) bits.push(`SPX ${f.gamma.regime} gamma${f.gamma.pinned ? `, pinned near ${f.gamma.nearestWall} (damps the move)` : f.gamma.regime === "negative" ? " (trends into the bell)" : ""}.`);
  if (r.leaders?.length) bits.push(`Buying: ${r.leaders.map(x => x.sym).join(", ")}.`); if (r.laggards?.length) bits.push(`Selling: ${r.laggards.map(x => x.sym).join(", ")}.`);
  return bits.join(" ");
}

// after the bell: did SPY go the graded way from the 3:50 print to the official close?
export function resolveCloseRead(read, closePx) {
  if (!read || !(closePx > 0) || !(read.spy?.px > 0)) return null;
  const movePct = (closePx / read.spy.px - 1) * 100; const dir = movePct > 0.03 ? "up" : movePct < -0.03 ? "down" : "flat";
  const hit = read.side === "BALANCED" ? (dir === "flat" ? true : null) : read.side === "BUY" ? dir === "up" : dir === "down";
  return { close: round(closePx), movePct: round(movePct, 3), dir, hit, resolvedAt: Date.now() };
}
// the record the grade is judged on: hits per grade over the kept history (reads with hit === null are not counted)
export function closeReadRecord(history) {
  const out = {}; for (const r of history || []) { if (!r.outcome || r.outcome.hit == null) continue; const g = r.grade; out[g] = out[g] || { n: 0, hits: 0 }; out[g].n++; if (r.outcome.hit) out[g].hits++; }
  const all = Object.values(out).reduce((a, g) => ({ n: a.n + g.n, hits: a.hits + g.hits }), { n: 0, hits: 0 }); return { byGrade: out, all };
}
