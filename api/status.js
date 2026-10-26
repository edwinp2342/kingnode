// The data tier's state: which provider, what kind of feed (iex / sip / delayed / snapshot), connection state, subscriptions, freshness, errors.
// The app shows this in Data status and decides its indicator from it. Never caches.
export default async function handler(req, res) {
  const kn = globalThis.__kingnode;
  const st = kn?.engine ? kn.engine.status() : { provider: "none", feedType: "none", state: "disabled", realtime: false, consolidated: false };
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ at: Date.now(), stream: st, rest: kn?.rest ? (kn.rest.constructor.name === "AlpacaRest" ? "alpaca" : "polygon") : null, uptimeMs: kn ? Date.now() - kn.startedAt : null, hostedOn: process.env.VERCEL ? "vercel (no streaming — serverless)" : "node" });
}
