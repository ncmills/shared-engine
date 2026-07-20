import type { BookingRail, RailSearchQuery, HoldResult, BookResult } from "./rail";
import type { RailSlot, CancellationPolicy, BookingStatus } from "./types";

export interface LiteAPIAdapterOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** Convert a rail's decimal price (USD) to integer cents, or null if it is not a usable number.
 *  MONEY-SAFETY: callers must EXCLUDE or THROW on null — never coalesce to 0 (that would silently
 *  disable the spend-caps guardrail). See is-this-worth-it §"price_cents ?? 0". */
function toCents(amount: unknown): number | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100);
}

function toPolicy(offer: { refundable?: unknown; freeCancelUntil?: unknown; refundAmount?: unknown }): CancellationPolicy {
  const refundable = !!offer.refundable;
  if (!refundable) return { refundable: false, freeCancelUntil: null, refundAmountCents: null };
  return {
    refundable: true,
    freeCancelUntil: typeof offer.freeCancelUntil === "string" ? offer.freeCancelUntil : null,
    refundAmountCents: toCents(offer.refundAmount),
  };
}

/** LiteAPI lodging rail. The first rail with a real TWO-PRICE flow: `hold` (LiteAPI prebook) locks a
 *  price that can differ from the `search` price. That locked price is the authoritative one and is
 *  written into `HoldResult.slot.priceCents`; drift vs the searched price is detectable via
 *  `checkPriceDrift`. Wiring drift into the orchestrator cap check is deferred to 2c (live). */
export class LiteAPIAdapter implements BookingRail {
  readonly railId = "liteapi";
  private fetchImpl: typeof fetch;
  constructor(private opts: LiteAPIAdapterOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async req(path: string, init?: RequestInit): Promise<any> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      ...init,
      headers: { "X-API-Key": this.opts.apiKey, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`LiteAPI ${path} -> ${res.status}`);
    return res.json();
  }

  async search(q: RailSearchQuery): Promise<RailSlot[]> {
    const data = await this.req(`/rates`, { method: "POST", body: JSON.stringify({ area: q.area, checkin: q.dateTime, guests: q.partySize }) });
    const slots: RailSlot[] = [];
    for (const offer of data.offers ?? []) {
      const cents = toCents(offer.price?.amount);
      if (cents == null) continue; // MONEY-SAFETY: drop un-priced offers rather than zero them.
      slots.push({
        railSlotId: offer.offerId,
        label: offer.name ?? offer.offerId,
        priceCents: cents,
        startsAt: offer.checkin ?? q.dateTime,
        cancellation: toPolicy(offer),
      });
    }
    return slots;
  }

  async getCancellationPolicy(railSlotId: string): Promise<CancellationPolicy> {
    const data = await this.req(`/rates/${encodeURIComponent(railSlotId)}`);
    return toPolicy(data.offer ?? data);
  }

  async hold(railSlotId: string, ctx: { partySize: number; dateTime: string }): Promise<HoldResult> {
    const data = await this.req(`/rates/prebook`, { method: "POST", body: JSON.stringify({ offerId: railSlotId, guests: ctx.partySize, checkin: ctx.dateTime }) });
    const cents = toCents(data.price?.amount);
    if (cents == null) {
      // MONEY-SAFETY: a prebook with no locked price cannot be booked safely — fail loud.
      throw new Error(`LiteAPI prebook ${railSlotId} returned no usable price`);
    }
    if (typeof data.prebookId !== "string" || data.prebookId.length === 0) {
      throw new Error(`LiteAPI prebook ${railSlotId} returned no prebookId`);
    }
    return {
      holdRef: data.prebookId,
      expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : "",
      slot: {
        railSlotId,
        label: railSlotId,
        priceCents: cents, // authoritative LOCKED price (may drift from search)
        startsAt: ctx.dateTime,
        cancellation: toPolicy(data),
      },
    };
  }

  async book(holdRef: string, ctx: { leadName: string; leadEmail: string }): Promise<BookResult> {
    const data = await this.req(`/rates/book`, { method: "POST", body: JSON.stringify({ prebookId: holdRef, holder: { name: ctx.leadName, email: ctx.leadEmail } }) });
    // MONEY-SAFETY: a null/empty booking id would let a later status()/cancel() target nothing and
    // invite a double-book. Refuse to return one.
    if (typeof data.bookingId !== "string" || data.bookingId.length === 0) {
      throw new Error(`LiteAPI book returned a missing booking id for prebook ${holdRef}`);
    }
    const cents = toCents(data.price?.amount);
    if (cents == null) {
      throw new Error(`LiteAPI book ${data.bookingId} returned a non-finite amount`);
    }
    return {
      railRef: data.bookingId,
      confirmationCode: typeof data.confirmation === "string" ? data.confirmation : data.bookingId,
      amountCents: cents,
    };
  }

  async cancel(railRef: string): Promise<{ refundAmountCents: number }> {
    const data = await this.req(`/bookings/${encodeURIComponent(railRef)}`, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) });
    return { refundAmountCents: toCents(data.refund?.amount) ?? 0 };
  }

  /** Prebooks are transient — LiteAPI has no prebook-cancel endpoint; an un-booked prebook simply
   *  expires. Releasing is therefore a resolving no-op (matches the BookingRail contract note). */
  async release(_holdRef: string): Promise<void> {
    return;
  }

  async status(railRef: string): Promise<BookingStatus> {
    const data = await this.req(`/bookings/${encodeURIComponent(railRef)}`);
    const s = String(data.status ?? "").toLowerCase();
    if (s === "confirmed" || s === "booked") return "confirmed";
    if (s === "cancelled" || s === "canceled") return "cancelled";
    return "pending";
  }
}
