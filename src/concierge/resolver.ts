import type { BookingRail } from "./rail";
import type { BookingIntent, RailSlot, ManifestItem, BookingManifest, ConciergeTenant } from "./types";

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
  return null;
}

export interface ResolveDiningArgs {
  tripId: string;
  tenant: ConciergeTenant;
  intents: BookingIntent[];
  rail: BookingRail;
  proposals: ProposalSource;
}

export async function resolveDining(args: ResolveDiningArgs): Promise<BookingManifest> {
  const items: ManifestItem[] = [];
  for (const intent of args.intents) {
    // Fail loud if a non-dining category reaches the dining resolver.
    if (intent.category !== "dining") {
      throw new Error(`resolveDining received non-dining intent ${intent.itemId} (${intent.category})`);
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
