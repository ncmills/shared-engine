import type { BookingRail, RailSearchQuery, HoldResult, BookResult } from "./rail";
import type { RailSlot, CancellationPolicy, BookingStatus } from "./types";

export interface LiteAPIAdapterOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** Convert a LiteAPI money object `{ amount, currency }` to integer USD cents, or null when it is not
 *  a usable rate. MONEY-SAFETY: callers must EXCLUDE or THROW on null — never coalesce to 0 (that
 *  silently disables the spend-caps guardrail). Rejects:
 *   - a non-USD currency (the engine is USD-only; scaling e.g. a JPY amount as USD cents would inject
 *     a phantom sum into caps + audit),
 *   - a non-finite amount,
 *   - amount <= 0 (a lodging rate is never free; 0 is garbage, not a valid stay).
 *  See is-this-worth-it §"price_cents ?? 0". */
function moneyToCents(m: unknown): number | null {
  if (!m || typeof m !== "object") return null;
  const amount = (m as { amount?: unknown }).amount;
  const currency = (m as { currency?: unknown }).currency;
  if (currency !== "USD") return null;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100);
}

function toPolicy(offer: { refundable?: unknown; freeCancelUntil?: unknown; refundAmount?: unknown }): CancellationPolicy {
  const refundable = !!offer.refundable;
  if (!refundable) return { refundable: false, freeCancelUntil: null, refundAmountCents: null };
  const ra = offer.refundAmount;
  return {
    refundable: true,
    freeCancelUntil: typeof offer.freeCancelUntil === "string" ? offer.freeCancelUntil : null,
    refundAmountCents: typeof ra === "number" && Number.isFinite(ra) && ra >= 0 ? Math.round(ra * 100) : null,
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
      const cents = moneyToCents(offer.price);
      if (cents == null) continue; // MONEY-SAFETY: drop un-priced / non-USD / <=0 offers, never zero them.
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
    const cents = moneyToCents(data.price);
    if (cents == null) {
      // MONEY-SAFETY: a prebook with no usable (USD, >0) locked price cannot be booked safely. No
      // booking ref exists yet, so throwing is safe — executeStaged catches it and unwinds.
      throw new Error(`LiteAPI prebook ${railSlotId} returned no usable (USD, >0) price`);
    }
    if (typeof data.prebookId !== "string" || data.prebookId.trim().length === 0) {
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
    // Idempotency-Key derived from the prebook — a replayed book() is deduped by LiteAPI rather
    // than creating a second stay, and it is what makes a reconcile lookup answerable.
    const data = await this.req(`/rates/book`, {
      method: "POST",
      headers: { "idempotency-key": holdRef },
      body: JSON.stringify({ prebookId: holdRef, holder: { name: ctx.leadName, email: ctx.leadEmail } }),
    });
    // MONEY-SAFETY (no ref): a null/empty booking id means NOTHING was booked — refuse to return a
    // ref that a later status()/cancel() would target. Safe to throw (there is nothing to orphan).
    if (typeof data.bookingId !== "string" || data.bookingId.trim().length === 0) {
      throw new Error(`LiteAPI book returned a missing booking id for prebook ${holdRef}`);
    }
    // MONEY-SAFETY (live ref): once a booking id EXISTS the stay is booked and charged. We must NOT
    // throw over a price-parse problem — that would discard the ref and orphan a paid booking the
    // orchestrator can never compensate. Return the ref; record the amount best-effort (0 only if the
    // rail omitted/garbled it) and let downstream reconciliation correct the figure. The booking is real.
    const cents = moneyToCents(data.price);
    return {
      railRef: data.bookingId,
      confirmationCode: typeof data.confirmation === "string" ? data.confirmation : data.bookingId,
      amountCents: cents ?? 0,
    };
  }

  async cancel(railRef: string): Promise<{ refundAmountCents: number }> {
    const data = await this.req(`/bookings/${encodeURIComponent(railRef)}`, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) });
    // A successful cancel must never THROW over a refund-parse issue (that would abort compensation
    // mid-unwind and leave a booked item). Unknown/garbled refund records 0 — the conservative
    // (under-credit) direction; live reconciliation reconciles the true refund. Documented gap.
    return { refundAmountCents: moneyToCents(data.refund) ?? 0 };
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
