import { describe, it, expect } from "vitest";
import { Orchestrator, InMemoryBookingStore } from "../concierge/orchestrator";
import { InMemoryAuditLog } from "../concierge/audit";
import { resolveManifest, DeterministicProposalSource } from "../concierge/resolver";
import type { BookingRail, RailSearchQuery, HoldResult, BookResult } from "../concierge/rail";
import type { RailSlot, CancellationPolicy, BookingStatus, BookingIntent } from "../concierge/types";

const FAR = "2999-01-01T00:00:00.000Z";
const POLICY: CancellationPolicy = { refundable: true, freeCancelUntil: FAR, refundAmountCents: null };

/** A minimal rail whose HOLD price can differ from its SEARCH price (drift) and whose hold() can
 *  throw for a chosen slot — the two things MockRail cannot express, and the exact conditions the
 *  Phase 2b adversarial review flagged in executeStaged. One slot per intent (id = area). */
class TwoPriceRail implements BookingRail {
  readonly railId = "twoprice";
  constructor(private opts: { searchCents: number; holdCentsBySlot?: Record<string, number>; throwHoldForSlot?: string[] }) {}
  async search(q: RailSearchQuery): Promise<RailSlot[]> {
    return [{ railSlotId: q.area, label: q.area, priceCents: this.opts.searchCents, startsAt: q.dateTime, cancellation: POLICY }];
  }
  async getCancellationPolicy(): Promise<CancellationPolicy> { return POLICY; }
  async hold(railSlotId: string, ctx: { partySize: number; dateTime: string }): Promise<HoldResult> {
    if (this.opts.throwHoldForSlot?.includes(railSlotId)) throw new Error(`prebook refused for ${railSlotId}`);
    const cents = this.opts.holdCentsBySlot?.[railSlotId] ?? this.opts.searchCents;
    return { holdRef: `hold-${railSlotId}`, expiresAt: FAR, slot: { railSlotId, label: railSlotId, priceCents: cents, startsAt: ctx.dateTime, cancellation: POLICY } };
  }
  async book(holdRef: string): Promise<BookResult> {
    const slot = holdRef.replace(/^hold-/, "");
    return { railRef: `ref-${slot}`, confirmationCode: `OK-${slot}`, amountCents: this.opts.holdCentsBySlot?.[slot] ?? this.opts.searchCents };
  }
  async cancel(): Promise<{ refundAmountCents: number }> { return { refundAmountCents: 0 }; }
  async release(): Promise<void> { return; }
  async status(): Promise<BookingStatus> { return "cancelled"; }
}

const lead = { leadName: "Ada", leadEmail: "ada@example.com" };
const now = "2026-07-20T12:00:00.000Z";
const intent = (itemId: string, area: string, maxPriceCents = 100000): BookingIntent => ({
  itemId, category: "lodging", query: { area, dateTime: "2026-08-01T15:00:00Z", partySize: 6, maxPriceCents },
});
const resolve = (rail: BookingRail, intents: BookingIntent[]) =>
  resolveManifest({ tripId: "trip-1", tenant: "moh", intents, rail, proposals: new DeterministicProposalSource() });

describe("executeStaged over a two-price rail (Phase 2b review fixes)", () => {
  it("cap gate catches the LOCKED (drifted-up) hold price, not the cheaper search quote", async () => {
    // Searched at $450 (under the $500 cap), but the prebook LOCKS $600 (over the cap).
    const rail = new TwoPriceRail({ searchCents: 45000, holdCentsBySlot: { Nashville: 60000 } });
    const audit = new InMemoryAuditLog();
    const manifest = await resolve(rail, [intent("stay-1", "Nashville")]);
    const staged = await new Orchestrator(rail, new InMemoryBookingStore(), audit).executeStaged(manifest, { lead, now, caps: { totalCapCents: 50000 } });
    expect(staged.state).toBe("FAILED");
    expect(staged.error).toMatch(/cap/i);
    expect(staged.results.some((r) => r.status === "confirmed")).toBe(false);
    expect(staged.releasedHolds).toHaveLength(1); // the over-cap hold was released, not leaked
    // and the cap saw 60000, not 45000
    const holdAudit = (await audit.entries("trip-1")).find((e) => e.action === "hold");
    expect(holdAudit?.amountCents).toBe(60000);
  });

  it("a hold() that throws mid-HELD unwinds cleanly: releases prior holds, returns FAILED (no raw throw, no leak)", async () => {
    // stay-1 holds fine; stay-2's prebook throws. stay-1's hold must be released, not leaked.
    const rail = new TwoPriceRail({ searchCents: 45000, throwHoldForSlot: ["Austin"] });
    const audit = new InMemoryAuditLog();
    const manifest = await resolve(rail, [intent("stay-1", "Nashville"), intent("stay-2", "Austin")]);
    const staged = await new Orchestrator(rail, new InMemoryBookingStore(), audit).executeStaged(manifest, { lead, now });
    expect(staged.state).toBe("FAILED");
    expect(staged.error).toMatch(/hold failed/i);
    expect(staged.results.some((r) => r.status === "confirmed")).toBe(false);
    expect(staged.releasedHolds).toEqual(["hold-Nashville"]); // prior hold released
    const actions = (await audit.entries("trip-1")).map((e) => e.action);
    expect(actions).toContain("hold_failed"); // the throwing item is audited
    expect(actions.filter((a) => a === "release")).toHaveLength(1);
  });
});
