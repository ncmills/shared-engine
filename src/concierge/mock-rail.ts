import type { BookingRail, RailSearchQuery, HoldResult, BookResult } from "./rail";
import type { RailSlot, CancellationPolicy, BookingStatus } from "./types";

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const FREE_CANCEL: CancellationPolicy = {
  refundable: true,
  freeCancelUntil: null,
  refundAmountCents: 0,
};

// Far-future sentinels keep the happy path from ever tripping the hold-expiry guard.
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";

export interface MockRailOpts {
  failBookFor?: string[];
  /** Slot ids whose cancel should throw — simulates a rail that fails to compensate. */
  failCancelFor?: string[];
  /** Slot ids whose release should throw — simulates a rail that fails to drop a hold. */
  failReleaseFor?: string[];
  /** >0 makes this a paid (activity-style) rail with a refundable policy. */
  priceCents?: number;
  /** Price LOCKED at hold time when it differs from the search quote — makes MockRail a two-price
   *  rail like LiteAPI's prebook. Defaults to `priceCents` (single-price, the historical behaviour).
   *  Exists so drift can be exercised without standing up the LiteAPI sandbox. */
  holdPriceCents?: number;
  /** Override the hold expiry; a past ISO simulates an already-expired hold. */
  holdExpiresAt?: string;
  /** Per-slot hold expiry override (wins over holdExpiresAt) — lets tests set distinct TTLs. */
  holdExpiresBySlot?: Record<string, string>;
  /** What cancel refunds; defaults to priceCents. */
  refundAmountCents?: number;
}

export class MockRail implements BookingRail {
  readonly railId = "mock";
  private booked = new Set<string>();
  private holdToSlot = new Map<string, string>();
  constructor(private opts: MockRailOpts = {}) {}

  private policy(): CancellationPolicy {
    const price = this.opts.priceCents ?? 0;
    if (price > 0) {
      return { refundable: true, freeCancelUntil: FAR_FUTURE, refundAmountCents: this.opts.refundAmountCents ?? price };
    }
    return FREE_CANCEL;
  }

  async search(q: RailSearchQuery): Promise<RailSlot[]> {
    const seed = hashStr(`${q.area}|${q.dateTime}|${q.partySize}`);
    const price = this.opts.priceCents ?? 0;
    const n = 3;
    return Array.from({ length: n }, (_, i) => ({
      railSlotId: `${q.area}-${(seed + i) % 1000}`,
      label: `${q.area} option ${i + 1}`,
      priceCents: price,
      startsAt: q.dateTime,
      cancellation: this.policy(),
    }));
  }

  async getCancellationPolicy(): Promise<CancellationPolicy> {
    return this.policy();
  }

  async hold(railSlotId: string, ctx: { partySize: number; dateTime: string }): Promise<HoldResult> {
    const holdRef = `hold-${railSlotId}`;
    this.holdToSlot.set(holdRef, railSlotId);
    return {
      holdRef,
      expiresAt: this.opts.holdExpiresBySlot?.[railSlotId] ?? this.opts.holdExpiresAt ?? FAR_FUTURE,
      slot: {
        railSlotId,
        label: railSlotId,
        priceCents: this.opts.holdPriceCents ?? this.opts.priceCents ?? 0,
        startsAt: ctx.dateTime,
        cancellation: this.policy(),
      },
    };
  }

  async book(holdRef: string, _ctx: { leadName: string; leadEmail: string }): Promise<BookResult> {
    const slotId = this.holdToSlot.get(holdRef) ?? holdRef.replace(/^hold-/, "");
    if (this.opts.failBookFor?.includes(slotId)) {
      throw new Error(`MockRail: booking refused for ${slotId}`);
    }
    const railRef = `ref-${slotId}`;
    this.booked.add(railRef);
    return { railRef, confirmationCode: `MOCK-${slotId}`, amountCents: this.opts.priceCents ?? 0 };
  }

  async cancel(railRef: string): Promise<{ refundAmountCents: number }> {
    const slotId = railRef.replace(/^ref-/, "");
    if (this.opts.failCancelFor?.includes(slotId)) {
      throw new Error(`MockRail: cancel refused for ${railRef}`);
    }
    this.booked.delete(railRef);
    return { refundAmountCents: this.opts.refundAmountCents ?? this.opts.priceCents ?? 0 };
  }

  async release(holdRef: string): Promise<void> {
    const slotId = this.holdToSlot.get(holdRef) ?? holdRef.replace(/^hold-/, "");
    if (this.opts.failReleaseFor?.includes(slotId)) {
      throw new Error(`MockRail: release refused for ${holdRef}`);
    }
    this.holdToSlot.delete(holdRef);
  }

  async status(railRef: string): Promise<BookingStatus> {
    return this.booked.has(railRef) ? "confirmed" : "cancelled";
  }

  /** Reconciliation capability — mirrors `book`'s holdRef→railRef derivation, then reports whether
   *  that booking actually exists. Deterministic; no guessing. */
  async reconcile(holdRef: string): Promise<BookResult | null> {
    const slotId = this.holdToSlot.get(holdRef) ?? holdRef.replace(/^hold-/, "");
    const railRef = `ref-${slotId}`;
    if (!this.booked.has(railRef)) return null;
    return { railRef, confirmationCode: `MOCK-${slotId}`, amountCents: this.opts.priceCents ?? 0 };
  }
}
