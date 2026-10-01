// Server-side copy of the terminal's core math (used by the morning cron). Keep in sync with app.html computeFrom().
export function computeLevels(chain, expCount = 4, range = 8, model = "standard") {
  const spot = chain.spot, mult = 100 * spot * spot * 0.01;
  const exps = [...new Set(chain.rows.map(r => r[0]))].sort().slice(0, expCount), sel = new Set(exps);
  const hi = spot * (1 + range / 100), lo = spot * (1 - range / 100);
  const byStrike = new Map(); let total = 0; const contracts = [];
  for (const [exp, type, K, oi, vol, iv, gamma, delta, bid, ask, last] of chain.rows) {
    if (!sel.has(exp)) continue;
    const sign = model === "standard" ? (type === "C" ? 1 : -1) : -1, gex = sign * gamma * oi * mult;
    contracts.push({ exp, type, K, oi, vol, mid: (bid + ask) / 2 || last, gex });
    if (K < lo || K > hi) continue;
    const s = byStrike.get(K) || { K, gex: 0, cG: 0, pG: 0 }; s.gex += gex; if (type === "C") s.cG += gamma * oi * mult; else s.pG += gamma * oi * mult; byStrike.set(K, s); total += gex;
  }
  const strikes = [...byStrike.values()].sort((a, b) => a.K - b.K);
  const callWall = strikes.reduce((a, s) => s.K > spot * 1.002 && s.cG > (a?.cG || 0) ? s : a, null);
  const putWall = strikes.reduce((a, s) => s.K < spot * 0.998 && s.pG > (a?.pG || 0) ? s : a, null);
  let cum = 0, flip = null, best = Infinity, prev = null;
  for (const s of strikes) { cum += s.gex; if (prev !== null && prev !== 0 && Math.sign(cum) !== Math.sign(prev) && Math.abs(s.K - spot) < best) { best = Math.abs(s.K - spot); flip = s.K; } prev = cum; }
  const near = contracts.filter(c => c.exp === exps[0]);
  const atm = near.reduce((a, c) => Math.abs(c.K - spot) < Math.abs(a.K - spot) ? c : a, near[0] || { K: spot });
  const call = near.find(c => c.K === atm.K && c.type === "C"), put = near.find(c => c.K === atm.K && c.type === "P");
  const move = (call?.mid || 0) + (put?.mid || 0);
  return { symbol: chain.symbol, spot, total, callWall: callWall?.K ?? null, putWall: putWall?.K ?? null, flip, expectedMove: move, expectedPct: spot ? move / spot * 100 : 0, nearest: exps[0] };
}
export const fmt = (n, d = 0) => n == null ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const money = n => { const a = Math.abs(n); const s = a >= 1e9 ? (a / 1e9).toFixed(2) + "B" : a >= 1e6 ? (a / 1e6).toFixed(1) + "M" : (a / 1e3).toFixed(0) + "K"; return (n < 0 ? "-$" : "$") + s; };
