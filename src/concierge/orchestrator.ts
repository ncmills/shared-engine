import type { BookingRail } from "./rail";
import type { BookingManifest, BookingRecord, BookingResult } from "./types";
import { bookingRecordId } from "./types";
import { InMemoryAuditLog, type AuditLog } from "./audit";

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

export interface SagaResult {
  tripId: string;
  status: "confirmed" | "compensated";
  results: BookingResult[];
  compensations: CompensationRecord[];
  error: string | null;
}

export class Orchestrator {
  constructor(
    private rail: BookingRail,
    private store: BookingStore,
    private audit: AuditLog = new InMemoryAuditLog(),
  ) {}

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
      const compensations: CompensationRecord[] = [];
      for (const b of booked) {
        const { refundAmountCents } = await this.rail.cancel(b.railRef);
        const id = bookingRecordId(manifest.tripId, b.itemId, this.rail.railId);
        const rec = await this.store.get(id);
        if (rec) await this.store.put({ ...rec, status: "cancelled" });
        await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId: b.itemId, actor, action: "compensate", rail: this.rail.railId, externalRef: b.railRef, amountCents: refundAmountCents });
        compensations.push({ itemId: b.itemId, railRef: b.railRef, refundAmountCents });
      }
      return { tripId: manifest.tripId, status: "compensated", results, compensations, error };
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

        // Hold-expiry is a first-class failure, never a silent lapse.
        if (ctx.now >= held.expiresAt) {
          throw new Error(`hold ${held.holdRef} expired at ${held.expiresAt}`);
        }

        const bookedRes = await this.rail.book(held.holdRef, ctx.lead);
        const rec: BookingRecord = { id, tripId: manifest.tripId, itemId, rail: this.rail.railId, status: "confirmed", railRef: bookedRes.railRef, confirmationCode: bookedRes.confirmationCode, amountCents: bookedRes.amountCents, error: null };
        await this.store.put(rec);
        await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId, actor, action: "book", rail: this.rail.railId, externalRef: bookedRes.railRef, amountCents: bookedRes.amountCents });
        results.push({ itemId, status: "confirmed", confirmationCode: bookedRes.confirmationCode, error: null });
        booked.push({ itemId, railRef: bookedRes.railRef });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const rec: BookingRecord = { id, tripId: manifest.tripId, itemId, rail: this.rail.railId, status: "failed", railRef: null, confirmationCode: null, amountCents: 0, error: msg };
        await this.store.put(rec);
        await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId, actor, action: "book_failed", rail: this.rail.railId, externalRef: null, amountCents: 0, detail: msg });
        results.push({ itemId, status: "failed", confirmationCode: null, error: msg });
        return compensate(msg);
      }
    }

    return { tripId: manifest.tripId, status: "confirmed", results, compensations: [], error: null };
  }
}
