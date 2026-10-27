// Minimal local server: static files from the project root + api/*.js handlers with a Vercel-style (req, res) shape.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import { engineFromEnv, restFromEnv } from "../server/market.mjs";
import { attachHub } from "../server/hub.mjs";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".md": "text/markdown", ".png": "image/png" };

export function startServer(root, port = 4810) {
  config({ path: path.join(root, ".env.local") }); config({ path: path.join(root, ".env") });
  // the streaming tier: one upstream connection (Alpaca / Polygon) shared by every tab, exposed at /ws and to the api/* handlers
  const engine = engineFromEnv(process.env), rest = restFromEnv(process.env); globalThis.__kingnode = { engine, rest, startedAt: Date.now() };
  engine.on("status", st => { if (st.state !== "live") console.log(`[market] ${st.provider} ${st.state}${st.reason ? " — " + st.reason : ""}`); });
  engine.start();
  const handlers = new Map();
  async function handler(name) {
    if (!handlers.has(name)) { const f = path.join(root, "api", ...name.split("/")) + ".js"; if (!fs.existsSync(f)) return null; handlers.set(name, (await import(pathToFileURL(f).href)).default); }
    return handlers.get(name);
  }
  // a small token bucket per client address for /api/* (the provider behind it has its own limits; one tab asking every second is fine, a loop is not)
  const buckets = new Map(); const RATE = Number(process.env.API_RATE_PER_MIN || 240);
  const allow = ip => { const now = Date.now(); let b = buckets.get(ip); if (!b || now - b.at > 60e3) { b = { at: now, n: 0 }; buckets.set(ip, b); } b.n++; if (buckets.size > 5000) buckets.clear(); return b.n <= RATE; };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Frame-Options", "SAMEORIGIN");
    try {
      if (u.pathname.startsWith("/api/")) {
        if (!allow(req.socket.remoteAddress || "?")) { res.writeHead(429, { "content-type": "application/json", "retry-after": "30" }); return res.end('{"error":"rate limited"}'); }
        const h = await handler(u.pathname.slice(5)); if (!h) { res.writeHead(404, { "content-type": "application/json" }); return res.end('{"error":"no_such_api"}'); }
        let raw = ""; for await (const c of req) raw += c;
        let body = raw; try { body = raw ? JSON.parse(raw) : {}; } catch {}
        const vreq = { method: req.method, headers: req.headers, query: Object.fromEntries(u.searchParams), body, url: req.url };
        const vres = { statusCode: 200, _h: {}, setHeader(k, v) { this._h[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; },
          json(o) { this._h["content-type"] = "application/json"; res.writeHead(this.statusCode, this._h); res.end(JSON.stringify(o)); }, send(b) { res.writeHead(this.statusCode, this._h); res.end(b); },
          write(c) { if (!res.headersSent) res.writeHead(this.statusCode, this._h); res.write(c); }, end(c) { if (!res.headersSent) res.writeHead(this.statusCode, this._h); res.end(c); } };
        return await h(vreq, vres);
      }
      // rewrite /s/:slug like vercel.json
      const m = u.pathname.match(/^\/s\/([a-z0-9-]+)$/); if (m) { const h = await handler("site"); if (h) return h({ method: "GET", headers: req.headers, query: { slug: m[1] } }, mkRes(res)); }
      let p = decodeURIComponent(u.pathname === "/" ? "/index.html" : u.pathname); const f = path.normalize(path.join(root, p));
      // never serve the private parts of the tree: dotfiles (.env, .git), node_modules, the server itself
      if (!f.startsWith(root) || /(^|[\/\\])(\.[^\/\\]+|node_modules|server|desktop|scripts|test)([\/\\]|$)/.test(path.relative(root, f)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
    } catch (e) { console.error(e); if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
  });
  function mkRes(res) { return { statusCode: 200, _h: {}, setHeader(k, v) { this._h[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { res.writeHead(this.statusCode, { ...this._h, "content-type": "application/json" }); res.end(JSON.stringify(o)); }, send(b) { res.writeHead(this.statusCode, this._h); res.end(b); } }; }
  const hub = attachHub(srv, engine, { rest }); globalThis.__kingnode.server = srv; globalThis.__kingnode.hub = hub;
  const host = process.env.HOST || "127.0.0.1";
  return new Promise(resolve => { const tryListen = p => srv.once("error", () => tryListen(p + 1)).listen(p, host, () => { console.log(`Kingnode local server http://${host}:${p} · market stream: ${engine.provider === "none" ? "off (set MARKET_STREAM=alpaca or polygon with keys)" : engine.provider + " (" + engine.feedType + ")"}`); resolve(p); }); tryListen(port); });
}

// `node server.js` runs it headless for any browser (no Electron needed)
if (process.argv[1] && process.argv[1].endsWith("server.js")) { const root = path.resolve(path.dirname(process.argv[1]), ".."); startServer(root).then(p => console.log(`Open http://127.0.0.1:${p}/app.html`)); }
