import { MockRail } from "./mock-rail";
import { LiteAPIAdapter } from "./liteapi-adapter";
import { buildLodgingDeeplink } from "./lodging-deeplink";
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

/** Deterministic in-process LiteAPI sandbox (zero network). Returns a single refundable, priced
 *  lodging offer per search whose PREBOOK price equals its SEARCH price — the clean happy path.
 *  (Price drift is proven in the adapter + checkPriceDrift unit tests, not here.) Ids are derived
 *  from the request so distinct areas yield distinct offer/prebook/booking refs. */
export function liteApiSandboxFetch(): typeof fetch {
  return (async (url: any, init?: any) => {
    const u = String(url);
    const m = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

    if (u.endsWith("/rates") && m === "POST") {
      // Offer identity includes area + checkin + guests so two intents in the SAME area (different
      // dates/party) don't collapse to one offer/prebook/booking ref (which would mask a double-book).
      const id = `off-${String(body.area ?? "x").replace(/\s+/g, "-")}-${String(body.checkin ?? "")}-${String(body.guests ?? "")}`;
      return json({ offers: [{ offerId: id, name: `${body.area} Villa`, price: { amount: 450.0, currency: "USD" }, checkin: body.checkin, refundable: true, freeCancelUntil: "2026-07-28T00:00:00Z" }] });
    }
    if (u.endsWith("/rates/prebook") && m === "POST") {
      return json({ prebookId: `pre-${body.offerId}`, price: { amount: 450.0, currency: "USD" }, expiresAt: "2999-01-01T00:00:00.000Z", refundable: true, freeCancelUntil: "2026-07-28T00:00:00Z" });
    }
    if (u.endsWith("/rates/book") && m === "POST") {
      return json({ bookingId: `book-${body.prebookId}`, confirmation: `LITE-${body.prebookId}`, price: { amount: 450.0, currency: "USD" } });
    }
    if (u.includes("/bookings/") && m === "PUT") return json({ refund: { amount: 450.0, currency: "USD" } });
    if (u.includes("/bookings/") && m === "GET") return json({ status: "CONFIRMED" });
    return json({});
  }) as unknown as typeof fetch;
}

export interface LodgingDryRunArgs {
  tripId: string;
  tenant: ConciergeTenant;
  intents: BookingIntent[];
  now: string; // ISO8601
  /** Override the LiteAPI transport; defaults to the built-in deterministic sandbox (no network). */
  fetchImpl?: typeof fetch;
}

/** Wires the LiteAPIAdapter (built-in sandbox fetch) + resolveManifest + staged Orchestrator +
 *  in-memory store + audit, then builds a guest-facing villa deeplink for every CONFIRMED booking.
 *  The CI-provable Phase 2b "lodging itinerary -> staged commit over a real two-price rail ->
 *  shareable deeplinks" loop. Zero external calls. */
export async function runConciergeLodgingDryRun(
  args: LodgingDryRunArgs,
): Promise<{ manifest: BookingManifest; staged: StagedResult; deeplinks: { itemId: string; url: string }[]; audit: AuditEntry[] }> {
  const rail = new LiteAPIAdapter({ baseUrl: "https://sandbox.liteapi.local", apiKey: "sandbox", fetchImpl: args.fetchImpl ?? liteApiSandboxFetch() });
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
  });
  const slotByItem = new Map(manifest.items.map((i) => [i.intent.itemId, i.chosen]));
  const deeplinks = staged.results
    .filter((r) => r.status === "confirmed")
    .map((r): { itemId: string; url: string } | null => {
      const chosen = slotByItem.get(r.itemId);
      if (!chosen) return null; // defensive: a confirmed result always had a chosen slot (invariant lives in executeStaged)
      const intent = manifest.items.find((i) => i.intent.itemId === r.itemId)?.intent;
      return {
        itemId: r.itemId,
        url: buildLodgingDeeplink({
          tenant: args.tenant,
          railSlotId: chosen.railSlotId,
          checkIn: chosen.startsAt,
          partySize: intent?.query.partySize,
        }),
      };
    })
    .filter((d): d is { itemId: string; url: string } => d !== null);
  return { manifest, staged, deeplinks, audit: await audit.entries(args.tripId) };
}
