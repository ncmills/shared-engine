/**
 * First-party visitor id (`vid`) — the join key that connects the three
 * otherwise-disconnected identity spaces:
 *   1. anonymous behavior  (daily-rotating session_id on wp_* signal tables)
 *   2. anonymous plans     (planId in Redis / localStorage)
 *   3. captured email      (wp_leads row)
 *
 * The `vid` is a random v4 UUID set as a long-lived, first-party cookie by
 * each site's middleware. It carries NO identity content on its own — it is
 * an opaque random token — so it is explicitly NOT PII and must never be run
 * through stripPII(). Stamp it on every signal payload, every generated
 * planId, and every wp_leads upsert; then behavior ↔ plans ↔ email all join
 * on a single key, and a complete behavioral profile can be retroactively
 * attached to an email the moment it is captured (possibly visits later).
 *
 * Purely first-party (no third-party cookie) => ITP / privacy-safe and
 * unaffected by third-party cookie deprecation.
 *
 * Isomorphic: no imports, relies only on the global Web Crypto API
 * (available in browsers, Node 19+, and the edge runtime).
 */

/** Cookie name. Stable — changing it orphans existing visitors. */
export const VID_COOKIE = "wp_vid";

/** ~13 months in seconds (max practical first-party cookie lifetime). */
export const VID_MAX_AGE = 60 * 60 * 24 * 400;

/** Canonical UUID v4 shape. Used to reject malformed / spoofed values. */
const VID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when `v` is a well-formed v4 UUID. */
export function isValidVid(v: unknown): v is string {
  return typeof v === "string" && VID_RE.test(v);
}

/** Mint a new visitor id. */
export function newVid(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Read the `vid` out of a raw Cookie header (server / middleware) or a
 * `document.cookie` string (client). Returns null when absent or malformed.
 *
 * @param cookieHeader e.g. `req.headers.get("cookie")` or `document.cookie`
 */
export function readVid(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== VID_COOKIE) continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    return isValidVid(value) ? value : null;
  }
  return null;
}
