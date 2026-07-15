import { MockRail } from "./mock-rail";
import { resolveDining, resolveActivities, resolveManifest, DeterministicProposalSource } from "./resolver";
import { Orchestrator, InMemoryBookingStore } from "./orchestrator";
import { InMemoryAuditLog } from "./audit";
import type { SagaResult, StagedResult } from "./orchestrator";
import type { SpendCaps } from "./caps";
import type { AuditEntry } from "./audit";
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

export interface SagaDryRunArgs {
  tripId: string;
  tenant: ConciergeTenant;
  intents: BookingIntent[];
  now: string; // ISO8601
  priceCents?: number;
}

/** Wires Resolver(activity) + saga Orchestrator + paid MockRail + in-memory store + audit —
 *  zero external calls. The CI-provable Phase 1 "activity itinerary -> confirmed bookings,
 *  with compensation available on failure" loop. */
export async function runConciergeSagaDryRun(
  args: SagaDryRunArgs,
): Promise<{ manifest: BookingManifest; saga: SagaResult; audit: AuditEntry[] }> {
  const rail = new MockRail({ priceCents: args.priceCents ?? 8500 });
  const manifest = await resolveActivities({
    tripId: args.tripId,
    tenant: args.tenant,
    intents: args.intents,
    rail,
    proposals: new DeterministicProposalSource(),
  });
  const audit = new InMemoryAuditLog();
  const saga = await new Orchestrator(rail, new InMemoryBookingStore(), audit).executeSaga(manifest, {
    lead: { leadName: "Trip Lead", leadEmail: "lead@example.com" },
    now: args.now,
  });
  return { manifest, saga, audit: await audit.entries(args.tripId) };
}

export interface StagedDryRunArgs {
  tripId: string;
  tenant: ConciergeTenant;
  intents: BookingIntent[];
  now: string; // ISO8601
  priceCents?: number;
  caps?: SpendCaps;
}

/** Wires resolveManifest + staged Orchestrator + paid MockRail + in-memory store + audit —
 *  zero external calls. The CI-provable Phase 2a "hold-all → cap-check → commit-shortest-TTL-first
 *  → unwind-on-failure" loop for a mixed lodging+activity itinerary. */
export async function runConciergeStagedDryRun(
  args: StagedDryRunArgs,
): Promise<{ manifest: BookingManifest; staged: StagedResult; audit: AuditEntry[] }> {
  const rail = new MockRail({ priceCents: args.priceCents ?? 8500 });
  const manifest = await resolveManifest({
    tripId: args.tripId,
    tenant: args.tenant,
    intents: args.intents,
    rail,
    proposals: new DeterministicProposalSource(),
  });
  const audit = new InMemoryAuditLog();
  const staged = await new Orchestrator(rail, new InMemoryBookingStore(), audit).executeStaged(manifest, {
    lead: { leadName: "Trip Lead", leadEmail: "lead@example.com" },
    now: args.now,
    caps: args.caps,
  });
  return { manifest, staged, audit: await audit.entries(args.tripId) };
}
