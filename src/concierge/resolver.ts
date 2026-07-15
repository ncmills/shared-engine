import type { BookingRail } from "./rail";
import type { BookingIntent, RailSlot, ManifestItem, BookingManifest, ConciergeTenant, BookingCategory } from "./types";

/** Ranks candidate slots for an intent. The LLM implementation slots in here later;
 *  it may ONLY rank/propose — it never books. */
export interface ProposalSource {
  rank(intent: BookingIntent, candidates: RailSlot[]): Promise<RailSlot[]>;
}

export class DeterministicProposalSource implements ProposalSource {
  async rank(intent: BookingIntent, candidates: RailSlot[]): Promise<RailSlot[]> {
    return [...candidates].sort(
      (a, b) => a.priceCents - b.priceCents || a.startsAt.localeCompare(b.startsAt),
    );
  }
}

/** Deterministic guardrail. Returns an error string if the choice is invalid, else null. */
export function validateChoice(intent: BookingIntent, chosen: RailSlot): string | null {
  const max = intent.query.maxPriceCents;
  if (max != null && chosen.priceCents > max) {
    return `price ${chosen.priceCents} exceeds max ${max}`;
  }
  if (!chosen.cancellation) return "missing cancellation policy";
  // Money-safety: a PAID item that claims to be refundable must carry a concrete refund
  // term (a free-cancel deadline OR a refund amount). Dining (priceCents 0) is exempt.
  if (chosen.priceCents > 0) {
    const c = chosen.cancellation;
    if (c.refundable && c.freeCancelUntil == null && (c.refundAmountCents == null || c.refundAmountCents === 0)) {
      return "refundable policy missing a free-cancel deadline and refund amount";
    }
  }
  return null;
}

export interface ResolveArgs {
  tripId: string;
  tenant: ConciergeTenant;
  intents: BookingIntent[];
  rail: BookingRail;
  proposals: ProposalSource;
}
/** @deprecated alias kept for Phase 0 callers */
export type ResolveDiningArgs = ResolveArgs;

async function resolveForCategory(category: BookingCategory, args: ResolveArgs): Promise<BookingManifest> {
  const items: ManifestItem[] = [];
  for (const intent of args.intents) {
    // Fail loud if a mismatched category reaches this resolver.
    if (intent.category !== category) {
      throw new Error(`resolve for ${category} received non-${category} intent ${intent.itemId} (${intent.category})`);
    }
    const candidates = await args.rail.search(intent.query);
    // Provenance guard: a chosen slot MUST be one the rail actually returned.
    // The proposer may reorder/filter candidates but can never inject a fabricated slot.
    const byId = new Map(candidates.map((c) => [c.railSlotId, c]));
    const ranked = await args.proposals.rank(intent, candidates);
    const chosen =
      ranked
        .map((c) => byId.get(c.railSlotId))
        .find((c): c is RailSlot => c != null && validateChoice(intent, c) === null) ?? null;
    items.push({ intent, candidates, chosen, rail: args.rail.railId });
  }
  return { tripId: args.tripId, tenant: args.tenant, items };
}

export async function resolveDining(args: ResolveArgs): Promise<BookingManifest> {
  return resolveForCategory("dining", args);
}

export async function resolveActivities(args: ResolveArgs): Promise<BookingManifest> {
  return resolveForCategory("activity", args);
}
