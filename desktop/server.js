// Kingnode's server: static files from the project root, api/*.js handlers with a Vercel-style (req, res) shape, the streaming hub at /ws,
// the feed's files at /data/* and — when FEED=1 — the feed loop itself as a supervised child process. One process runs the whole terminal:
//   local      node desktop/server.js                       → http://127.0.0.1:4810 (the desktop app starts the same thing)
//   cloud      PORT set by the host (Railway, Render, Fly)  → binds 0.0.0.0, serves /data straight from disk (no CDN, no caching),
//              FEED=1 runs scripts/snapshot.mjs forever with PUSH=0, DATA_DIR points at a persistent volume
// Keys (ANTHROPIC_API_KEY, ALPACA_*, POLYGON_KEY, TRADIER_TOKEN) live in the environment; browsers only ever send symbol names and, for Ava
// and the proxied APIs on a public host, the ASK_KEY password.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import { engineFromEnv, restFromEnv } from "../server/market.mjs";
import { attachHub } from "../server/hub.mjs";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".md": "text/markdown", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8" };

export function startServer(root, port = Number(process.env.PORT) || 4810) {
  config({ path: path.join(root, ".env.local") }); config({ path: path.join(root, ".env") });
  const cloud = !!process.env.PORT || process.env.HOST === "0.0.0.0";
  // the data directory: ./data, or DATA_DIR (a mounted volume) linked in as ./data so the feed and the routes agree on one place
  const dataDir = prepareDataDir(root);
  // the streaming tier: one upstream connection (Alpaca / Polygon) shared by every tab, exposed at /ws and to the api/* handlers
  const engine = engineFromEnv(process.env), rest = restFromEnv(process.env); globalThis.__kingnode = { engine, rest, startedAt: Date.now(), dataDir, cloud };
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
  const clientIp = req => (cloud && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Frame-Options", "SAMEORIGIN");
    try {
      if (u.pathname === "/api/ping") { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); return res.end(JSON.stringify({ ok: true, at: Date.now(), up: Math.round((Date.now() - globalThis.__kingnode.startedAt) / 1000) })); }
      if (u.pathname.startsWith("/api/")) {
        if (!allow(clientIp(req))) { res.writeHead(429, { "content-type": "application/json", "retry-after": "30" }); return res.end('{"error":"rate limited"}'); }
        const h = await handler(u.pathname.slice(5)); if (!h) { res.writeHead(404, { "content-type": "application/json" }); return res.end('{"error":"no_such_api"}'); }
        let raw = ""; for await (const c of req) { raw += c; if (raw.length > 2e6) { res.writeHead(413); return res.end(); } }
        let body = raw; try { body = raw ? JSON.parse(raw) : {}; } catch {}
        const vreq = { method: req.method, headers: req.headers, query: Object.fromEntries(u.searchParams), body, url: req.url };
        const vres = { statusCode: 200, _h: {}, setHeader(k, v) { this._h[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; },
          json(o) { this._h["content-type"] = "application/json"; res.writeHead(this.statusCode, this._h); res.end(JSON.stringify(o)); }, send(b) { res.writeHead(this.statusCode, this._h); res.end(b); },
          write(c) { if (!res.headersSent) res.writeHead(this.statusCode, this._h); res.write(c); }, end(c) { if (!res.headersSent) res.writeHead(this.statusCode, this._h); res.end(c); } };
        return await h(vreq, vres);
      }
      // the feed's files, straight from disk: the browser asks for the current one and gets the current one (the GitHub CDN caches for 5 minutes; this does not)
      if (u.pathname.startsWith("/data/")) {
        const rel = decodeURIComponent(u.pathname.slice(6)); const f = path.normalize(path.join(dataDir, rel));
        if (!f.startsWith(dataDir) || /(^|[\/\\])\./.test(rel) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" }); return res.end('{"error":"not_found"}'); }
        res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream", "cache-control": "no-store", "access-control-allow-origin": "*", "last-modified": fs.statSync(f).mtime.toUTCString() }); return fs.createReadStream(f).pipe(res);
      }
      // rewrite /s/:slug like vercel.json
      const m = u.pathname.match(/^\/s\/([a-z0-9-]+)$/); if (m) { const h = await handler("site"); if (h) return h({ method: "GET", headers: req.headers, query: { slug: m[1] } }, mkRes(res)); }
      let p = decodeURIComponent(u.pathname === "/" ? "/index.html" : u.pathname); const f = path.normalize(path.join(root, p));
      // never serve the private parts of the tree: dotfiles (.env, .git), node_modules, the server itself, the raw data directory (it has its own route above)
      if (!f.startsWith(root) || /(^|[\/\\])(\.[^\/\\]+|node_modules|server|desktop|scripts|test|data)([\/\\]|$)/.test(path.relative(root, f)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("not found"); }
      const ext = path.extname(f); res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": ext === ".html" || ext === ".js" ? "no-cache" : "public, max-age=3600" }); fs.createReadStream(f).pipe(res);
    } catch (e) { console.error(e); if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
  });
  function mkRes(res) { return { statusCode: 200, _h: {}, setHeader(k, v) { this._h[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { res.writeHead(this.statusCode, { ...this._h, "content-type": "application/json" }); res.end(JSON.stringify(o)); }, send(b) { res.writeHead(this.statusCode, this._h); res.end(b); } }; }
  const hub = attachHub(srv, engine, { rest }); globalThis.__kingnode.server = srv; globalThis.__kingnode.hub = hub;
  if (process.env.FEED === "1") globalThis.__kingnode.feed = startFeed(root);
  const host = process.env.HOST || (cloud ? "0.0.0.0" : "127.0.0.1");
  return new Promise(resolve => { const tryListen = p => srv.once("error", () => tryListen(p + 1)).listen(p, host, () => { console.log(`Kingnode server http://${host}:${srv.address().port} · market stream: ${engine.provider === "none" ? "off (set MARKET_STREAM=alpaca or polygon with keys)" : engine.provider + " (" + engine.feedType + ")"} · feed: ${process.env.FEED === "1" ? "in-process" : "external"} · data: ${dataDir}`); resolve(srv.address().port); }); tryListen(port); });
}

// ./data is where the feed writes and the routes read. With DATA_DIR set (a persistent volume on a cloud host), ./data becomes a link to it.
function prepareDataDir(root) {
  const link = path.join(root, "data");
  if (process.env.DATA_DIR) {
    const target = path.resolve(process.env.DATA_DIR);
    try { fs.mkdirSync(target, { recursive: true }); const st = fs.lstatSync(link, { throwIfNoEntry: false });
      if (!st) fs.symlinkSync(target, link, "dir");
      else if (st.isSymbolicLink()) { if (fs.readlinkSync(link) !== target) { fs.unlinkSync(link); fs.symlinkSync(target, link, "dir"); } }
      else if (st.isDirectory() && fs.readdirSync(link).length === 0) { fs.rmdirSync(link); fs.symlinkSync(target, link, "dir"); }
      else console.warn(`[data] ./data already has files; DATA_DIR=${target} not linked`);
      return fs.realpathSync(link); } catch (e) { console.warn("[data]", e.message); }
  }
  fs.mkdirSync(link, { recursive: true }); return fs.realpathSync(link);
}

// the feed loop as a child: forever (no GitHub handoff), writing files instead of pushing; restarted with backoff if it ever exits
function startFeed(root) {
  const state = { child: null, restarts: 0, startedAt: 0, backoff: 5000, stop: false };
  const run = () => {
    if (state.stop) return;
    const env = { ...process.env, PUSH: "0", LOOP_MINUTES: process.env.LOOP_MINUTES || "525600", HANDOFF_MINUTES: "0", EVERY_SEC: process.env.EVERY_SEC || "60" }; delete env.GITHUB_TOKEN; // nothing to push, nothing to dispatch
    state.startedAt = Date.now(); state.child = spawn(process.execPath, [path.join(root, "scripts", "snapshot.mjs")], { cwd: root, stdio: "inherit", env });
    state.child.on("exit", (code, sig) => { if (state.stop) return; const ran = Date.now() - state.startedAt; if (ran > 600e3) state.backoff = 5000; console.log(`[feed] exited (${code ?? sig}) after ${Math.round(ran / 1000)}s · restarting in ${state.backoff / 1000}s`); state.restarts++; setTimeout(run, state.backoff); state.backoff = Math.min(300e3, state.backoff * 2); });
  };
  run();
  const stop = () => { state.stop = true; try { state.child?.kill("SIGTERM"); } catch {} };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  return { state, stop };
}

// `node server.js` runs it headless for any browser (no Electron needed)
if (process.argv[1] && process.argv[1].endsWith("server.js")) { const root = path.resolve(path.dirname(process.argv[1]), ".."); startServer(root).then(p => console.log(`Open http://127.0.0.1:${p}/app.html`)); }
