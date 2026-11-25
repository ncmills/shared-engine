import type { BookingRail, RailSearchQuery, HoldResult, BookResult, ReconcileOutcome } from "./rail";
import type { RailSlot, CancellationPolicy, BookingStatus } from "./types";

/** Integer USD cents from a GetYourGuide price, or null when it is not a usable rate.
 *  MONEY-SAFETY: callers must EXCLUDE or THROW on null — never coalesce to 0. A 0 defeats every
 *  guardrail at once: `checkSpendCaps` sums it as free, `checkPriceDrift(0, 0)` sees no drift, and
 *  `validateChoice`'s paid-item policy check is skipped by its own `priceCents > 0` guard. The
 *  adapter previously did `price_cents ?? 0` in four places, which booked a paid tour as free with
 *  every gate green. Accepts either the legacy `*_cents` integer or GYG's documented
 *  `{ value, currency }` money object; rejects non-USD, since the engine is USD-only and scaling a
 *  EUR amount as USD cents injects a phantom sum into caps + audit. */
function gygMoneyToCents(cents: unknown, money: unknown): number | null {
  if (typeof cents === "number" && Number.isFinite(cents) && cents > 0) return Math.round(cents);
  if (money && typeof money === "object") {
    const value = (money as { value?: unknown }).value;
    const currency = (money as { currency?: unknown }).currency;
    if (currency !== "USD") return null;
    const n = typeof value === "string" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
    return Math.round(n * 100);
  }
  return null;
}

/** A partner id is interpolated into a URL that carries our bearer token. An id containing `/`,
 *  `..`, `?` or `#` would re-target the request at a different endpoint with credentials attached
 *  (composite ids like `venue/123` are enough). Encode every one. */
const seg = (v: unknown): string => encodeURIComponent(String(v ?? ""));

/** Non-empty after trimming — `" "` is not a booking reference. */
const isRef = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

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
    // EXCLUDE un-priced/non-USD offers rather than zeroing them — an offer we cannot price is an
    // offer we cannot guard.
    return (data.tours ?? []).flatMap((t: any): RailSlot[] => {
      const cents = gygMoneyToCents(t.price_cents, t.price);
      if (cents == null) return [];
      return [{
        railSlotId: t.id,
        label: t.title,
        priceCents: cents,
        startsAt: t.start_time,
        cancellation: toPolicy(t.cancellation),
      }];
    });
  }

  async getCancellationPolicy(railSlotId: string): Promise<CancellationPolicy> {
    const data = await this.req(`/1/tours/${seg(railSlotId)}/cancellation`);
    return toPolicy(data.cancellation ?? data);
  }

  async hold(railSlotId: string, ctx: { partySize: number; dateTime: string }): Promise<HoldResult> {
    const data = await this.req(`/1/reservations`, { method: "POST", body: JSON.stringify({ tour_id: railSlotId, date: ctx.dateTime, participants: ctx.partySize }) });
    const cents = gygMoneyToCents(data.price_cents, data.price);
    if (cents == null) {
      // No reservation ref is committed to yet, so throwing is safe — executeStaged unwinds.
      throw new Error(`GetYourGuide reservation for ${railSlotId} returned no usable (USD, >0) price`);
    }
    if (!isRef(data.reservation_id)) {
      throw new Error(`GetYourGuide reservation for ${railSlotId} returned no reservation id`);
    }
    return {
      holdRef: data.reservation_id,
      expiresAt: typeof data.expires_at === "string" ? data.expires_at : "",
      slot: { railSlotId, label: railSlotId, priceCents: cents, startsAt: ctx.dateTime, cancellation: toPolicy(data.cancellation) },
    };
  }

  async book(holdRef: string, ctx: { leadName: string; leadEmail: string }): Promise<BookResult> {
    // Idempotency-Key derived from the hold: stable across retries of the SAME hold, so a replayed
    // book() is deduped by the partner instead of creating a second tour. Also what makes
    // reconcile() answerable at all.
    const data = await this.req(`/1/bookings`, {
      method: "POST",
      headers: { "idempotency-key": holdRef },
      body: JSON.stringify({ reservation_id: holdRef, name: ctx.leadName, email: ctx.leadEmail }),
    });
    // MONEY-SAFETY (no ref): a missing/blank booking id means nothing was booked — refuse to return
    // a ref that a later cancel()/status() would target as `undefined`. Safe to throw.
    if (!isRef(data.booking_id)) {
      throw new Error(`GetYourGuide book returned a missing booking id for reservation ${holdRef}`);
    }
    // MONEY-SAFETY (live ref): once the id exists the tour is booked and charged — never throw over
    // a price parse. Report 0 and let the orchestrator fall back to the locked hold price.
    return {
      railRef: data.booking_id,
      confirmationCode: isRef(data.voucher_code) ? data.voucher_code : data.booking_id,
      amountCents: gygMoneyToCents(data.amount_cents, data.amount) ?? 0,
    };
  }

  async cancel(railRef: string): Promise<{ refundAmountCents: number }> {
    const data = await this.req(`/1/bookings/${seg(railRef)}`, { method: "DELETE" });
    // Never throw over a refund parse — that would abort compensation mid-unwind.
    return { refundAmountCents: gygMoneyToCents(data.refund_cents, data.refund) ?? 0 };
  }

  async release(holdRef: string): Promise<void> {
    await this.req(`/1/reservations/${seg(holdRef)}`, { method: "DELETE" });
  }

  async status(railRef: string): Promise<BookingStatus> {
    const data = await this.req(`/1/bookings/${seg(railRef)}`);
    return data.status === "confirmed" ? "confirmed" : data.status === "cancelled" ? "cancelled" : "pending";
  }
}
