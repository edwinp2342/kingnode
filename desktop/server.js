// Minimal local server: static files from the project root + api/*.js handlers with a Vercel-style (req, res) shape.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".md": "text/markdown", ".png": "image/png" };

export function startServer(root, port = 4810) {
  config({ path: path.join(root, ".env.local") }); config({ path: path.join(root, ".env") });
  const handlers = new Map();
  async function handler(name) {
    if (!handlers.has(name)) { const f = path.join(root, "api", ...name.split("/")) + ".js"; if (!fs.existsSync(f)) return null; handlers.set(name, (await import(pathToFileURL(f).href)).default); }
    return handlers.get(name);
  }
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    try {
      if (u.pathname.startsWith("/api/")) {
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
      if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
    } catch (e) { console.error(e); if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
  });
  function mkRes(res) { return { statusCode: 200, _h: {}, setHeader(k, v) { this._h[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { res.writeHead(this.statusCode, { ...this._h, "content-type": "application/json" }); res.end(JSON.stringify(o)); }, send(b) { res.writeHead(this.statusCode, this._h); res.end(b); } }; }
  return new Promise(resolve => { const tryListen = p => srv.once("error", () => tryListen(p + 1)).listen(p, "127.0.0.1", () => { console.log(`Kingnode local server http://127.0.0.1:${p}`); resolve(p); }); tryListen(port); });
}

// `node server.js` runs it headless for any browser (no Electron needed)
if (process.argv[1] && process.argv[1].endsWith("server.js")) { const root = path.resolve(path.dirname(process.argv[1]), ".."); startServer(root).then(p => console.log(`Open http://127.0.0.1:${p}/app.html`)); }
