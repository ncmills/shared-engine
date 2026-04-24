/**
 * Trip Room H3.1 — append an email-sourced Candidate to a plan.
 *
 * The inbound-email webhook route parses an incoming email via
 * `parseInboundEmail` (or the LLM fallback), then calls this helper to
 * authorize the sender + mutate the plan. Bypasses the session-cookie
 * auth that `handleAddCandidate` relies on — emails don't carry cookies.
 *
 * Authorization rule (matches reference_room_auth_model.md):
 *   sender email ∈ { plan.inputs.organizerEmail } ∪
 *                   SELECT user_email FROM wp_trip_room_members
 *                   WHERE plan_id = :planId
 *
 * Silent no-op on Supabase outage for member lookups — owner-only email
 * ingest still works.
 */

import type { RoomContext } from "./context";
import type {
  Candidate,
  CandidateCategory,
  ExternalBooking,
  RoomStoredPlan,
} from "./types";
import type { EmailCandidateSeed } from "./email-parsers";

export type IngestReason =
  | "plan-not-found"
  | "sender-not-authorized"
  | "internal-error";

export interface IngestResult {
  ok: boolean;
  reason?: IngestReason;
  candidateId?: string;
}

export async function ingestEmailCandidate(
  ctx: RoomContext,
  planId: string,
  seed: EmailCandidateSeed
): Promise<IngestResult> {
  let plan: RoomStoredPlan | null;
  try {
    plan = await ctx.kv.getPlan(planId);
  } catch {
    return { ok: false, reason: "internal-error" };
  }
  if (!plan) return { ok: false, reason: "plan-not-found" };

  const authorized = await isSenderAuthorized(ctx, plan, planId, seed.senderEmail);
  if (!authorized) return { ok: false, reason: "sender-not-authorized" };

  const now = new Date().toISOString();
  const id = `cand_${crypto.randomUUID()}`;
  const senderLower = seed.senderEmail.toLowerCase();

  const candidate: Candidate = {
    id,
    category: seed.category,
    source: "email",
    title: seed.title,
    description: seed.description,
    imageUrl: seed.imageUrl,
    url: seed.url,
    price: seed.price,
    providerName: seed.providerName,
    addedBy: senderLower,
    addedAt: now,
    notes: seed.notes,
  };

  const externalBooking: ExternalBooking = {
    id,
    type: categoryToExternalBookingType(seed.category),
    name: seed.title,
    url: seed.url,
    price: seed.price,
    notes: seed.notes,
    addedBy: senderLower,
    addedAt: now,
  };

  plan.candidates = [...(plan.candidates ?? []), candidate];
  plan.externalBookings = [...(plan.externalBookings ?? []), externalBooking];

  try {
    await ctx.kv.storePlan(plan);
  } catch {
    return { ok: false, reason: "internal-error" };
  }

  return { ok: true, candidateId: id };
}

async function isSenderAuthorized(
  ctx: RoomContext,
  plan: RoomStoredPlan,
  planId: string,
  senderEmail: string
): Promise<boolean> {
  const sender = senderEmail.toLowerCase();
  const ownerEmail = (plan.inputs?.organizerEmail ?? "").trim().toLowerCase();
  if (sender && sender === ownerEmail) return true;

  if (!ctx.supabase) return false;
  try {
    const { data } = await ctx.supabase
      .from("wp_trip_room_members")
      .select("user_email")
      .eq("plan_id", planId)
      .eq("user_email", sender)
      .limit(1);
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

function categoryToExternalBookingType(
  category: CandidateCategory
): ExternalBooking["type"] {
  switch (category) {
    case "lodging": return "lodging";
    case "activities": return "activity";
    case "dining": return "dining";
    case "bars": return "bars";
    case "transport": return "transport";
    case "flights":
    default:
      return "other";
  }
}
