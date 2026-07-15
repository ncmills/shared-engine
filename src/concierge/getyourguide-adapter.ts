import type { BookingRail, RailSearchQuery, HoldResult, BookResult } from "./rail";
import type { RailSlot, CancellationPolicy, BookingStatus } from "./types";

export interface GetYourGuideAdapterOpts {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

function toPolicy(c: any): CancellationPolicy {
  if (!c) return { refundable: false, freeCancelUntil: null, refundAmountCents: null };
  return {
    refundable: !!c.refundable,
    freeCancelUntil: c.free_until ?? null,
    refundAmountCents: c.refund_cents ?? null,
  };
}

export class GetYourGuideAdapter implements BookingRail {
  readonly railId = "getyourguide";
  private fetchImpl: typeof fetch;
  constructor(private opts: GetYourGuideAdapterOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async req(path: string, init?: RequestInit): Promise<any> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`GetYourGuide ${path} -> ${res.status}`);
    return res.json();
  }

  async search(q: RailSearchQuery): Promise<RailSlot[]> {
    const data = await this.req(`/1/tours?location=${encodeURIComponent(q.area)}&date=${encodeURIComponent(q.dateTime)}&participants=${q.partySize}`);
    return (data.tours ?? []).map((t: any): RailSlot => ({
      railSlotId: t.id,
      label: t.title,
      priceCents: t.price_cents ?? 0,
      startsAt: t.start_time,
      cancellation: toPolicy(t.cancellation),
    }));
  }

  async getCancellationPolicy(railSlotId: string): Promise<CancellationPolicy> {
    const data = await this.req(`/1/tours/${railSlotId}/cancellation`);
    return toPolicy(data.cancellation ?? data);
  }

  async hold(railSlotId: string, ctx: { partySize: number; dateTime: string }): Promise<HoldResult> {
    const data = await this.req(`/1/reservations`, { method: "POST", body: JSON.stringify({ tour_id: railSlotId, date: ctx.dateTime, participants: ctx.partySize }) });
    return {
      holdRef: data.reservation_id,
      expiresAt: data.expires_at,
      slot: { railSlotId, label: railSlotId, priceCents: data.price_cents ?? 0, startsAt: ctx.dateTime, cancellation: toPolicy(data.cancellation) },
    };
  }

  async book(holdRef: string, ctx: { leadName: string; leadEmail: string }): Promise<BookResult> {
    const data = await this.req(`/1/bookings`, { method: "POST", body: JSON.stringify({ reservation_id: holdRef, name: ctx.leadName, email: ctx.leadEmail }) });
    return { railRef: data.booking_id, confirmationCode: data.voucher_code, amountCents: data.amount_cents ?? 0 };
  }

  async cancel(railRef: string): Promise<{ refundAmountCents: number }> {
    const data = await this.req(`/1/bookings/${railRef}`, { method: "DELETE" });
    return { refundAmountCents: data.refund_cents ?? 0 };
  }

  async status(railRef: string): Promise<BookingStatus> {
    const data = await this.req(`/1/bookings/${railRef}`);
    return data.status === "confirmed" ? "confirmed" : data.status === "cancelled" ? "cancelled" : "pending";
  }
}
