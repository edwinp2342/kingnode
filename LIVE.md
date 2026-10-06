# Getting off demo mode

Demo mode means the browser couldn't fetch the chain. The **Data status** card (right rail) says which feed failed. Three ways to make it live, cheapest first.

## A. Local server on your laptop (2 commands, full features)
    cd kingnode/desktop && npm install
    npm run serve          # then open the URL it prints (http://127.0.0.1:4810/app.html)
Node fetches the data, so there's no browser CORS problem. Everything works, including Institutions. Runs only while the terminal window is open.

## B. Free Cloudflare proxy (10 minutes, works from the website and the phone, no laptop needed)
Cboe/Yahoo sometimes refuse browser requests from github.io. A tiny proxy fixes it.
1. https://dash.cloudflare.com → Workers & Pages → Create → Start with Hello World → Edit code.
2. Paste `proxy/cloudflare-worker.js` over it → Deploy. Copy the worker URL.
3. In Kingnode: ⚙ Settings → **Data proxy URL** → paste → Save.
The app routes chain, bars (Yahoo, with extended hours), quotes, insider and short-volume calls through it. Free tier: 100,000 requests/day — far more than you'll use.

## C. Real-time instead of 15-minute delayed
Set `DATA_PROVIDER=polygon` + `POLYGON_KEY` (or Tradier) in `.env.local` and run A. The delayed feed becomes a live one; the chain updates every refresh interval.

If the status card still shows red after B, screenshot it plus the console (F12) and send it.
