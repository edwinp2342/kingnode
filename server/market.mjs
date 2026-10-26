// Kingnode streaming market-data engine.
//
//   provider (Alpaca · Polygon/Massive · the GitHub feed) → normalize + validate → candle builder → in-memory store → hub (WebSocket fan-out) → app
//
// One upstream connection per process, whatever the number of browser tabs. Symbols are subscribed upstream only while at least one client
// wants them (ref-counted), re-subscribed after a reconnect, and dropped when the last client lets go. Every quote carries where it came from
// and what kind of feed it is: "iex" (one exchange's prints — Alpaca's free plan), "sip" (the consolidated tape — Polygon/Massive real-time
// plans, Alpaca paid), "delayed" (15-minute: Polygon starter, or the delayed socket), "snapshot" (the GitHub feed, ~20 s). Nothing here invents
// a price: a symbol the provider does not know is reported as unavailable, a feed that goes quiet in market hours is reported as stale.
//
// Timestamps are epoch milliseconds (UTC) throughout; the app formats them for New York.
import { EventEmitter } from "node:events";
import { marketPhase } from "../scripts/market-clock.mjs";

export const IV_MS = { "1m": 60e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3, "1h": 3600e3, "1d": 86400e3 };

// ---------- normalization: provider message → engine events ----------
// Alpaca stream (https://docs.alpaca.markets/docs/real-time-stock-pricing-data): arrays of {T:"t"|"q"|"b"|"success"|"error"|"subscription", S, p, s, t(ISO), bp, ap, o,h,l,c,v}
export function normalizeAlpaca(msg) {
  const out = [];
  for (const m of Array.isArray(msg) ? msg : [msg]) {
    if (!m || typeof m !== "object") continue;
    const t = m.t ? Date.parse(m.t) : NaN;
    if (m.T === "t" && m.S && m.p > 0) out.push({ type: "trade", sym: m.S, price: +m.p, size: +m.s || 0, t, cond: m.c || [], exch: m.x || null });
    else if (m.T === "q" && m.S) out.push({ type: "quote", sym: m.S, bid: +m.bp || null, ask: +m.ap || null, bidSize: +m.bs || 0, askSize: +m.as || 0, t });
    else if ((m.T === "b" || m.T === "u") && m.S) out.push({ type: "bar", sym: m.S, bar: [Date.parse(m.t), +m.o, +m.h, +m.l, +m.c, +m.v || 0], final: m.T === "b" });
    else if (m.T === "d" && m.S) out.push({ type: "daily", sym: m.S, bar: [Date.parse(m.t), +m.o, +m.h, +m.l, +m.c, +m.v || 0] });
    else if (m.T === "success") out.push({ type: "control", kind: m.msg === "authenticated" ? "authenticated" : m.msg === "connected" ? "connected" : "ok", msg: m.msg });
    else if (m.T === "error") out.push({ type: "control", kind: "error", code: m.code, msg: m.msg });
    else if (m.T === "subscription") out.push({ type: "control", kind: "subscription", trades: m.trades || [], quotes: m.quotes || [], bars: m.bars || [] });
  }
  return out;
}
// Polygon / Massive stream (https://polygon.io/docs/stocks/ws_stocks_t): arrays of {ev:"T"|"Q"|"AM"|"A"|"status", sym, p, s, t(ms), bp, ap, o,h,l,c,v, s(start ms)}
export function normalizePolygon(msg) {
  const out = [];
  for (const m of Array.isArray(msg) ? msg : [msg]) {
    if (!m || typeof m !== "object") continue;
    if (m.ev === "T" && m.sym && m.p > 0) out.push({ type: "trade", sym: m.sym, price: +m.p, size: +m.s || 0, t: +m.t, cond: m.c || [], exch: m.x ?? null });
    else if (m.ev === "Q" && m.sym) out.push({ type: "quote", sym: m.sym, bid: +m.bp || null, ask: +m.ap || null, bidSize: +m.bs || 0, askSize: +m.as || 0, t: +m.t });
    else if ((m.ev === "AM" || m.ev === "A") && m.sym) out.push({ type: "bar", sym: m.sym, bar: [+m.s, +m.o, +m.h, +m.l, +m.c, +m.v || 0], final: m.ev === "AM", span: m.ev === "AM" ? 60e3 : 1e3 });
    else if (m.ev === "status") out.push({ type: "control", kind: m.status === "auth_success" ? "authenticated" : m.status === "connected" ? "connected" : m.status === "auth_failed" ? "error" : m.status === "success" ? "ok" : m.status, msg: m.message });
  }
  return out;
}
// Trade conditions that do not update the last price (late / out-of-sequence / odd-lot prints on SIP; Alpaca uses CTA/UTP codes as letters)
const SKIP_COND = new Set(["Z", "U", "T", "I", "W", "M", "Q", "4", "7", "9", "C", "G", "H", "P", "V"]);
export function tradeUpdatesLast(cond) { return !(cond || []).some(c => SKIP_COND.has(String(c))); }

// ---------- candles: trades → forming 1-minute bar, provider bars as the final word ----------
export class CandleBuilder {
  constructor(spanMs = 60e3) { this.span = spanMs; this.cur = null; this.lastT = 0; }
  trade(price, size, t) {
    if (!(price > 0) || !(t > 0)) return null;
    const start = t - (t % this.span);
    if (this.cur && start < this.cur[0]) return null;           // a print for an earlier bar: do not rewrite history
    if (!this.cur || this.cur[0] !== start) { const closed = this.cur; this.cur = [start, price, price, price, price, size]; this.lastT = t; return { bar: this.cur.slice(), closed: closed ? closed.slice() : null }; }
    const b = this.cur; if (price > b[2]) b[2] = price; if (price < b[3]) b[3] = price; if (t >= this.lastT) { b[4] = price; this.lastT = t; } b[5] += size; // an out-of-order print inside the bar still counts for high/low/volume, not for the close
    return { bar: b.slice(), closed: null };
  }
  // a provider bar replaces whatever the trades built for that minute (it is the authoritative aggregate)
  providerBar(bar) { const start = bar[0] - (bar[0] % this.span); const b = [start, bar[1], bar[2], bar[3], bar[4], bar[5] || 0]; if (!this.cur || this.cur[0] < start) { this.cur = b; this.lastT = Math.max(this.lastT, start); } else if (this.cur[0] === start) { this.cur = b; } return b.slice(); }
}

// ---------- the engine ----------
export class MarketEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.provider = opts.provider || "none";                         // alpaca | polygon | none
    this.feedType = opts.feedType || (this.provider === "alpaca" ? (opts.alpacaFeed === "sip" ? "sip" : "iex") : this.provider === "polygon" ? (opts.delayed ? "delayed" : "sip") : "none");
    this.keys = opts.keys || {};
    this.url = opts.url || (this.provider === "alpaca" ? `wss://stream.data.alpaca.markets/v2/${opts.alpacaFeed === "sip" ? "sip" : opts.alpacaFeed === "test" ? "test" : "iex"}` : this.provider === "polygon" ? (opts.delayed ? "wss://delayed.polygon.io/stocks" : "wss://socket.polygon.io/stocks") : null);
    this.makeSocket = opts.makeSocket || (url => new WebSocket(url));   // injectable for tests
    this.log = opts.log || ((...a) => console.log("[market]", ...a));
    this.now = opts.now || (() => Date.now());
    this.staleAfterMs = opts.staleAfterMs ?? 90e3;                    // quiet this long in market hours = stale
    this.maxSymbols = opts.maxSymbols ?? (this.provider === "alpaca" && this.feedType === "iex" ? 30 : 1000); // Alpaca's free plan allows 30 stream symbols
    this.refs = new Map();                                            // sym → client count
    this.pending = new Set();                                         // symbols wanted upstream but not confirmed yet
    this.store = new Map();                                           // sym → { price, size, t, bid, ask, bidT, bar, bars: [last few 1m], daily, prev, updatedAt, unavailable }
    this.builders = new Map();
    this.state = this.provider === "none" ? "disabled" : "idle";      // idle | connecting | authenticating | live | reconnecting | stale | disabled | error
    this.lastMsgAt = 0; this.reconnects = 0; this.backoffMs = 1000; this.sock = null; this.stopped = false; this.errors = []; this.msgCount = 0; this.dropped = 0;
    this._staleTimer = null; this._pingTimer = null;
  }
  status() {
    const ph = marketPhase(new Date(this.now()));
    return { provider: this.provider, feedType: this.feedType, state: this.state, phase: ph, connectedUrl: this.url, lastMsgAt: this.lastMsgAt || null, lastMsgAgeMs: this.lastMsgAt ? this.now() - this.lastMsgAt : null, subscriptions: [...this.refs.keys()], subscribed: this.refs.size, maxSymbols: this.maxSymbols, reconnects: this.reconnects, messages: this.msgCount, dropped: this.dropped, errors: this.errors.slice(-5), realtime: this.feedType === "iex" || this.feedType === "sip", consolidated: this.feedType === "sip" };
  }
  snapshot(sym) { const s = this.store.get(sym); return s ? { sym, ...s, provider: this.provider, feedType: this.feedType } : null; }
  // ----- lifecycle -----
  start() {
    if (this.provider === "none") { this.state = "disabled"; this.emit("status", this.status()); return this; }
    if (!this.hasKeys()) { this.state = "error"; this.errors.push({ at: this.now(), msg: `${this.provider}: credentials missing` }); this.emit("status", this.status()); return this; }
    this.stopped = false; this.connect(); return this;
  }
  stop() { this.stopped = true; clearTimeout(this._reconnectTimer); clearInterval(this._staleTimer); clearInterval(this._pingTimer); try { this.sock?.close(); } catch {} this.sock = null; if (this.state !== "error" && this.state !== "disabled") this.state = "idle"; }
  hasKeys() { return this.provider === "alpaca" ? !!(this.keys.key && this.keys.secret) : this.provider === "polygon" ? !!this.keys.key : false; }
  connect() {
    if (this.stopped || !this.url) return;
    this.state = this.reconnects ? "reconnecting" : "connecting"; this.emit("status", this.status());
    let sock; try { sock = this.makeSocket(this.url); } catch (e) { return this.onDrop("open failed: " + e.message); }
    this.sock = sock;
    sock.onopen = () => { this.state = "authenticating"; this.backoffMs = 1000; this.send(this.provider === "alpaca" ? { action: "auth", key: this.keys.key, secret: this.keys.secret } : { action: "auth", params: this.keys.key }); };
    sock.onmessage = ev => this.onMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
    sock.onclose = ev => this.onDrop(`closed ${ev?.code ?? ""} ${ev?.reason ?? ""}`.trim());
    sock.onerror = ev => { this.errors.push({ at: this.now(), msg: "socket error" + (ev?.message ? ": " + ev.message : "") }); };
    clearInterval(this._staleTimer); this._staleTimer = setInterval(() => this.checkStale(), 5000); this._staleTimer.unref?.();
  }
  send(obj) { try { if (this.sock && this.sock.readyState === 1) this.sock.send(JSON.stringify(obj)); } catch (e) { this.errors.push({ at: this.now(), msg: "send: " + e.message }); } }
  onDrop(why) {
    if (this.stopped) return;
    this.sock = null; this.errors.push({ at: this.now(), msg: why }); this.reconnects++;
    const wait = Math.min(60e3, this.backoffMs) + Math.floor(Math.random() * 500); this.backoffMs = Math.min(60e3, this.backoffMs * 2); // exponential, capped at a minute, a little jitter
    this.state = "reconnecting"; this.emit("status", { ...this.status(), reason: why, retryInMs: wait });
    clearTimeout(this._reconnectTimer); this._reconnectTimer = setTimeout(() => this.connect(), wait); this._reconnectTimer.unref?.();
  }
  onMessage(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { this.dropped++; return; }
    this.msgCount++; this.lastMsgAt = this.now();
    const events = this.provider === "alpaca" ? normalizeAlpaca(msg) : normalizePolygon(msg);
    for (const ev of events) {
      if (ev.type === "control") { this.onControl(ev); continue; }
      if (!this.refs.has(ev.sym) && !this.pending.has(ev.sym)) { this.dropped++; continue; } // not ours (a late message after an unsubscribe)
      if (ev.type === "trade") this.onTrade(ev); else if (ev.type === "quote") this.onQuote(ev); else if (ev.type === "bar") this.onBar(ev); else if (ev.type === "daily") this.onDaily(ev);
    }
  }
  onControl(ev) {
    if (ev.kind === "authenticated") { this.state = "live"; this.emit("status", this.status()); this.resubscribe(); }
    else if (ev.kind === "error") { this.errors.push({ at: this.now(), msg: `${ev.code ?? ""} ${ev.msg ?? ""}`.trim() }); if (/auth/i.test(ev.msg || "") || ev.code === 402 || ev.code === 403) { this.state = "error"; this.emit("status", this.status()); this.stop(); } else if (ev.code === 405 || /limit/i.test(ev.msg || "")) { this.emit("status", { ...this.status(), reason: ev.msg }); } }
    else if (ev.kind === "subscription") { for (const s of [...ev.trades, ...ev.bars]) this.pending.delete(s); this.emit("status", this.status()); }
  }
  rec(sym) { let r = this.store.get(sym); if (!r) { r = { price: null, size: 0, t: 0, bid: null, ask: null, bidT: 0, bar: null, bars: [], daily: null, prev: null, updatedAt: 0, unavailable: false }; this.store.set(sym, r); } return r; }
  onTrade(ev) {
    const r = this.rec(ev.sym);
    if (ev.t < r.t - 2000) { this.dropped++; return; }                           // out of order by more than two seconds: a late print, keep what we have
    if (tradeUpdatesLast(ev.cond) && ev.t >= r.t) { r.price = ev.price; r.t = ev.t; r.size = ev.size; }
    let cb = this.builders.get(ev.sym); if (!cb) { cb = new CandleBuilder(60e3); this.builders.set(ev.sym, cb); }
    const built = cb.trade(ev.price, ev.size, ev.t);
    if (built) { r.bar = built.bar; if (built.closed) this.pushBar(r, built.closed); }
    r.updatedAt = this.now(); r.session = marketPhase(new Date(ev.t));
    this.emit("tick", { sym: ev.sym, price: r.price, t: r.t, size: ev.size, bar: r.bar, session: r.session, feedType: this.feedType });
  }
  onQuote(ev) { const r = this.rec(ev.sym); if (ev.t < r.bidT) return; r.bid = ev.bid; r.ask = ev.ask; r.bidSize = ev.bidSize; r.askSize = ev.askSize; r.bidT = ev.t; r.updatedAt = this.now(); this.emit("bbo", { sym: ev.sym, bid: r.bid, ask: r.ask, bidSize: r.bidSize, askSize: r.askSize, t: ev.t }); }
  onBar(ev) {
    const r = this.rec(ev.sym); let cb = this.builders.get(ev.sym); if (!cb) { cb = new CandleBuilder(60e3); this.builders.set(ev.sym, cb); }
    if (ev.span && ev.span < 60e3) return;                                           // second aggregates are folded by trades already
    const bar = cb.providerBar(ev.bar); if (ev.final) this.pushBar(r, bar); r.bar = cb.cur ? cb.cur.slice() : bar; r.updatedAt = this.now();
    if (!r.price || bar[0] + 60e3 > r.t) { /* no trade seen since this bar: the bar's close is the latest price we know */ if (!r.price || bar[4] !== r.price && bar[0] + 60e3 > r.t) { r.price = bar[4]; r.t = Math.max(r.t, bar[0] + 59e3); } }
    this.emit("bar", { sym: ev.sym, bar, final: !!ev.final, feedType: this.feedType });
  }
  onDaily(ev) { const r = this.rec(ev.sym); r.daily = ev.bar; r.updatedAt = this.now(); }
  pushBar(r, bar) { const last = r.bars[r.bars.length - 1]; if (last && last[0] === bar[0]) r.bars[r.bars.length - 1] = bar; else if (!last || bar[0] > last[0]) r.bars.push(bar); if (r.bars.length > 400) r.bars.splice(0, r.bars.length - 400); }
  // seed previous close / daily figures from a REST snapshot so the first tick already has a change figure
  seed(sym, { prev = null, daily = null, price = null, t = 0 } = {}) { const r = this.rec(sym); if (prev != null) r.prev = prev; if (daily) r.daily = daily; if (price != null && !r.price) { r.price = price; r.t = t; } }
  markUnavailable(sym, why) { const r = this.rec(sym); r.unavailable = why || true; this.emit("status", this.status()); }
  // ----- subscriptions (ref-counted) -----
  subscribe(syms) {
    const added = [];
    for (const s0 of syms) { const s = String(s0 || "").toUpperCase().trim(); if (!/^[A-Z][A-Z.\-]{0,9}$/.test(s)) continue; const n = this.refs.get(s) || 0; this.refs.set(s, n + 1); if (!n) added.push(s); }
    if (added.length && this.state === "live") this.sendSubscribe(added);
    if (this.refs.size > this.maxSymbols) this.errors.push({ at: this.now(), msg: `subscriptions (${this.refs.size}) exceed the plan's ${this.maxSymbols}; the provider will refuse the newest` });
    return added;
  }
  unsubscribe(syms) {
    const gone = [];
    for (const s0 of syms) { const s = String(s0 || "").toUpperCase().trim(); const n = this.refs.get(s); if (!n) continue; if (n > 1) this.refs.set(s, n - 1); else { this.refs.delete(s); gone.push(s); } }
    if (gone.length && this.state === "live") this.send(this.provider === "alpaca" ? { action: "unsubscribe", trades: gone, quotes: gone, bars: gone } : { action: "unsubscribe", params: gone.flatMap(s => [`T.${s}`, `AM.${s}`, `Q.${s}`]).join(",") });
    for (const s of gone) { this.builders.delete(s); }
    return gone;
  }
  sendSubscribe(syms) { for (const s of syms) this.pending.add(s); this.send(this.provider === "alpaca" ? { action: "subscribe", trades: syms, quotes: syms, bars: syms } : { action: "subscribe", params: syms.flatMap(s => [`T.${s}`, `AM.${s}`, `Q.${s}`]).join(",") }); }
  resubscribe() { const all = [...this.refs.keys()]; if (all.length) this.sendSubscribe(all); }
  // ----- health -----
  checkStale() {
    if (this.state !== "live" && this.state !== "stale") return;
    const ph = marketPhase(new Date(this.now())); const quiet = this.now() - this.lastMsgAt;
    const open = ph === "regular" || ph === "pre" || ph === "post";
    const stale = open && this.refs.size > 0 && quiet > this.staleAfterMs;
    if (stale && this.state === "live") { this.state = "stale"; this.emit("status", { ...this.status(), reason: `no messages for ${Math.round(quiet / 1000)}s in market hours` }); }
    else if (!stale && this.state === "stale") { this.state = "live"; this.emit("status", this.status()); }
    if (stale && quiet > this.staleAfterMs * 4) { this.errors.push({ at: this.now(), msg: "stale for too long, reconnecting" }); try { this.sock?.close(); } catch {} this.onDrop("stale"); }
  }
}

// ---------- REST helpers for the providers (historical bars, snapshots, the symbol directory) ----------
const json = async (url, headers, timeoutMs = 20000) => { const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) }); if (r.status === 429) { const e = new Error("rate limited"); e.code = 429; e.retryAfter = Number(r.headers.get("retry-after")) || 2; throw e; } if (!r.ok) { const e = new Error(`http ${r.status}`); e.code = r.status; throw e; } return r.json(); };
export const ALPACA_TF = { "1m": "1Min", "5m": "5Min", "15m": "15Min", "30m": "30Min", "1h": "1Hour", "4h": "4Hour", "1d": "1Day", "1w": "1Week", "1M": "1Month" };
export function alpacaRangeStart(range, now = Date.now()) { const days = { "1d": 1, "5d": 7, "1mo": 31, "3mo": 92, "6mo": 183, ytd: 0, "1y": 366, "5y": 1830, max: 7300 }[range] ?? 7; if (range === "ytd") { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), 0, 1); } return now - days * 86400e3; }
export class AlpacaRest {
  constructor({ key, secret, feed = "iex", dataBase = "https://data.alpaca.markets", tradeBase = "https://api.alpaca.markets" }) { this.h = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret, accept: "application/json" }; this.feed = feed; this.dataBase = dataBase; this.tradeBase = tradeBase; }
  // bars: [t,o,h,l,c,v]; extended=false keeps 09:30–16:00 ET (Alpaca returns all sessions)
  async bars(symbol, interval, range, { extended = true, limit = 10000 } = {}) {
    const tf = ALPACA_TF[interval]; if (!tf) throw new Error("interval " + interval);
    const start = new Date(alpacaRangeStart(range)).toISOString(); let token = null; const out = [];
    for (let page = 0; page < 20; page++) {
      const u = new URL(`${this.dataBase}/v2/stocks/${encodeURIComponent(symbol)}/bars`); u.searchParams.set("timeframe", tf); u.searchParams.set("start", start); u.searchParams.set("limit", String(Math.min(10000, limit))); u.searchParams.set("adjustment", "raw"); u.searchParams.set("feed", this.feed); u.searchParams.set("sort", "asc"); if (token) u.searchParams.set("page_token", token);
      const j = await json(u, this.h); for (const b of j.bars || []) out.push([Date.parse(b.t), +b.o, +b.h, +b.l, +b.c, +b.v || 0]); token = j.next_page_token; if (!token || out.length >= limit) break;
    }
    const bars = extended || interval === "1d" ? out : out.filter(b => { const e = new Date(b[0]); const m = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).format(e).replace(":", "")); return m >= 930 && m < 1600; });
    return { symbol, interval, range, extended, bars: bars.slice(-limit), delayed: false, source: "alpaca", feedType: this.feed };
  }
  // one call: latest trade, latest quote, today's and the previous daily bar for many symbols
  async snapshots(symbols) {
    const u = new URL(`${this.dataBase}/v2/stocks/snapshots`); u.searchParams.set("symbols", symbols.join(",")); u.searchParams.set("feed", this.feed);
    const j = await json(u, this.h); const out = {};
    for (const [sym, s] of Object.entries(j || {})) { if (!s || s.message) { out[sym] = { symbol: sym, error: s?.message || "unavailable" }; continue; }
      const lt = s.latestTrade, lq = s.latestQuote, d = s.dailyBar, p = s.prevDailyBar;
      out[sym] = { symbol: sym, price: lt ? +lt.p : d ? +d.c : null, t: lt ? Date.parse(lt.t) : d ? Date.parse(d.t) : null, bid: lq ? +lq.bp : null, ask: lq ? +lq.ap : null, prev: p ? +p.c : null, open: d ? +d.o : null, high: d ? +d.h : null, low: d ? +d.l : null, volume: d ? +d.v : null, source: "alpaca", feedType: this.feed, realtime: true }; }
    return out;
  }
  // every active US equity the account can see — the market-wide symbol table
  async assets() {
    const j = await json(`${this.tradeBase}/v2/assets?status=active&asset_class=us_equity`, this.h, 60000);
    return (j || []).filter(a => a.tradable !== false && /^[A-Z][A-Z.\-]{0,9}$/.test(a.symbol)).map(a => [a.symbol, a.name || "", a.exchange || "", /ETF|TRUST|FUND/i.test(a.name || "") ? 1 : 0, 0]);
  }
}
export class PolygonRest {
  constructor({ key, base = "https://api.polygon.io" }) { this.key = key; this.base = base; }
  async bars(symbol, interval, range, { limit = 50000 } = {}) {
    const [mult, span] = { "1m": [1, "minute"], "5m": [5, "minute"], "15m": [15, "minute"], "30m": [30, "minute"], "1h": [1, "hour"], "4h": [4, "hour"], "1d": [1, "day"], "1w": [1, "week"], "1M": [1, "month"] }[interval] || [5, "minute"];
    const from = new Date(alpacaRangeStart(range)).toISOString().slice(0, 10), to = new Date().toISOString().slice(0, 10);
    const j = await json(`${this.base}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${mult}/${span}/${from}/${to}?adjusted=true&sort=asc&limit=${limit}&apiKey=${this.key}`, {});
    return { symbol, interval, range, extended: true, bars: (j.results || []).map(b => [b.t, b.o, b.h, b.l, b.c, b.v || 0]), delayed: false, source: "polygon" };
  }
  async snapshots(symbols) {
    const j = await json(`${this.base}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${symbols.map(encodeURIComponent).join(",")}&apiKey=${this.key}`, {}); const out = {};
    for (const t of j.tickers || []) out[t.ticker] = { symbol: t.ticker, price: t.lastTrade?.p ?? t.day?.c ?? null, t: t.lastTrade?.t ? Math.round(t.lastTrade.t / 1e6) : null, bid: t.lastQuote?.p ?? null, ask: t.lastQuote?.P ?? null, prev: t.prevDay?.c ?? null, open: t.day?.o ?? null, high: t.day?.h ?? null, low: t.day?.l ?? null, volume: t.day?.v ?? null, source: "polygon", feedType: "sip" };
    for (const s of symbols) if (!out[s]) out[s] = { symbol: s, error: "unavailable" };
    return out;
  }
  async assets() {
    const out = []; let url = `${this.base}/v3/reference/tickers?market=stocks&active=true&limit=1000&apiKey=${this.key}`;
    for (let page = 0; page < 40 && url; page++) { const j = await json(url, {}, 60000); for (const t of j.results || []) if (/^[A-Z][A-Z.\-]{0,9}$/.test(t.ticker)) out.push([t.ticker, t.name || "", t.primary_exchange || "", t.type === "ETF" ? 1 : 0, 0]); url = j.next_url ? `${j.next_url}&apiKey=${this.key}` : null; }
    return out;
  }
}
// What the process is configured with, from the environment. MARKET_STREAM picks the live provider; keys stay on the server.
export function engineFromEnv(env = process.env, extra = {}) {
  const provider = (env.MARKET_STREAM || env.DATA_PROVIDER === "polygon" && "polygon" || "none").toLowerCase();
  if (provider === "alpaca") return new MarketEngine({ provider, keys: { key: env.APCA_API_KEY_ID || env.ALPACA_KEY, secret: env.APCA_API_SECRET_KEY || env.ALPACA_SECRET }, alpacaFeed: (env.ALPACA_FEED || "iex").toLowerCase(), url: env.ALPACA_STREAM_URL || undefined, ...extra }); // ALPACA_STREAM_URL: the sandbox test stream (wss://stream.data.alpaca.markets/v2/test, symbol FAKEPACA) or a local fake
  if (provider === "polygon" || provider === "massive") return new MarketEngine({ provider: "polygon", keys: { key: env.POLYGON_KEY || env.MASSIVE_KEY }, delayed: env.POLYGON_DELAYED === "1", url: env.POLYGON_STREAM_URL || undefined, ...extra });
  return new MarketEngine({ provider: "none", ...extra });
}
export function restFromEnv(env = process.env) {
  const provider = (env.MARKET_STREAM || env.DATA_PROVIDER === "polygon" && "polygon" || "none").toLowerCase();
  if (provider === "alpaca" && (env.APCA_API_KEY_ID || env.ALPACA_KEY)) return new AlpacaRest({ key: env.APCA_API_KEY_ID || env.ALPACA_KEY, secret: env.APCA_API_SECRET_KEY || env.ALPACA_SECRET, feed: (env.ALPACA_FEED || "iex").toLowerCase() === "sip" ? "sip" : "iex" });
  if ((provider === "polygon" || provider === "massive") && (env.POLYGON_KEY || env.MASSIVE_KEY)) return new PolygonRest({ key: env.POLYGON_KEY || env.MASSIVE_KEY, base: env.POLYGON_BASE || "https://api.polygon.io" });
  return null;
}
