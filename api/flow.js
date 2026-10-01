// Options flow tape. The collector (collector/flow-collector.mjs) streams trades from your vendor's websocket,
// scores them, and POSTs batches here with FLOW_SECRET. The terminal GETs the recent tape.
// Storage is in-memory per serverless instance plus Vercel Blob when BLOB_READ_WRITE_TOKEN is set (so every instance sees it).
import { put, list } from "@vercel/blob";

let mem = { at: 0, trades: [] };
const MAX = 3000;

async function readBlob() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try { const { blobs } = await list({ prefix: "flow/tape.json", limit: 1 }); if (!blobs.length) return null; return await (await fetch(blobs[0].url, { cache: "no-store" })).json(); } catch { return null; }
}
async function writeBlob(data) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try { await put("flow/tape.json", JSON.stringify(data), { access: "public", contentType: "application/json", addRandomSuffix: false, cacheControlMaxAge: 60 }); } catch (e) { console.warn("flow blob", e.message); }
}

export default async function handler(req, res) {
  if (req.method === "POST") {
    if (!process.env.FLOW_SECRET || (req.headers.authorization || "") !== `Bearer ${process.env.FLOW_SECRET}`) return res.status(401).json({ error: "unauthorized" });
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const incoming = Array.isArray(body?.trades) ? body.trades : [];
    if (mem.at < Date.now() - 120_000) { const b = await readBlob(); if (b?.trades) mem = b; }
    mem.trades = [...mem.trades, ...incoming].slice(-MAX); mem.at = Date.now();
    await writeBlob(mem);
    return res.status(200).json({ ok: true, size: mem.trades.length });
  }
  const sym = String(req.query?.symbol || "").toUpperCase();
  if (mem.at < Date.now() - 60_000) { const b = await readBlob(); if (b?.trades) mem = b; }
  const since = Number(req.query?.since || 0);
  let trades = mem.trades.filter(t => t.t > since && (!sym || t.u === sym));
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ at: mem.at, live: mem.at > Date.now() - 5 * 60_000, trades: trades.slice(-1000) });
}
