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

export class MockRail implements BookingRail {
  readonly railId = "mock";
  private booked = new Set<string>();
  private holdToSlot = new Map<string, string>();
  constructor(private opts: { failBookFor?: string[] } = {}) {}

  async search(q: RailSearchQuery): Promise<RailSlot[]> {
    const seed = hashStr(`${q.area}|${q.dateTime}|${q.partySize}`);
    const n = 3;
    return Array.from({ length: n }, (_, i) => ({
      railSlotId: `${q.area}-${(seed + i) % 1000}`,
      label: `${q.area} dining option ${i + 1}`,
      priceCents: 0,
      startsAt: q.dateTime,
      cancellation: FREE_CANCEL,
    }));
  }

  async getCancellationPolicy(): Promise<CancellationPolicy> {
    return FREE_CANCEL;
  }

  async hold(railSlotId: string, ctx: { partySize: number; dateTime: string }): Promise<HoldResult> {
    const holdRef = `hold-${railSlotId}`;
    this.holdToSlot.set(holdRef, railSlotId);
    return {
      holdRef,
      expiresAt: ctx.dateTime,
      slot: {
        railSlotId,
        label: railSlotId,
        priceCents: 0,
        startsAt: ctx.dateTime,
        cancellation: FREE_CANCEL,
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
    return { railRef, confirmationCode: `MOCK-${slotId}`, amountCents: 0 };
  }

  async cancel(railRef: string): Promise<{ refundAmountCents: number }> {
    this.booked.delete(railRef);
    return { refundAmountCents: 0 };
  }

  async status(railRef: string): Promise<BookingStatus> {
    return this.booked.has(railRef) ? "confirmed" : "cancelled";
  }
}
