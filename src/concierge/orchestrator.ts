import type { BookingRail } from "./rail";
import type { BookingManifest, BookingRecord, BookingResult, BookingCategory } from "./types";
import { bookingRecordId } from "./types";
import { InMemoryAuditLog, type AuditLog } from "./audit";
import { checkSpendCaps, type SpendCaps } from "./caps";

export interface BookingStore {
  get(id: string): Promise<BookingRecord | null>;
  put(rec: BookingRecord): Promise<void>;
  all(tripId: string): Promise<BookingRecord[]>;
}

export class InMemoryBookingStore implements BookingStore {
  private map = new Map<string, BookingRecord>();
  async get(id: string): Promise<BookingRecord | null> {
    return this.map.get(id) ?? null;
  }
  async put(rec: BookingRecord): Promise<void> {
    this.map.set(rec.id, rec);
  }
  async all(tripId: string): Promise<BookingRecord[]> {
    return [...this.map.values()].filter((r) => r.tripId === tripId);
  }
}

export interface ExecuteCtx {
  lead: { leadName: string; leadEmail: string };
}

export interface SagaCtx {
  lead: { leadName: string; leadEmail: string };
  now: string; // ISO8601 — determinism; used for hold-expiry checks + audit timestamps
  actor?: string;
}

export interface CompensationRecord {
  itemId: string;
  railRef: string;
  refundAmountCents: number;
}

export interface CompensationFailure {
  itemId: string;
  railRef: string;
  error: string;
}

export interface SagaResult {
  tripId: string;
  status: "confirmed" | "compensated";
  results: BookingResult[];
  compensations: CompensationRecord[];
  /** Booked items whose compensating cancel threw — orphans that need operator follow-up.
   *  Non-empty here is the "stuck saga" alert condition. */
  failedCompensations: CompensationFailure[];
  error: string | null;
}

export type TripState = "DRAFT" | "RESOLVING" | "HELD" | "PENDING_CONFIRM" | "COMMITTING" | "CONFIRMED" | "FAILED";

export interface StagedCtx {
  lead: { leadName: string; leadEmail: string };
  now: string; // ISO8601
  caps?: SpendCaps;
  actor?: string;
}

export interface HeldItem {
  itemId: string;
  category: BookingCategory;
  railSlotId: string;
  holdRef: string;
  expiresAt: string;
  priceCents: number;
}

export interface StagedResult {
  tripId: string;
  state: TripState;
  results: BookingResult[];
  /** itemIds in the order they were committed (shortest-hold-TTL-first) — provable. */
  committedOrder: string[];
  compensations: CompensationRecord[];
  failedCompensations: CompensationFailure[];
  /** holdRefs released without booking (uncommitted holds dropped on abort/unwind). */
  releasedHolds: string[];
  error: string | null;
}

export class Orchestrator {
  constructor(
    private rail: BookingRail,
    private store: BookingStore,
    private audit: AuditLog = new InMemoryAuditLog(),
  ) {}

  /** Cancel every booked item, isolated per-item + audited. Shared by saga + staged paths. */
  private async compensateBooked(
    tripId: string,
    booked: { itemId: string; railRef: string }[],
    now: string,
    actor: string,
  ): Promise<{ compensations: CompensationRecord[]; failedCompensations: CompensationFailure[] }> {
    const compensations: CompensationRecord[] = [];
    const failedCompensations: CompensationFailure[] = [];
    for (const b of booked) {
      const id = bookingRecordId(tripId, b.itemId, this.rail.railId);
      try {
        const { refundAmountCents } = await this.rail.cancel(b.railRef);
        const rec = await this.store.get(id);
        if (rec) await this.store.put({ ...rec, status: "cancelled" });
        await this.audit.append({ ts: now, tripId, itemId: b.itemId, actor, action: "compensate", rail: this.rail.railId, externalRef: b.railRef, amountCents: refundAmountCents });
        compensations.push({ itemId: b.itemId, railRef: b.railRef, refundAmountCents });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.audit.append({ ts: now, tripId, itemId: b.itemId, actor, action: "compensate_failed", rail: this.rail.railId, externalRef: b.railRef, amountCents: 0, detail: msg });
        failedCompensations.push({ itemId: b.itemId, railRef: b.railRef, error: msg });
      }
    }
    return { compensations, failedCompensations };
  }

  /** Release every uncommitted hold, isolated per-item + audited. A failed release is a stuck
   *  hold (it will expire on its own) — recorded, never swallowed. */
  private async releaseHolds(
    tripId: string,
    holds: { itemId: string; holdRef: string }[],
    now: string,
    actor: string,
  ): Promise<string[]> {
    const released: string[] = [];
    for (const h of holds) {
      try {
        await this.rail.release(h.holdRef);
        await this.audit.append({ ts: now, tripId, itemId: h.itemId, actor, action: "release", rail: this.rail.railId, externalRef: h.holdRef, amountCents: 0 });
        released.push(h.holdRef);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.audit.append({ ts: now, tripId, itemId: h.itemId, actor, action: "release_failed", rail: this.rail.railId, externalRef: h.holdRef, amountCents: 0, detail: msg });
      }
    }
    return released;
  }

  /** Phase 0 path: book each chosen item independently; a single failure is isolated,
   *  never aborts the run. Correct for free, independent items (dining). Unchanged. */
  async execute(manifest: BookingManifest, ctx: ExecuteCtx): Promise<BookingResult[]> {
    const results: BookingResult[] = [];
    for (const item of manifest.items) {
      const { itemId } = item.intent;
      const id = bookingRecordId(manifest.tripId, itemId, this.rail.railId);

      const existing = await this.store.get(id);
      if (existing && existing.status === "confirmed") {
        results.push({ itemId, status: "confirmed", confirmationCode: existing.confirmationCode, error: null });
        continue;
      }

      if (!item.chosen) {
        const rec: BookingRecord = { id, tripId: manifest.tripId, itemId, rail: this.rail.railId, status: "failed", railRef: null, confirmationCode: null, amountCents: 0, error: "no candidate chosen" };
        await this.store.put(rec);
        results.push({ itemId, status: "failed", confirmationCode: null, error: rec.error });
        continue;
      }

      try {
        const held = await this.rail.hold(item.chosen.railSlotId, { partySize: item.intent.query.partySize, dateTime: item.chosen.startsAt });
        const booked = await this.rail.book(held.holdRef, ctx.lead);
        const rec: BookingRecord = { id, tripId: manifest.tripId, itemId, rail: this.rail.railId, status: "confirmed", railRef: booked.railRef, confirmationCode: booked.confirmationCode, amountCents: booked.amountCents, error: null };
        await this.store.put(rec);
        results.push({ itemId, status: "confirmed", confirmationCode: booked.confirmationCode, error: null });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const rec: BookingRecord = { id, tripId: manifest.tripId, itemId, rail: this.rail.railId, status: "failed", railRef: null, confirmationCode: null, amountCents: 0, error: msg };
        await this.store.put(rec);
        results.push({ itemId, status: "failed", confirmationCode: null, error: msg });
      }
    }
    return results;
  }

  /** Phase 1 path: book a manifest ATOMICALLY. On ANY item failure (no candidate, book
   *  throws, or hold expired), compensate — cancel every already-booked item — so the trip
   *  ends with zero live bookings (the no-orphan invariant). Idempotent + audit-logged. */
  async executeSaga(manifest: BookingManifest, ctx: SagaCtx): Promise<SagaResult> {
    const actor = ctx.actor ?? "orchestrator";
    const results: BookingResult[] = [];
    const booked: { itemId: string; railRef: string }[] = [];

    const compensate = async (error: string): Promise<SagaResult> => {
      const { compensations, failedCompensations } = await this.compensateBooked(manifest.tripId, booked, ctx.now, actor);
      return { tripId: manifest.tripId, status: "compensated", results, compensations, failedCompensations, error };
    };

    for (const item of manifest.items) {
      const { itemId } = item.intent;
      const id = bookingRecordId(manifest.tripId, itemId, this.rail.railId);

      // Idempotency: an already-confirmed item is treated as booked (and stays subject to
      // compensation if a LATER item in this run fails).
      const existing = await this.store.get(id);
      if (existing && existing.status === "confirmed" && existing.railRef) {
        results.push({ itemId, status: "confirmed", confirmationCode: existing.confirmationCode, error: null });
        booked.push({ itemId, railRef: existing.railRef });
        continue;
      }

      if (!item.chosen) {
        const rec: BookingRecord = { id, tripId: manifest.tripId, itemId, rail: this.rail.railId, status: "failed", railRef: null, confirmationCode: null, amountCents: 0, error: "no candidate chosen" };
        await this.store.put(rec);
        results.push({ itemId, status: "failed", confirmationCode: null, error: rec.error });
        return compensate(`item ${itemId}: no candidate chosen`);
      }

      try {
        const held = await this.rail.hold(item.chosen.railSlotId, { partySize: item.intent.query.partySize, dateTime: item.chosen.startsAt });
        await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId, actor, action: "hold", rail: this.rail.railId, externalRef: held.holdRef, amountCents: item.chosen.priceCents });

        // Hold-expiry is a first-class failure, never a silent lapse. Compare INSTANTS, not
        // strings — rails may report expiresAt in any ISO8601 zone/precision, so a lexicographic
        // compare would both false-expire valid holds and miss real ones. An unparseable expiry
        // is unsafe to book against, so treat it as expired (fail loud).
        const nowMs = Date.parse(ctx.now);
        const expMs = Date.parse(held.expiresAt);
        if (Number.isNaN(expMs) || Number.isNaN(nowMs) || nowMs >= expMs) {
          throw new Error(`hold ${held.holdRef} expired at ${held.expiresAt}`);
        }

        const bookedRes = await this.rail.book(held.holdRef, ctx.lead);
        // Record the live rail booking BEFORE any further await, so a store/audit write that
        // throws next cannot orphan a booking that already exists on the rail.
        booked.push({ itemId, railRef: bookedRes.railRef });
        const rec: BookingRecord = { id, tripId: manifest.tripId, itemId, rail: this.rail.railId, status: "confirmed", railRef: bookedRes.railRef, confirmationCode: bookedRes.confirmationCode, amountCents: bookedRes.amountCents, error: null };
        await this.store.put(rec);
        await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId, actor, action: "book", rail: this.rail.railId, externalRef: bookedRes.railRef, amountCents: bookedRes.amountCents });
        results.push({ itemId, status: "confirmed", confirmationCode: bookedRes.confirmationCode, error: null });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const rec: BookingRecord = { id, tripId: manifest.tripId, itemId, rail: this.rail.railId, status: "failed", railRef: null, confirmationCode: null, amountCents: 0, error: msg };
        await this.store.put(rec);
        await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId, actor, action: "book_failed", rail: this.rail.railId, externalRef: null, amountCents: 0, detail: msg });
        results.push({ itemId, status: "failed", confirmationCode: null, error: msg });
        return compensate(msg);
      }
    }

    return { tripId: manifest.tripId, status: "confirmed", results, compensations: [], failedCompensations: [], error: null };
  }

  /** Phase 2a path: STAGED commit. Hold everything (no commitment), assemble + validate spend
   *  caps, then commit shortest-hold-TTL-first. Any failure unwinds: compensate booked items +
   *  release still-uncommitted holds. Ends CONFIRMED or FAILED; deterministic + audit-logged. */
  async executeStaged(manifest: BookingManifest, ctx: StagedCtx): Promise<StagedResult> {
    const actor = ctx.actor ?? "orchestrator";
    const results: BookingResult[] = [];
    const held: HeldItem[] = [];

    const unwind = async (
      error: string,
      booked: { itemId: string; railRef: string }[],
      remainingHolds: { itemId: string; holdRef: string }[],
    ): Promise<StagedResult> => {
      const { compensations, failedCompensations } = await this.compensateBooked(manifest.tripId, booked, ctx.now, actor);
      const releasedHolds = await this.releaseHolds(manifest.tripId, remainingHolds, ctx.now, actor);
      return { tripId: manifest.tripId, state: "FAILED", results, committedOrder: booked.map((b) => b.itemId), compensations, failedCompensations, releasedHolds, error };
    };

    // --- HELD: reserve every item, no commitment yet ---
    for (const item of manifest.items) {
      const { itemId, category } = item.intent;
      if (!item.chosen) {
        results.push({ itemId, status: "failed", confirmationCode: null, error: "no candidate chosen" });
        return unwind(`item ${itemId}: no candidate chosen`, [], held.map((h) => ({ itemId: h.itemId, holdRef: h.holdRef })));
      }
      const hold = await this.rail.hold(item.chosen.railSlotId, { partySize: item.intent.query.partySize, dateTime: item.chosen.startsAt });
      await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId, actor, action: "hold", rail: this.rail.railId, externalRef: hold.holdRef, amountCents: item.chosen.priceCents });
      held.push({ itemId, category, railSlotId: item.chosen.railSlotId, holdRef: hold.holdRef, expiresAt: hold.expiresAt, priceCents: item.chosen.priceCents });
    }

    // --- PENDING_CONFIRM: assemble priced trip + spend caps ---
    const capError = checkSpendCaps(held.map((h) => ({ category: h.category, priceCents: h.priceCents })), ctx.caps);
    if (capError) {
      return unwind(capError, [], held.map((h) => ({ itemId: h.itemId, holdRef: h.holdRef })));
    }

    // --- COMMITTING: commit non-refundables shortest-hold-TTL-first ---
    const order = [...held].sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
    const booked: { itemId: string; railRef: string }[] = [];
    const committedOrder: string[] = [];
    for (let i = 0; i < order.length; i++) {
      const h = order[i]!;
      const remaining = order.slice(i + 1).map((x) => ({ itemId: x.itemId, holdRef: x.holdRef }));
      const id = bookingRecordId(manifest.tripId, h.itemId, this.rail.railId);

      const nowMs = Date.parse(ctx.now);
      const expMs = Date.parse(h.expiresAt);
      if (Number.isNaN(expMs) || Number.isNaN(nowMs) || nowMs >= expMs) {
        results.push({ itemId: h.itemId, status: "failed", confirmationCode: null, error: "hold expired" });
        return unwind(`hold ${h.holdRef} expired at ${h.expiresAt}`, booked, remaining);
      }

      try {
        const bookedRes = await this.rail.book(h.holdRef, ctx.lead);
        booked.push({ itemId: h.itemId, railRef: bookedRes.railRef });
        committedOrder.push(h.itemId);
        const rec: BookingRecord = { id, tripId: manifest.tripId, itemId: h.itemId, rail: this.rail.railId, status: "confirmed", railRef: bookedRes.railRef, confirmationCode: bookedRes.confirmationCode, amountCents: bookedRes.amountCents, error: null };
        await this.store.put(rec);
        await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId: h.itemId, actor, action: "book", rail: this.rail.railId, externalRef: bookedRes.railRef, amountCents: bookedRes.amountCents });
        results.push({ itemId: h.itemId, status: "confirmed", confirmationCode: bookedRes.confirmationCode, error: null });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const rec: BookingRecord = { id, tripId: manifest.tripId, itemId: h.itemId, rail: this.rail.railId, status: "failed", railRef: null, confirmationCode: null, amountCents: 0, error: msg };
        await this.store.put(rec);
        await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId: h.itemId, actor, action: "book_failed", rail: this.rail.railId, externalRef: null, amountCents: 0, detail: msg });
        results.push({ itemId: h.itemId, status: "failed", confirmationCode: null, error: msg });
        return unwind(msg, booked, remaining);
      }
    }

    return { tripId: manifest.tripId, state: "CONFIRMED", results, committedOrder, compensations: [], failedCompensations: [], releasedHolds: [], error: null };
  }
}
