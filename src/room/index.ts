/**
 * Trip Room — shared backend + headless hooks.
 *
 * Split into:
 *   - ./types      — framework-agnostic shapes (VoteSlot, PlaceholderItem,
 *                    ExternalBooking, TripRoomMember, PersonalItem,
 *                    TripRoomState, RoomStoredPlan)
 *   - ./tables     — wp_* Supabase table-name constants
 *   - ./slug       — generate / validate / reserve / resolve / update
 *   - ./booking-deeplinks — partner URL builders (refcode arg)
 *   - ./auth       — isOwnerForPlan + anonDisplayName (pure functions)
 *   - ./context    — RoomContext interface consumed by handlers
 *   - ./handlers/* — Web-API-compatible route handlers (thin wrappers per
 *                    repo inject their own kv/supabase/auth/redis/email)
 *   - ./hooks/*    — headless React hooks + `roomApi` fetch helpers
 */

export * from "./types";
export * from "./tables";
export * from "./auth";
export * from "./slug";
export * from "./booking-deeplinks";
export * from "./context";
export * from "./handlers";
export * from "./hooks";
export * from "./itemized-budget";
export * from "./viewmodel";
export * from "./expenses";
export * from "./email-parsers";
export * from "./email-ingest";
