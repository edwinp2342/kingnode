# Kingnode market data — how prices reach the screen

Kingnode runs in two shapes. Both use the same app (`app.html`); they differ in where the numbers come from.

| | GitHub Pages (edwinp2342.github.io/kingnode) | Your own server (`npm run serve`, the desktop app, a VPS) |
|---|---|---|
| Prices | The feed: a GitHub Actions loop writes quotes, bars and chains to the `data` branch; the page polls it | The feed as the floor, plus a **streaming tier**: one WebSocket to a provider, fanned out to every tab |
| Latency | 20–45 s behind the tape in regular hours (feed cadence 20 s + CDN) | Tick-level: trades arrive as they print, coalesced to 4 updates/s per symbol |
| Feed type | Yahoo's delayed chart data, labelled "feed" | Alpaca IEX (real-time, one exchange's prints) or SIP (consolidated) · Polygon/Massive SIP or delayed — labelled as such |
| Sessions | pre · regular · after hours · overnight (24-hour price, sampled every minute) | The provider's stream (Alpaca and Polygon carry pre/regular/post; overnight comes from the feed's 24-hour sample) |
| Options chains | Cboe, 15-minute delayed | Same, or Tradier/Polygon real-time with `DATA_PROVIDER` |

The architecture of the streaming tier, as built:

```
provider WebSocket (Alpaca / Polygon)            REST (bars, snapshots, assets)
        │                                                │
   server/market.mjs — MarketEngine                      │
   · one upstream socket, auth, exponential-backoff      │
     reconnect (1 s → 60 s), resubscribe                 │
   · normalize → validate (ordering, trade conditions)   │
   · CandleBuilder: trades → forming 1-minute bar;       │
     provider bars are the final word                    │
   · in-memory store per symbol; stale detection         │
     (90 s quiet in market hours → "stale")              │
        │                                                │
   server/hub.mjs — WebSocket hub at /ws        api/quotes.js · api/bars.js · api/symbols.js · api/status.js
   · ref-counted subscriptions across tabs               (REST answers name their source and feed type)
   · snapshot on subscribe, ticks coalesced (250 ms),
     bars and status immediately, heartbeat 10 s
        │
   app.html — streaming client
   · subscribes to the symbol on screen + SPY/QQQ/IWM/DIA
   · ticks → header, tape, forming candle; closed minutes → the series
   · badge: STREAM · IEX real-time | SIP real-time | delayed | reconnecting | stale
   · the polling feed keeps running underneath; a streamed print is never replaced by an older polled one
```

## Providers

| Provider | Stream | What the free/base plan gives | Env |
|---|---|---|---|
| **Alpaca** (`MARKET_STREAM=alpaca`) | `wss://stream.data.alpaca.markets/v2/iex` | Real-time **IEX** trades/quotes/bars, 30 stream symbols, 200 REST calls/min, historical bars (IEX; SIP with a 15-minute lag on the free plan). A free account at alpaca.markets gives keys in minutes. `ALPACA_FEED=sip` once you pay for the consolidated tape. | `ALPACA_KEY`, `ALPACA_SECRET` (or `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY`), `ALPACA_FEED=iex|sip` |
| **Polygon / Massive** (`MARKET_STREAM=polygon` or `massive`) | `wss://socket.polygon.io/stocks` (delayed plans: `wss://delayed.polygon.io/stocks` with `POLYGON_DELAYED=1`) | Consolidated SIP on real-time plans; the starter plan is 15-minute delayed and is labelled "delayed" here. Full reference tickers. Check current plan limits before relying on a tier. | `POLYGON_KEY` (or `MASSIVE_KEY`), `POLYGON_DELAYED=1` on a delayed plan |
| none | — | The GitHub feed only (what the public site uses) | — |

**Why Alpaca first.** It is the only provider in the list with a free real-time stream, keys take two minutes, the stream protocol is simple and well documented, and its limits (30 symbols, one connection per account) fit a one-person terminal that watches a handful of names. Its catch is in the name of the badge: IEX is one exchange, roughly 2–3% of US volume, so the last print can differ from your broker's consolidated last by a tick; the app never calls it SIP. Polygon/Massive is the upgrade path when you want the consolidated tape — same engine, one environment variable.

Indices (SPX, NDX, RUT, VIX, XSP) are not on either stock stream; they stay on the feed (Yahoo, delayed).

## Running it

```
npm install
MARKET_STREAM=alpaca ALPACA_KEY=… ALPACA_SECRET=… npm run serve     # http://127.0.0.1:4810/app.html
```
or put the keys in `.env.local` (see `.env.example`). The desktop app (`cd desktop && npm start`) starts the same server. To stream into the GitHub Pages site, run the server somewhere reachable and set its `wss://host/ws` as **Stream URL** in ⚙ Settings. Keys never leave the server: the browser only ever sends symbol names.

`HOST=0.0.0.0` binds to all interfaces for a VPS; put it behind HTTPS (Caddy, Cloudflare Tunnel) so the page on github.io can open a `wss://` socket to it.

Without credentials: `node test/fake-upstream.mjs 4899` and `MARKET_STREAM=alpaca ALPACA_KEY=x ALPACA_SECRET=y ALPACA_STREAM_URL=ws://127.0.0.1:4899 npm run serve` drive the whole path with a synthetic random walk (every price starts at 100 — unmistakably not market data). Alpaca's own sandbox stream is `ALPACA_STREAM_URL=wss://stream.data.alpaca.markets/v2/test` with the symbol `FAKEPACA`.

## Endpoints

- `GET /api/status` — provider, feed type, connection state (idle/connecting/live/stale/reconnecting/error/disabled), subscriptions, last message age, recent errors.
- `GET /api/quotes?symbols=…` — the engine's live record when it has one (`realtime: true`, `feedType`), else the provider's REST snapshot, else Yahoo (`feedType: "delayed"`). Unknown symbols come back with `error`.
- `GET /api/bars?symbol=&interval=1m|5m|15m|30m|1h|4h|1d|1w|1M&range=1d|5d|1mo|3mo|6mo|ytd|1y|5y|max&extended=1` — provider history with `source` and `feedType`; a provider 429 is passed through as 429 with `Retry-After`.
- `GET /api/symbols?q=` — the market-wide symbol table (Alpaca assets / Polygon reference tickers, else the feed's Nasdaq Trader + Cboe directory), cached a day.
- `WS /ws` — `{op:"sub"|"unsub", syms:[…]}`, `{op:"ping"}`; messages `hello`, `snap`, `tick`, `bar`, `bbo`, `status`, `hb`, `error`.

## What is and is not verified

Verified here (`npm test`, 27 tests, all passing): message normalization for both providers, candle construction from trades (late and out-of-order prints), provider bars replacing trade-built bars, ref-counted subscriptions, reconnection with backoff and resubscription, stale detection that respects the market clock, auth failure and missing credentials, hub fan-out with coalescing and heartbeats, the browser client end to end against a fake upstream (header, tape, forming candle, symbol switch).

Not verified, because this environment has no provider credentials and cannot reach the providers: the live Alpaca/Polygon authentication handshake, their exact REST field names at the edges (the adapters follow the published docs), plan limits (30 symbols, one connection) as enforced today, and prices against the consolidated tape. The first run with real keys is the verification step: open `/api/status`, watch for `state: "live"`, compare the header with your broker.
