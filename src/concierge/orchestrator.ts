import type { BookingRail } from "./rail";
import type { BookingManifest, BookingRecord, BookingResult, BookingCategory } from "./types";
import { bookingRecordId } from "./types";
import { InMemoryAuditLog, type AuditLog } from "./audit";
import { checkSpendCaps, type SpendCaps } from "./caps";
import { checkPriceDrift, type PriceDriftOpts } from "./price-drift";

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
  /** Phase 2c. Upward drift allowed between the price QUOTED at search and the price LOCKED at
   *  hold/prebook, per item. Omitted = zero tolerance: any upward drift aborts the trip. Strict by
   *  default is deliberate — we must never silently charge more than we showed. */
  driftTolerance?: PriceDriftOpts;
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
   *  release still-uncommitted holds. Ends CONFIRMED or FAILED; deterministic + audit-logged.
   *
   *  RETRY-SAFE as of Phase 2c: an item with a `confirmed` record in the store is already money
   *  spent, so it is neither re-held nor re-booked — its stored confirmation is replayed instead.
   *  Re-running a partially-committed trip resumes it rather than duplicating it. Only `confirmed`
   *  short-circuits; a `failed` record is a transient error we are entitled to retry for real.
   *  Durability is the store's job, not the orchestrator's — swap in a persistent BookingStore and
   *  this logic is unchanged (Supabase-backed store still deferred). */
  async executeStaged(manifest: BookingManifest, ctx: StagedCtx): Promise<StagedResult> {
    const actor = ctx.actor ?? "orchestrator";
    const results: BookingResult[] = [];
    const held: HeldItem[] = [];

    // --- IDEMPOTENCY: what did a previous run of this trip already commit? ---
    // Keyed by the deterministic bookingRecordId, scoped to THIS rail — the same itemId booked on a
    // different rail is a different commitment.
    const priorConfirmed = new Map<string, BookingRecord>();
    /** Items whose `book` was ENTERED but never resolved — see the write-before-act marker in the
     *  commit loop. We genuinely do not know whether the money moved, so we refuse to guess. */
    const priorInFlight = new Map<string, BookingRecord>();
    for (const rec of await this.store.all(manifest.tripId)) {
      if (rec.rail !== this.rail.railId) continue;
      if (rec.status === "confirmed") priorConfirmed.set(rec.itemId, rec);
      else if (rec.status === "held" && !rec.railRef) priorInFlight.set(rec.itemId, rec);
    }
    /** Already-paid spend, which still counts against the caps — otherwise a retry loop would be a
     *  way to walk past the budget one item at a time. */
    const settled: { category: BookingCategory; priceCents: number }[] = [];

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
      // Already bought on a previous run: replay it, never touch the rail again. This must come
      // before the `!item.chosen` guard — a confirmed booking stands even if the manifest that
      // produced it can no longer re-resolve a candidate.
      const done = priorConfirmed.get(itemId);
      if (done) {
        settled.push({ category, priceCents: done.amountCents });
        results.push({ itemId, status: "confirmed", confirmationCode: done.confirmationCode, error: null });
        continue;
      }
      // Ambiguous: a previous run entered book() for this item and never recorded the outcome. The
      // booking may exist on the rail. Re-booking risks charging twice; skipping risks stranding a
      // live booking. Both are worse than stopping, so stop — loudly, with the id to reconcile.
      const inFlight = priorInFlight.get(itemId);
      if (inFlight) {
        const msg = `item ${itemId}: in-flight booking ${inFlight.id} from a previous run never resolved — reconcile against the rail before retrying`;
        return unwind(msg, [], held.map((h) => ({ itemId: h.itemId, holdRef: h.holdRef })));
      }
      if (!item.chosen) {
        const id = bookingRecordId(manifest.tripId, itemId, this.rail.railId);
        await this.store.put({ id, tripId: manifest.tripId, itemId, rail: this.rail.railId, status: "failed", railRef: null, confirmationCode: null, amountCents: 0, error: "no candidate chosen" });
        results.push({ itemId, status: "failed", confirmationCode: null, error: "no candidate chosen" });
        return unwind(`item ${itemId}: no candidate chosen`, [], held.map((h) => ({ itemId: h.itemId, holdRef: h.holdRef })));
      }
      let hold;
      try {
        hold = await this.rail.hold(item.chosen.railSlotId, { partySize: item.intent.query.partySize, dateTime: item.chosen.startsAt });
      } catch (e) {
        // A rail whose hold() can throw (e.g. LiteAPI prebook with no locked/USD price) must NOT
        // abort executeStaged mid-flight and leak the prebooks already taken. Unwind: release the
        // holds gathered so far, record the failure, return the documented FAILED result.
        const msg = e instanceof Error ? e.message : String(e);
        const id = bookingRecordId(manifest.tripId, itemId, this.rail.railId);
        await this.store.put({ id, tripId: manifest.tripId, itemId, rail: this.rail.railId, status: "failed", railRef: null, confirmationCode: null, amountCents: 0, error: msg });
        await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId, actor, action: "hold_failed", rail: this.rail.railId, externalRef: null, amountCents: 0, detail: msg });
        results.push({ itemId, status: "failed", confirmationCode: null, error: msg });
        return unwind(`item ${itemId}: hold failed: ${msg}`, [], held.map((h) => ({ itemId: h.itemId, holdRef: h.holdRef })));
      }
      // MONEY-SAFETY: the spend-cap gate below must see the LOCKED (hold/prebook) price, not the
      // search quote — a two-price rail that drifts UP at hold time must be caught by the cap.
      const lockedCents = hold.slot.priceCents;
      await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId, actor, action: "hold", rail: this.rail.railId, externalRef: hold.holdRef, amountCents: lockedCents });
      // Push BEFORE the drift gate: this hold is live on the rail now, so it has to be in `held` or
      // the unwind below would release every hold EXCEPT the one that just failed — leaking a paid
      // prebook on every drift abort.
      held.push({ itemId, category, railSlotId: item.chosen.railSlotId, holdRef: hold.holdRef, expiresAt: hold.expiresAt, priceCents: lockedCents });

      // PHASE 2c MONEY-SAFETY: per-item drift gate. The cap gate is an aggregate check, so it only
      // catches drift big enough to breach a cap — and catches nothing at all when no caps are set.
      // A guest quoted 8,500 must never be committed at 9,900 just because the total stayed under
      // budget. Cheaper-than-quoted always passes; see checkPriceDrift.
      const driftError = checkPriceDrift(item.chosen.priceCents, lockedCents, ctx.driftTolerance);
      if (driftError) {
        const id = bookingRecordId(manifest.tripId, itemId, this.rail.railId);
        await this.store.put({ id, tripId: manifest.tripId, itemId, rail: this.rail.railId, status: "failed", railRef: null, confirmationCode: null, amountCents: lockedCents, error: driftError });
        await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId, actor, action: "price_drift_rejected", rail: this.rail.railId, externalRef: hold.holdRef, amountCents: lockedCents, detail: driftError });
        results.push({ itemId, status: "failed", confirmationCode: null, error: driftError });
        return unwind(`item ${itemId}: ${driftError}`, [], held.map((h) => ({ itemId: h.itemId, holdRef: h.holdRef })));
      }
    }

    // --- PENDING_CONFIRM: assemble priced trip + spend caps ---
    const capError = checkSpendCaps(
      [...settled, ...held.map((h) => ({ category: h.category, priceCents: h.priceCents }))],
      ctx.caps,
    );
    if (capError) {
      return unwind(capError, [], held.map((h) => ({ itemId: h.itemId, holdRef: h.holdRef })));
    }

    // --- COMMITTING: commit non-refundables shortest-hold-TTL-first ---
    const order = [...held].sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
    const booked: { itemId: string; railRef: string }[] = [];
    const committedOrder: string[] = [];
    for (let i = 0; i < order.length; i++) {
      const h = order[i]!;
      // Uncommitted holds from this point on — INCLUDING h itself, whose hold is taken but not
      // yet booked. On a failure here, h's own hold must be released too, never leaked.
      const uncommitted = order.slice(i).map((x) => ({ itemId: x.itemId, holdRef: x.holdRef }));
      const id = bookingRecordId(manifest.tripId, h.itemId, this.rail.railId);

      const nowMs = Date.parse(ctx.now);
      const expMs = Date.parse(h.expiresAt);
      if (Number.isNaN(expMs) || Number.isNaN(nowMs) || nowMs >= expMs) {
        results.push({ itemId: h.itemId, status: "failed", confirmationCode: null, error: "hold expired" });
        return unwind(`hold ${h.holdRef} expired at ${h.expiresAt}`, booked, uncommitted);
      }

      // WRITE-BEFORE-ACT: mark the item in-flight BEFORE the irreversible call. If the process dies
      // between book() and the confirmed write below, this record is the only evidence that money
      // may have moved — without it a retry re-books blind. `railRef: null` is what distinguishes
      // "we started" from "we finished"; the next run refuses to guess and asks for reconciliation.
      await this.store.put({ id, tripId: manifest.tripId, itemId: h.itemId, rail: this.rail.railId, status: "held", railRef: null, confirmationCode: null, amountCents: h.priceCents, error: null });

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
        return unwind(msg, booked, uncommitted);
      }
    }

    return { tripId: manifest.tripId, state: "CONFIRMED", results, committedOrder, compensations: [], failedCompensations: [], releasedHolds: [], error: null };
  }
}
