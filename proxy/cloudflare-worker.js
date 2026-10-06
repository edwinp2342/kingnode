// Kingnode data proxy — a Cloudflare Worker (free tier is plenty). It forwards requests to the market-data hosts the
// terminal uses and adds CORS headers so the static site can read them from any browser.
//   1. dash.cloudflare.com → Workers & Pages → Create → "Hello World" worker → Edit code → paste this → Deploy.
//   2. Copy the worker URL (https://something.workers.dev) into Kingnode: ⚙ Settings → Data proxy URL.
// Only the hosts below are allowed; nothing else is forwarded.
const ALLOW = ["cdn.cboe.com", "query1.finance.yahoo.com", "query2.finance.yahoo.com", "efts.sec.gov", "cdn.finra.org"];
export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors() });
    const target = url.searchParams.get("u");
    if (!target) return new Response("usage: ?u=<encoded url>", { status: 400, headers: cors() });
    let t; try { t = new URL(target); } catch { return new Response("bad url", { status: 400, headers: cors() }); }
    if (!ALLOW.includes(t.hostname)) return new Response("host not allowed", { status: 403, headers: cors() });
    const r = await fetch(t.toString(), { headers: { "user-agent": "Mozilla/5.0 (Kingnode)", accept: "application/json,text/plain,*/*" }, cf: { cacheTtl: 30 } });
    const h = new Headers(r.headers); for (const [k, v] of Object.entries(cors())) h.set(k, v); h.delete("content-security-policy");
    return new Response(r.body, { status: r.status, headers: h });
  }
};
function cors() { return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "*", "cache-control": "public, max-age=30" }; }
