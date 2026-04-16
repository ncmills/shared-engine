/**
 * Trip Room V1.2 — handler execution context.
 *
 * Every handler in shared-engine takes a `RoomContext` so nothing imports
 * app-specific paths (`@/lib/*`). Each repo's thin wrappers inject its
 * own kv/supabase/auth/redis integrations.
 *
 * This keeps the handlers framework-light: they only import Web API types
 * from `next/server` + the context, never repo-scoped code.
 */

import type { BrandId } from "../types";
import type { RoomStoredPlan } from "./types";
import type { RedisLike } from "./slug";

/**
 * Supabase client injected by the consumer repo. Typed as `any`-shaped here
 * (each repo already type-checks its own `createClient(...)`) so the shared
 * lib stays off the @supabase/supabase-js direct dep list.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SupabaseLike = any;

export interface RoomLogSignalFn {
  (req: Request, table: string, payload: Record<string, unknown>): void;
}

export interface RoomComputeSessionIdFn {
  (req: Request): string;
}

export interface RoomKvApi {
  getPlan(planId: string): Promise<RoomStoredPlan | null>;
  storePlan(plan: RoomStoredPlan): Promise<void>;
}

export interface RoomAuthApi {
  /** Resolves the current session's email (cookie-based). null when anonymous. */
  getSessionEmail(): Promise<string | null>;
  /** Create a magic-link token for the given email + return the opaque token. */
  createMagicToken(email: string): Promise<string>;
  /** Look up the stored user display name for an email (optional). */
  getUserName?(email: string): Promise<string | null>;
}

export interface RoomEmailApi {
  sendCoOwnerInviteEmail(args: {
    toEmail: string;
    fromName: string;
    honoree: string;
    tripName: string;
    note?: string;
    claimUrl: string;
  }): Promise<unknown>;
}

export interface RoomContext {
  brand: BrandId;
  /** Brand-specific tagline used on the invite-email copy fallback. */
  honoreeFieldKey: "bridePersonality" | "groomPersonality";
  /** Default tripName when destinations block is missing. */
  tripNameFallback: (honoree: string) => string;
  /** Default sender name when organizerName is blank + user name lookup fails. */
  defaultFromName: string;
  /** Default honoree noun when inputs.<honoreeFieldKey> is blank. */
  defaultHonoree: string;
  /** Dev host used when RESEND / host headers are missing. Matches each repo's dev port. */
  devBaseUrl: string;

  kv: RoomKvApi;
  auth: RoomAuthApi;
  email?: RoomEmailApi;
  redis: RedisLike;
  supabase: SupabaseLike | null;
  logSignal: RoomLogSignalFn;
  computeSessionId: RoomComputeSessionIdFn;
}
