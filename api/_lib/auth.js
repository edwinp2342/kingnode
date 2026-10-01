// Signed access tokens. payload = { c: stripeCustomerId, p: "monthly"|"yearly", e: expiresUnix }
import { createHmac, timingSafeEqual } from "node:crypto";

const secret = () => process.env.APP_SECRET || "";
const b64u = s => Buffer.from(s).toString("base64url");
const sign = body => createHmac("sha256", secret()).update(body).digest("base64url");

export function issueToken(customer, plan, days = 7) {
  const body = b64u(JSON.stringify({ c: customer, p: plan, e: Math.floor(Date.now() / 1000) + days * 86400 }));
  return body + "." + sign(body);
}

/** Returns the payload, or null. allowExpired lets /api/refresh renew a lapsed token. */
export function readToken(token, { allowExpired = false } = {}) {
  if (!secret() || typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const good = sign(body);
  if (good.length !== sig.length || !timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!p.c || !p.p) return null;
    if (!allowExpired && p.e < Date.now() / 1000) return null;
    if (allowExpired && p.e < Date.now() / 1000 - 30 * 86400) return null; // renewals allowed for 30 days
    return p;
  } catch { return null; }
}

export function body(req) {
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}
