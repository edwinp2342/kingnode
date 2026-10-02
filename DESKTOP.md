# Kingnode on your laptop

Two ways. The first takes one click; the second gives you the full server (Institutions, Discord alerts, Ask the desk) running locally.

## 1. Install the web app (one click, no code)
Open https://edwinp2342.github.io/kingnode/app.html in **Chrome or Edge**, then click the install icon at the right end of the address bar (a monitor with a down-arrow) → **Install**. Kingnode opens in its own window with its own dock/taskbar icon, launches instantly, and keeps your settings, positions and Heatseeker snapshots.

Safari (Mac): File → **Add to Dock**.

Same features as the site: chain, Heatseeker, ladder, derived flow, Playbook — all on the free 15-min delayed feed.

## 2. Desktop app with the full server (Electron)
Requires Node 18+ (https://nodejs.org).

    unzip kingnode.zip && cd kingnode/desktop
    npm install
    npm start

A Kingnode window opens, backed by a local server on 127.0.0.1 that runs every `api/*.js` handler. Put your keys in `kingnode/.env.local` (copy `.env.example`) to turn on:
- `ANTHROPIC_API_KEY` → Ask the desk
- `DISCORD_WEBHOOK` + `NOTIFY_OPEN=true` → ⚑ Flag and flow/level alerts to Discord
- `SEC_USER_AGENT` → insider filings; FINRA short volume works with no key
- `DATA_PROVIDER=tradier` or `polygon` + key → real-time chain and bars instead of Cboe delayed
- `FLOW_SECRET` → the collector can ship live prints to the local app

Headless (any browser, no Electron): `npm run serve` then open the printed URL.

Build an installer (.dmg / .exe / AppImage): `npm run dist` → `desktop/dist/`.

## Which one?
Use **1** tomorrow. Use **2** when you add a vendor key or want the Institutions tab and Discord alerts.
