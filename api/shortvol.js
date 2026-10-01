// Daily short-volume ratio from FINRA's Reg SHO daily files (free). Short volume / total volume per day, last N sessions.
// A rising share of short volume alongside falling price is a classic institutional-distribution tell; the reverse is accumulation.
const cache = new Map();
function ymd(d) { return d.toISOString().slice(0, 10).replace(/-/g, ""); }
export default async function handler(req, res) {
  const sym = String(req.query?.symbol || "").toUpperCase().replace(/[^A-Z.]/g, "").slice(0, 8);
  if (!sym) return res.status(400).json({ error: "bad_symbol" });
  const hit = cache.get(sym); if (hit && Date.now() - hit.at < 6 * 3600_000) return res.status(200).json(hit.data);
  const days = []; const d = new Date(); let tries = 0;
  while (days.length < 8 && tries < 16) { d.setDate(d.getDate() - 1); tries++; if (d.getDay() % 6 === 0) continue; days.push(new Date(d)); }
  const rows = [];
  await Promise.all(days.map(async day => {
    try {
      const r = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${ymd(day)}.txt`, { headers: { "user-agent": "Mozilla/5.0 (Undertow)" } });
      if (!r.ok) return;
      const text = await r.text();
      const line = text.split("\n").find(l => l.split("|")[1] === sym);
      if (!line) return;
      const [date, , shortVol, shortExempt, totalVol] = line.split("|");
      rows.push({ date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`, shortVol: +shortVol, totalVol: +totalVol, ratio: +totalVol ? +shortVol / +totalVol : null });
    } catch {}
  }));
  rows.sort((a, b) => a.date < b.date ? -1 : 1);
  const data = { symbol: sym, days: rows, note: "Consolidated NMS off-exchange (incl. dark pool) short volume; not total market volume." };
  cache.set(sym, { at: Date.now(), data });
  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.status(200).json(data);
}
