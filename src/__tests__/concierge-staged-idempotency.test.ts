import { describe, it, expect } from "vitest";
import { Orchestrator, InMemoryBookingStore } from "../concierge/orchestrator";
import { InMemoryAuditLog } from "../concierge/audit";
import { resolveManifest, DeterministicProposalSource } from "../concierge/resolver";
import { MockRail } from "../concierge/mock-rail";
import { bookingRecordId } from "../concierge/types";
import type { BookingIntent } from "../concierge/types";
import type { BookingRail } from "../concierge/rail";

// Phase 2c — retry-safety. `executeStaged`'s doc comment said "call this exactly once per trip",
// which is a comment, not a guard. A caller that times out mid-commit and retries would ask the rail
// to book a second time. These tests drive the SAME store through executeStaged twice and assert the
// rail is never asked to book the same item twice.

const lead = { leadName: "Ada", leadEmail: "ada@example.com" };
const now = "2026-07-20T12:00:00.000Z";

const intents: BookingIntent[] = [
  { itemId: "stay-1", category: "lodging", query: { area: "Nashville", dateTime: "2026-08-01T15:00:00Z", partySize: 6, maxPriceCents: 100000 } },
  { itemId: "tour-1", category: "activity", query: { area: "Austin", dateTime: "2026-08-02T14:00:00Z", partySize: 6, maxPriceCents: 100000 } },
];

/** MockRail that counts book() calls per holdRef, so a double-book is directly observable. */
class CountingRail extends MockRail {
  readonly bookCalls: string[] = [];
  override async book(holdRef: string, ctx: { leadName: string; leadEmail: string }) {
    this.bookCalls.push(holdRef);
    return super.book(holdRef, ctx);
  }
}

/** A rail with NO reconciliation capability — the real shape of a partner API that can't answer
 *  "did this holdRef produce a booking?". Delegates everything else to a CountingRail. */
class NoReconcileRail implements BookingRail {
  private readonly inner: CountingRail;
  readonly railId: string;
  constructor(opts: ConstructorParameters<typeof CountingRail>[0]) {
    this.inner = new CountingRail(opts);
    this.railId = this.inner.railId;
  }
  get bookCalls() { return this.inner.bookCalls; }
  search: BookingRail["search"] = (q) => this.inner.search(q);
  getCancellationPolicy: BookingRail["getCancellationPolicy"] = () => this.inner.getCancellationPolicy();
  hold: BookingRail["hold"] = (id, c) => this.inner.hold(id, c);
  book: BookingRail["book"] = (ref, c) => this.inner.book(ref, c);
  cancel: BookingRail["cancel"] = (ref) => this.inner.cancel(ref);
  release: BookingRail["release"] = (ref) => this.inner.release(ref);
  status: BookingRail["status"] = (ref) => this.inner.status(ref);
  // `reconcile` deliberately absent.
}

const manifestFor = (rail: BookingRail) =>
  resolveManifest({ tripId: "trip-1", tenant: "moh", intents, rail, proposals: new DeterministicProposalSource() });

describe("executeStaged retry-safety (Phase 2c)", () => {
  it("a second run over the same store does NOT book anything a second time", async () => {
    const rail = new CountingRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const manifest = await manifestFor(rail);
    const orch = new Orchestrator(rail, store, new InMemoryAuditLog());

    const first = await orch.executeStaged(manifest, { lead, now });
    expect(first.state).toBe("CONFIRMED");
    expect(rail.bookCalls).toHaveLength(2);

    // The caller timed out and retried the identical trip.
    const second = await orch.executeStaged(manifest, { lead, now });

    expect(rail.bookCalls).toHaveLength(2); // <- the money assertion: no re-book
    expect(second.state).toBe("CONFIRMED");
    // The retry still reports the full trip back to the caller, replayed from the store.
    expect(second.results.map((r) => r.itemId).sort()).toEqual(["stay-1", "tour-1"]);
    expect(second.results.every((r) => r.status === "confirmed")).toBe(true);
  });

  it("replays the stored confirmation code rather than inventing a new one", async () => {
    const rail = new CountingRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const manifest = await manifestFor(rail);
    const orch = new Orchestrator(rail, store, new InMemoryAuditLog());

    const first = await orch.executeStaged(manifest, { lead, now });
    const firstCodes = Object.fromEntries(first.results.map((r) => [r.itemId, r.confirmationCode]));

    const second = await orch.executeStaged(manifest, { lead, now });
    const secondCodes = Object.fromEntries(second.results.map((r) => [r.itemId, r.confirmationCode]));

    expect(secondCodes).toEqual(firstCodes);
  });

  it("does not re-HOLD an already-confirmed item on retry (no stray holds on the rail)", async () => {
    const rail = new CountingRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const manifest = await manifestFor(rail);
    const audit = new InMemoryAuditLog();
    const orch = new Orchestrator(rail, store, audit);

    await orch.executeStaged(manifest, { lead, now });
    const holdsAfterFirst = (await audit.entries("trip-1")).filter((e) => e.action === "hold").length;

    await orch.executeStaged(manifest, { lead, now });
    const holdsAfterSecond = (await audit.entries("trip-1")).filter((e) => e.action === "hold").length;

    expect(holdsAfterSecond).toBe(holdsAfterFirst);
  });

  it("resumes a PARTIAL trip: re-books only the item that never confirmed", async () => {
    // Simulate a crash after stay-1 confirmed but before tour-1 was attempted, by seeding the store
    // with only stay-1's confirmed record.
    const rail = new CountingRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const manifest = await manifestFor(rail);
    await store.put({
      id: bookingRecordId("trip-1", "stay-1", rail.railId),
      tripId: "trip-1",
      itemId: "stay-1",
      rail: rail.railId,
      status: "confirmed",
      railRef: "prior-ref",
      confirmationCode: "PRIOR-CODE",
      amountCents: 8500,
      error: null,
    });

    const staged = await new Orchestrator(rail, store, new InMemoryAuditLog()).executeStaged(manifest, { lead, now });

    expect(staged.state).toBe("CONFIRMED");
    expect(rail.bookCalls).toHaveLength(1); // only tour-1
    const stay = staged.results.find((r) => r.itemId === "stay-1");
    expect(stay?.confirmationCode).toBe("PRIOR-CODE"); // replayed, not re-booked
  });

  it("a prior FAILED record does not block a genuine retry", async () => {
    // Failure is not a terminal money commitment — a retry after a transient rail error must be
    // allowed to actually book. Only `confirmed` is treated as already-done.
    const rail = new CountingRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const manifest = await manifestFor(rail);
    await store.put({
      id: bookingRecordId("trip-1", "stay-1", rail.railId),
      tripId: "trip-1",
      itemId: "stay-1",
      rail: rail.railId,
      status: "failed",
      railRef: null,
      confirmationCode: null,
      amountCents: 0,
      error: "transient rail 503",
    });

    const staged = await new Orchestrator(rail, store, new InMemoryAuditLog()).executeStaged(manifest, { lead, now });

    expect(staged.state).toBe("CONFIRMED");
    expect(rail.bookCalls).toHaveLength(2); // both items booked for real
  });

  it("marks an item in-flight BEFORE calling book, so a crash mid-book is detectable", async () => {
    const rail = new CountingRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const manifest = await manifestFor(rail);
    const seen: string[] = [];
    const origPut = store.put.bind(store);
    // Record the status written for stay-1 in order. "held" must appear before "confirmed" —
    // otherwise a crash between book() and the confirmed write leaves NO evidence the money moved.
    store.put = async (rec) => {
      if (rec.itemId === "stay-1") seen.push(rec.status);
      return origPut(rec);
    };

    await new Orchestrator(rail, store, new InMemoryAuditLog()).executeStaged(manifest, { lead, now });

    expect(seen).toEqual(["held", "confirmed"]);
  });

  it("refuses to auto-rebook an ambiguous in-flight item, failing loud instead of risking a double-book", async () => {
    // A "held" record with no railRef means: we called book() and never learned the outcome. The
    // booking may well exist on the rail. Guessing costs real money either way, so stop and say so.
    const rail = new CountingRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const manifest = await manifestFor(rail);
    await store.put({
      id: bookingRecordId("trip-1", "stay-1", rail.railId),
      tripId: "trip-1",
      itemId: "stay-1",
      rail: rail.railId,
      status: "held",
      railRef: null,
      confirmationCode: null,
      amountCents: 8500,
      error: null,
    });

    const staged = await new Orchestrator(rail, store, new InMemoryAuditLog()).executeStaged(manifest, { lead, now });

    expect(staged.state).toBe("FAILED");
    expect(staged.error).toMatch(/in-flight|reconcile/i);
    expect(rail.bookCalls).toHaveLength(0); // nothing re-booked on a guess
  });

  it("reconciles an in-flight item the rail DID book: adopts it, never re-books", async () => {
    // The crash window resolved automatically. The rail confirms a booking exists for our holdRef,
    // so we adopt it into the record instead of asking a human.
    const rail = new CountingRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const manifest = await manifestFor(rail);
    // Take the real hold, book it, then simulate the crash: the confirmed write never happened, so
    // the store still shows in-flight.
    const held = await rail.hold(manifest.items[0]!.chosen!.railSlotId, { partySize: 6, dateTime: "2026-08-01T15:00:00Z" });
    await rail.book(held.holdRef, lead);
    rail.bookCalls.length = 0; // reset: only the retry's calls matter now
    await store.put({
      id: bookingRecordId("trip-1", "stay-1", rail.railId),
      tripId: "trip-1", itemId: "stay-1", rail: rail.railId,
      status: "held", railRef: null, confirmationCode: null, amountCents: 8500, error: null,
      holdRef: held.holdRef,
    });

    const staged = await new Orchestrator(rail, store, new InMemoryAuditLog()).executeStaged(manifest, { lead, now });

    expect(staged.state).toBe("CONFIRMED");
    expect(rail.bookCalls).toHaveLength(1); // tour-1 only — stay-1 was adopted, not re-booked
    const rec = await store.get(bookingRecordId("trip-1", "stay-1", rail.railId));
    expect(rec?.status).toBe("confirmed");
    expect(rec?.railRef).toBeTruthy(); // the ref we'd lost is now recorded, so cancel() can target it
  });

  it("reconciles an in-flight item the rail did NOT book: proceeds and books it once", async () => {
    const rail = new CountingRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const manifest = await manifestFor(rail);
    // A holdRef that was never booked — the crash happened before the rail acted.
    await store.put({
      id: bookingRecordId("trip-1", "stay-1", rail.railId),
      tripId: "trip-1", itemId: "stay-1", rail: rail.railId,
      status: "held", railRef: null, confirmationCode: null, amountCents: 8500, error: null,
      holdRef: "hold-never-booked",
    });

    const audit = new InMemoryAuditLog();
    const staged = await new Orchestrator(rail, store, audit).executeStaged(manifest, { lead, now });

    expect(staged.state).toBe("CONFIRMED");
    expect(rail.bookCalls).toHaveLength(2); // both booked for real, exactly once each
    // The stale hold from the crashed run is dropped, not left stranding inventory on the rail.
    const released = (await audit.entries("trip-1")).filter((e) => e.action === "release" && e.externalRef === "hold-never-booked");
    expect(released).toHaveLength(1);
  });

  it("still fails loud when the rail cannot reconcile (capability absent)", async () => {
    // Regression guard: graceful degradation to the fail-loud behaviour, never a blind re-book.
    const rail = new NoReconcileRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const manifest = await manifestFor(rail);
    await store.put({
      id: bookingRecordId("trip-1", "stay-1", rail.railId),
      tripId: "trip-1", itemId: "stay-1", rail: rail.railId,
      status: "held", railRef: null, confirmationCode: null, amountCents: 8500, error: null,
      holdRef: "hold-whatever",
    });

    const staged = await new Orchestrator(rail, store, new InMemoryAuditLog()).executeStaged(manifest, { lead, now });

    expect(staged.state).toBe("FAILED");
    expect(staged.error).toMatch(/in-flight|reconcile/i);
    expect(rail.bookCalls).toHaveLength(0);
  });

  it("fails loud when reconciliation itself throws — never guesses on a rail error", async () => {
    class ThrowingReconcileRail extends CountingRail {
      override async reconcile(): Promise<never> {
        throw new Error("rail 503 during reconcile");
      }
    }
    const rail = new ThrowingReconcileRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const manifest = await manifestFor(rail);
    await store.put({
      id: bookingRecordId("trip-1", "stay-1", rail.railId),
      tripId: "trip-1", itemId: "stay-1", rail: rail.railId,
      status: "held", railRef: null, confirmationCode: null, amountCents: 8500, error: null,
      holdRef: "hold-whatever",
    });

    const staged = await new Orchestrator(rail, store, new InMemoryAuditLog()).executeStaged(manifest, { lead, now });

    expect(staged.state).toBe("FAILED");
    expect(staged.error).toMatch(/reconcile/i);
    expect(rail.bookCalls).toHaveLength(0);
  });

  it("counts already-confirmed spend against the caps on a retry", async () => {
    // 8,500 already committed + 8,500 to go = 17,000. A 10,000 cap must still trip, or a retry
    // becomes a way to walk past the budget one item at a time.
    const rail = new CountingRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const manifest = await manifestFor(rail);
    await store.put({
      id: bookingRecordId("trip-1", "stay-1", rail.railId),
      tripId: "trip-1",
      itemId: "stay-1",
      rail: rail.railId,
      status: "confirmed",
      railRef: "prior-ref",
      confirmationCode: "PRIOR-CODE",
      amountCents: 8500,
      error: null,
    });

    const staged = await new Orchestrator(rail, store, new InMemoryAuditLog()).executeStaged(manifest, {
      lead,
      now,
      caps: { totalCapCents: 10000 },
    });

    expect(staged.state).toBe("FAILED");
    expect(staged.error).toMatch(/cap|total/i);
    expect(rail.bookCalls).toHaveLength(0); // nothing new committed
  });
});
