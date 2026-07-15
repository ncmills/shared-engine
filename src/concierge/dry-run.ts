import { MockRail } from "./mock-rail";
import { resolveDining, DeterministicProposalSource } from "./resolver";
import { Orchestrator, InMemoryBookingStore } from "./orchestrator";
import type { BookingIntent, BookingManifest, BookingResult, ConciergeTenant } from "./types";

export interface DryRunArgs {
  tripId: string;
  tenant: ConciergeTenant;
  intents: BookingIntent[];
}

/** Wires Resolver + Orchestrator + MockRail + in-memory store — zero external calls.
 *  This is the CI-provable "itinerary -> real bookings" loop for Phase 0. */
export async function runConciergeDryRun(
  args: DryRunArgs,
): Promise<{ manifest: BookingManifest; results: BookingResult[] }> {
  const rail = new MockRail();
  const manifest = await resolveDining({
    tripId: args.tripId,
    tenant: args.tenant,
    intents: args.intents,
    rail,
    proposals: new DeterministicProposalSource(),
  });
  const results = await new Orchestrator(rail, new InMemoryBookingStore()).execute(manifest, {
    lead: { leadName: "Trip Lead", leadEmail: "lead@example.com" },
  });
  return { manifest, results };
}
