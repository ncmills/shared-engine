import type { BookingRail, RailSearchQuery, HoldResult, BookResult } from "./rail";
import type { RailSlot, CancellationPolicy, BookingStatus } from "./types";

const DINING_POLICY: CancellationPolicy = { refundable: true, freeCancelUntil: null, refundAmountCents: 0 };

export interface OpenTableAdapterOpts {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class OpenTableAdapter implements BookingRail {
  readonly railId = "opentable";
  private fetchImpl: typeof fetch;
  constructor(private opts: OpenTableAdapterOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async req(path: string, init?: RequestInit): Promise<any> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`OpenTable ${path} -> ${res.status}`);
    return res.json();
  }

  async search(q: RailSearchQuery): Promise<RailSlot[]> {
    const data = await this.req(`/v2/search?area=${encodeURIComponent(q.area)}&party=${q.partySize}&time=${encodeURIComponent(q.dateTime)}`);
    return (data.slots ?? []).map((s: any): RailSlot => ({
      railSlotId: s.id,
      label: s.name,
      priceCents: 0,
      startsAt: s.time,
      cancellation: DINING_POLICY,
    }));
  }

  async getCancellationPolicy(): Promise<CancellationPolicy> {
    return DINING_POLICY;
  }

  async hold(railSlotId: string, ctx: { partySize: number; dateTime: string }): Promise<HoldResult> {
    const data = await this.req(`/v2/booking/${railSlotId}/slot_locks`, { method: "POST", body: JSON.stringify({ party: ctx.partySize, time: ctx.dateTime }) });
    return {
      holdRef: data.lock_id,
      expiresAt: data.expires_at,
      slot: { railSlotId, label: railSlotId, priceCents: 0, startsAt: ctx.dateTime, cancellation: DINING_POLICY },
    };
  }

  async book(holdRef: string, ctx: { leadName: string; leadEmail: string }): Promise<BookResult> {
    const data = await this.req(`/v2/reservations`, { method: "POST", body: JSON.stringify({ lock_id: holdRef, name: ctx.leadName, email: ctx.leadEmail }) });
    return { railRef: data.reservation_id, confirmationCode: data.confirmation, amountCents: 0 };
  }

  async cancel(railRef: string): Promise<{ refundAmountCents: number }> {
    await this.req(`/v2/reservations/${railRef}`, { method: "DELETE" });
    return { refundAmountCents: 0 };
  }

  async release(holdRef: string): Promise<void> {
    await this.req(`/v2/slot_locks/${holdRef}`, { method: "DELETE" });
  }

  async status(railRef: string): Promise<BookingStatus> {
    const data = await this.req(`/v2/reservations/${railRef}`);
    return data.status === "confirmed" ? "confirmed" : data.status === "cancelled" ? "cancelled" : "pending";
  }
}
