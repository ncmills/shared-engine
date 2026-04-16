/**
 * Supabase table names for wedding-planning data (MOH + BESTMAN).
 *
 * 2026-04-22 — renamed with `wp_` prefix so the shared Supabase project can
 * host both wedding-planning data AND DoppelWriter/Peptide Stack/IDHW/IMF
 * lead-capture tables without ambiguity. See
 * ~/shared-data/migrations/2026-04-22-wp-namespace-rename.sql.
 *
 * Always import `TABLES.*` in handlers — never hard-code table names — so
 * a future rename stays a one-line change here.
 */
export const TABLES = {
  // Trip Room V1.2
  members: "wp_trip_room_members",
  slotVotes: "wp_trip_room_slot_votes",
  personalItems: "wp_trip_room_personal_items",

  // Signal capture (2026-04-16 signal-tables migration)
  activity: "wp_trip_room_activity",
  planInputs: "wp_plan_inputs",
  planSelections: "wp_plan_selections",
  surpriseMeActions: "wp_surprise_me_actions",
  planBookmarks: "wp_plan_bookmarks",
  offerClicks: "wp_offer_clicks",
  offerConversions: "wp_offer_conversions",
  acquisitionLog: "wp_acquisition_log",
  signalRateLimit: "wp_signal_rate_limit",
} as const;

export type WpTableKey = keyof typeof TABLES;
