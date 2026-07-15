import type { BookingRail } from "./rail";
import type { BookingIntent, RailSlot, ManifestItem, BookingManifest } from "./types";

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
  tenant: string;
  intents: BookingIntent[];
  rail: BookingRail;
  proposals: ProposalSource;
}

export async function resolveDining(args: ResolveDiningArgs): Promise<BookingManifest> {
  const items: ManifestItem[] = [];
  for (const intent of args.intents) {
    const candidates = await args.rail.search(intent.query);
    const ranked = await args.proposals.rank(intent, candidates);
    const chosen = ranked.find((c) => validateChoice(intent, c) === null) ?? null;
    items.push({ intent, candidates, chosen, rail: args.rail.railId });
  }
  return { tripId: args.tripId, tenant: args.tenant, items };
}
