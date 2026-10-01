// Recent insider filings (SEC Form 4) for a ticker, from EDGAR full-text search. Free; SEC requires a descriptive User-Agent.
const UA = process.env.SEC_USER_AGENT || "Kingnode terminal contact@example.com";
const cache = new Map();
export default async function handler(req, res) {
  const sym = String(req.query?.symbol || "").toUpperCase().replace(/[^A-Z.]/g, "").slice(0, 8);
  if (!sym) return res.status(400).json({ error: "bad_symbol" });
  const hit = cache.get(sym); if (hit && Date.now() - hit.at < 30 * 60_000) return res.status(200).json(hit.data);
  try {
    const r = await fetch(`https://efts.sec.gov/LATEST/search-index?q=%22${sym}%22&forms=4&dateRange=custom&startdt=${new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)}&enddt=${new Date().toISOString().slice(0, 10)}`, { headers: { "user-agent": UA, accept: "application/json" } });
    if (!r.ok) throw new Error("http " + r.status);
    const j = await r.json();
    const hits = (j.hits?.hits || []).slice(0, 40).map(h => { const s = h._source || {}; const [adsh] = (h._id || "").split(":"); const cik = (s.ciks || [])[0] || "";
      return { filed: s.file_date, entity: (s.display_names || [])[0] || "", form: s.form, url: cik ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${adsh.replace(/-/g, "")}/${adsh}-index.htm` : "https://www.sec.gov/edgar/search/#/q=" + sym }; });
    const data = { symbol: sym, count: j.hits?.total?.value || hits.length, filings: hits };
    cache.set(sym, { at: Date.now(), data });
    res.setHeader("Cache-Control", "public, max-age=900");
    return res.status(200).json(data);
  } catch (e) { console.error("insiders", sym, e.message); return res.status(502).json({ error: "unavailable" }); }
}
