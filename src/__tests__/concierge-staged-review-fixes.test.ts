import { describe, it, expect } from "vitest";
import { Orchestrator, InMemoryBookingStore } from "../concierge/orchestrator";
import { InMemoryAuditLog } from "../concierge/audit";
import { resolveManifest, DeterministicProposalSource } from "../concierge/resolver";
import { MockRail } from "../concierge/mock-rail";
import { RailRejectedError } from "../concierge/rail";
import { bookingRecordId } from "../concierge/types";
import type { BookingIntent } from "../concierge/types";

// Phase 2c adversarial review (2026-07-23) — two CRITICALs found in the 2c code itself.
// These are the regression tests for both.

const lead = { leadName: "Ada", leadEmail: "ada@example.com" };
const now = "2026-07-20T12:00:00.000Z";
const intents: BookingIntent[] = [
  { itemId: "stay-1", category: "lodging", query: { area: "Nashville", dateTime: "2026-08-01T15:00:00Z", partySize: 6, maxPriceCents: 100000 } },
  { itemId: "tour-1", category: "activity", query: { area: "Austin", dateTime: "2026-08-02T14:00:00Z", partySize: 6, maxPriceCents: 100000 } },
];
const manifestFor = (rail: MockRail) =>
  resolveManifest({ tripId: "trip-1", tenant: "moh", intents, rail, proposals: new DeterministicProposalSource() });

describe("CRITICAL 1 — an ambiguous book() failure must not be recorded as a clean failure", () => {
  /** The ordinary gateway-timeout shape: the supplier COMMITTED, the response was lost. */
  class TimeoutAfterBookingRail extends MockRail {
    readonly bookCalls: string[] = [];
    timeoutNext = true;
    override async book(holdRef: string, ctx: { leadName: string; leadEmail: string }) {
      this.bookCalls.push(holdRef);
      const res = await super.book(holdRef, ctx); // the booking really exists now
      if (this.timeoutNext && holdRef.includes("Nashville")) {
        this.timeoutNext = false;
        throw new Error("ETIMEDOUT: socket hang up");
      }
      return res;
    }
  }

  it("does NOT re-book on retry when book() timed out after the rail committed", async () => {
    const rail = new TimeoutAfterBookingRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const manifest = await manifestFor(rail);
    const orch = new Orchestrator(rail, store, new InMemoryAuditLog());

    const run1 = await orch.executeStaged(manifest, { lead, now });
    expect(run1.state).toBe("FAILED");

    // The record must stay AMBIGUOUS (in-flight), not be flattened to "failed" — "failed" is
    // documented as safe to retry for real, which is exactly what double-books.
    const rec = await store.get(bookingRecordId("trip-1", "stay-1", rail.railId));
    expect(rec?.status).toBe("held");
    expect(rec?.railRef).toBeNull();
    expect(rec?.holdRef).toBeTruthy(); // reconcile needs a handle

    const run2 = await orch.executeStaged(manifest, { lead, now });

    // THE money assertion: Nashville was booked exactly once across both runs.
    expect(rail.bookCalls.filter((b) => b.includes("Nashville"))).toHaveLength(1);
    expect(run2.state).toBe("CONFIRMED");
  });

  it("a DEFINITIVE rail rejection is still recorded as failed and genuinely retried", async () => {
    // Not every book() throw is ambiguous. A 4xx with a body means the rail did nothing, and we
    // must stay free to retry for real — otherwise every refusal wedges into human reconciliation.
    class RefusingOnceRail extends MockRail {
      readonly bookCalls: string[] = [];
      refuseNext = true;
      override async book(holdRef: string, ctx: { leadName: string; leadEmail: string }) {
        this.bookCalls.push(holdRef);
        if (this.refuseNext && holdRef.includes("Nashville")) {
          this.refuseNext = false;
          throw new RailRejectedError("rate no longer available");
        }
        return super.book(holdRef, ctx);
      }
    }
    const rail = new RefusingOnceRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const manifest = await manifestFor(rail);
    const orch = new Orchestrator(rail, store, new InMemoryAuditLog());

    const run1 = await orch.executeStaged(manifest, { lead, now });
    expect(run1.state).toBe("FAILED");
    const rec = await store.get(bookingRecordId("trip-1", "stay-1", rail.railId));
    expect(rec?.status).toBe("failed"); // definitive → clean failure

    const run2 = await orch.executeStaged(manifest, { lead, now });
    expect(run2.state).toBe("CONFIRMED");
    expect(rail.bookCalls.filter((b) => b.includes("Nashville"))).toHaveLength(2); // retried for real
  });
});

describe("CRITICAL 2 — a failing retry must compensate bookings from EARLIER runs", () => {
  class TrackingRail extends MockRail {
    readonly cancelCalls: string[] = [];
    override async cancel(railRef: string) {
      this.cancelCalls.push(railRef);
      return super.cancel(railRef);
    }
  }

  it("cancels a prior run's confirmed booking when this run fails at the cap gate", async () => {
    const rail = new TrackingRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const manifest = await manifestFor(rail);
    await store.put({
      id: bookingRecordId("trip-1", "stay-1", rail.railId),
      tripId: "trip-1", itemId: "stay-1", rail: rail.railId,
      status: "confirmed", railRef: "ref-Nashville-209", confirmationCode: "PAID-CODE",
      amountCents: 8500, error: null,
    });

    const staged = await new Orchestrator(rail, store, new InMemoryAuditLog()).executeStaged(manifest, {
      lead, now, caps: { totalCapCents: 10000 },
    });

    expect(staged.state).toBe("FAILED");
    // The no-orphan invariant: a FAILED trip leaves nothing live on the rail.
    expect(rail.cancelCalls).toContain("ref-Nashville-209");
    expect(staged.compensations.map((c) => c.itemId)).toContain("stay-1");
    const rec = await store.get(bookingRecordId("trip-1", "stay-1", rail.railId));
    expect(rec?.status).toBe("cancelled");
  });

  it("cancels a prior booking when a LATER item's book() fails on the retry", async () => {
    class FailTourRail extends TrackingRail {
      override async book(holdRef: string, ctx: { leadName: string; leadEmail: string }) {
        if (holdRef.includes("Austin")) throw new RailRejectedError("sold out");
        return super.book(holdRef, ctx);
      }
    }
    const rail = new FailTourRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const manifest = await manifestFor(rail);
    await store.put({
      id: bookingRecordId("trip-1", "stay-1", rail.railId),
      tripId: "trip-1", itemId: "stay-1", rail: rail.railId,
      status: "confirmed", railRef: "ref-Nashville-209", confirmationCode: "PAID-CODE",
      amountCents: 8500, error: null,
    });

    const staged = await new Orchestrator(rail, store, new InMemoryAuditLog()).executeStaged(manifest, { lead, now });

    expect(staged.state).toBe("FAILED");
    expect(rail.cancelCalls).toContain("ref-Nashville-209");
  });

  it("does not attempt to cancel a confirmed record with no railRef", async () => {
    // cancel(null) is not a thing. Such a record is unrecoverable, but it must not throw here.
    const rail = new TrackingRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const manifest = await manifestFor(rail);
    await store.put({
      id: bookingRecordId("trip-1", "stay-1", rail.railId),
      tripId: "trip-1", itemId: "stay-1", rail: rail.railId,
      status: "confirmed", railRef: null, confirmationCode: "PAID-CODE",
      amountCents: 8500, error: null,
    });

    const staged = await new Orchestrator(rail, store, new InMemoryAuditLog()).executeStaged(manifest, {
      lead, now, caps: { totalCapCents: 10000 },
    });

    expect(staged.state).toBe("FAILED");
    expect(rail.cancelCalls).toHaveLength(0);
  });

  it("still reports a clean CONFIRMED trip when nothing fails (no false compensation)", async () => {
    const rail = new TrackingRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const manifest = await manifestFor(rail);
    const orch = new Orchestrator(rail, store, new InMemoryAuditLog());
    await orch.executeStaged(manifest, { lead, now });
    const second = await orch.executeStaged(manifest, { lead, now });

    expect(second.state).toBe("CONFIRMED");
    expect(rail.cancelCalls).toHaveLength(0); // replay must never cancel anything
  });
});
