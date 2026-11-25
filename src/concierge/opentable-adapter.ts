import type { BookingRail, RailSearchQuery, HoldResult, BookResult } from "./rail";
import type { RailSlot, CancellationPolicy, BookingStatus } from "./types";

const DINING_POLICY: CancellationPolicy = { refundable: true, freeCancelUntil: null, refundAmountCents: 0 };

/** A partner id is interpolated into a URL carrying our bearer token; an id containing `/`, `..`,
 *  `?` or `#` would re-target the request at another endpoint with credentials attached. Encode. */
const seg = (v: unknown): string => encodeURIComponent(String(v ?? ""));

/** Non-empty after trimming — `" "` is not a reservation reference. */
const isRef = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

// NOTE on prices: dining is genuinely $0 through this rail (OpenTable moves no money), so the
// zeros below are correct, not the `?? 0` anti-pattern. If OpenTable ever returns a deposit or
// ticketed event price, it must go through a moneyToCents-style guard like LiteAPI/GYG.

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
    const data = await this.req(`/v2/booking/${seg(railSlotId)}/slot_locks`, { method: "POST", body: JSON.stringify({ party: ctx.partySize, time: ctx.dateTime }) });
    if (!isRef(data.lock_id)) {
      throw new Error(`OpenTable slot lock for ${railSlotId} returned no lock id`);
    }
    return {
      holdRef: data.lock_id,
      expiresAt: typeof data.expires_at === "string" ? data.expires_at : "",
      slot: { railSlotId, label: railSlotId, priceCents: 0, startsAt: ctx.dateTime, cancellation: DINING_POLICY },
    };
  }

  async book(holdRef: string, ctx: { leadName: string; leadEmail: string }): Promise<BookResult> {
    // Idempotency-Key derived from the hold — a replayed book() is deduped by the partner rather
    // than creating a second reservation.
    const data = await this.req(`/v2/reservations`, {
      method: "POST",
      headers: { "idempotency-key": holdRef },
      body: JSON.stringify({ lock_id: holdRef, name: ctx.leadName, email: ctx.leadEmail }),
    });
    // MONEY-SAFETY (no ref): a missing/blank reservation id means nothing was booked. Returning it
    // would put `undefined` into the booking record and later issue DELETE /reservations/undefined.
    if (!isRef(data.reservation_id)) {
      throw new Error(`OpenTable book returned a missing reservation id for lock ${holdRef}`);
    }
    return {
      railRef: data.reservation_id,
      confirmationCode: isRef(data.confirmation) ? data.confirmation : data.reservation_id,
      amountCents: 0,
    };
  }

  async cancel(railRef: string): Promise<{ refundAmountCents: number }> {
    await this.req(`/v2/reservations/${seg(railRef)}`, { method: "DELETE" });
    return { refundAmountCents: 0 };
  }

  async release(holdRef: string): Promise<void> {
    await this.req(`/v2/slot_locks/${seg(holdRef)}`, { method: "DELETE" });
  }

  async status(railRef: string): Promise<BookingStatus> {
    const data = await this.req(`/v2/reservations/${seg(railRef)}`);
    return data.status === "confirmed" ? "confirmed" : data.status === "cancelled" ? "cancelled" : "pending";
  }
}
