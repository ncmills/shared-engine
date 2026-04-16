/**
 * Signal capture — fire-and-forget logging of meaningful user actions
 * into the long-term Supabase store. Pairs with each site's
 * /api/signals route which validates + scrubs PII + writes to Supabase.
 *
 * Design: logSignal MUST NEVER throw or block UX. All errors are
 * swallowed; analytics failures don't stop user flow.
 *
 * Allowed signal table names (must match the route's allow-list):
 *   plan_inputs            — fires once per plan_generated, full WizardState
 *   surprise_me_actions    — fires on Surprise Me click + on later override
 *   plan_selections        — fires when user picks a tier or a destination
 *   plan_bookmarks         — fires when user pins/saves an itinerary item
 *   offer_clicks           — fires on affiliate offer click (R1+ feature)
 *   offer_conversions      — fires from network postback (R1+ feature)
 *   trip_room_activity     — fires on collaborative-room edits (R3+ feature)
 *   acquisition_log        — fires on first session pageview with q/referrer
 */

export type SignalTable =
  | "plan_inputs"
  | "surprise_me_actions"
  | "plan_selections"
  | "plan_bookmarks"
  | "offer_clicks"
  | "offer_conversions"
  | "trip_room_activity"
  | "acquisition_log";

export type Brand = "moh" | "bestman" | "tdf";

/**
 * Map the public SignalTable name (client-facing, stable) to the physical
 * wp_* Supabase table (renamed 2026-04-22 for wedding-planning tables).
 *
 * Keep the public API on the unprefixed names so nothing forces a client
 * redeploy if the DB layout ever shifts again.
 */
export function resolveSignalTableName(table: SignalTable): string {
  switch (table) {
    case "plan_inputs":          return "wp_plan_inputs";
    case "surprise_me_actions":  return "wp_surprise_me_actions";
    case "plan_selections":      return "wp_plan_selections";
    case "plan_bookmarks":       return "wp_plan_bookmarks";
    case "offer_clicks":         return "wp_offer_clicks";
    case "offer_conversions":    return "wp_offer_conversions";
    case "trip_room_activity":   return "wp_trip_room_activity";
    case "acquisition_log":      return "wp_acquisition_log";
  }
}

export interface SignalPayload {
  brand: Brand;
  [key: string]: unknown;
}

/**
 * Client-side fire-and-forget signal logger.
 * Returns immediately; the network request runs in the background and
 * any failure is silently dropped. NEVER awaited inside UI flow.
 */
export function logSignal(table: SignalTable, payload: SignalPayload): void {
  try {
    void fetch("/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table, payload }),
      // keepalive lets the request survive page navigation / unload —
      // critical for "user clicked offer + immediately left" emits.
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Total fallthrough — never break UX for analytics.
  }
}

/**
 * Strip PII from any payload before it's persisted long-term. Email +
 * organizer name + freeform text fields that could carry contact info
 * are removed. The corresponding session_id (set server-side from a
 * rolling daily hash of IP + UA) is the analytic identifier.
 *
 * Pure helper — exported for use in /api/signals route handlers.
 */
export function stripPII<T extends Record<string, unknown>>(payload: T): T {
  const banned = new Set([
    "email", "organizerEmail", "organizerName",
    "authPassword", "password",
    "specialRequests", // freeform; could carry contact info
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (banned.has(k)) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = stripPII(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
