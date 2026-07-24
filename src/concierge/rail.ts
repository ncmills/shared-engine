import type { RailSlot, CancellationPolicy, BookingStatus } from "./types";

export interface RailSearchQuery {
  area: string;
  dateTime: string;
  partySize: number;
  keywords?: string[];
  maxPriceCents?: number;
}

export interface HoldResult {
  holdRef: string;
  expiresAt: string; // ISO8601
  slot: RailSlot;
}

export interface BookResult {
  railRef: string;
  confirmationCode: string;
  amountCents: number;
}

/** Thrown by an adapter when the rail DEFINITIVELY did not create a booking — a 4xx with a body
 *  saying so, a validation refusal, a sold-out rate. The distinction is money-critical: any OTHER
 *  throw from `book()` (timeout, socket hang-up, 5xx, DNS) is AMBIGUOUS — the supplier may well
 *  have committed and only the response was lost — and the engine must treat it as in-flight rather
 *  than as a clean failure it is free to retry.
 *
 *  Default to NOT throwing this. An ambiguous error mis-labelled as definitive causes a double
 *  charge; a definitive error left ambiguous only costs a reconciliation. */
export class RailRejectedError extends Error {
  readonly definitive = true as const;
  constructor(message: string) {
    super(message);
    this.name = "RailRejectedError";
  }
}

/** Every rail (mock, OpenTable, LiteAPI, GetYourGuide) implements this. */
export interface BookingRail {
  readonly railId: string;
  search(q: RailSearchQuery): Promise<RailSlot[]>;
  getCancellationPolicy(railSlotId: string): Promise<CancellationPolicy>;
  hold(railSlotId: string, ctx: { partySize: number; dateTime: string }): Promise<HoldResult>;
  book(holdRef: string, ctx: { leadName: string; leadEmail: string }): Promise<BookResult>;
  cancel(railRef: string): Promise<{ refundAmountCents: number }>;
  /** Drop an uncommitted hold (no booking was made). Idempotent-friendly: releasing an
   *  unknown/expired hold should resolve, not throw, where the rail allows. */
  release(holdRef: string): Promise<void>;
  status(railRef: string): Promise<BookingStatus>;
  /** OPTIONAL reconciliation capability (Phase 2c). Answers "did a booking result from THIS holdRef?"
   *  for the crash window between `book()` being called and its result being recorded — the one case
   *  where `status(railRef)` is useless, because the railRef is precisely what we lost.
   *
   *  Return the BookResult if the rail did create a booking, or `null` if it provably did not.
   *  THROW if the rail cannot say — never return null on uncertainty, because the engine treats null
   *  as "safe to book". Rails that cannot answer at all should leave this undefined: the engine then
   *  refuses to guess and asks for human reconciliation, which is the correct degraded behaviour. */
  reconcile?(holdRef: string): Promise<BookResult | null>;
}
