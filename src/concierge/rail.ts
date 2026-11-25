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
   *  Returns a THREE-valued outcome, deliberately. The original signature was `BookResult | null`,
   *  which made "provably not booked" and "I cannot tell" the same value — and the type system
   *  rewarded the dangerous one, because `return null` is the obvious not-found branch an
   *  implementer reaches for on a 404. A 404 from a partner routinely means read-replica lag on a
   *  just-created booking, not absence. `unknown` now has to be constructed deliberately, and a
   *  reviewer can grep for it.
   *
   *  Asymmetry to keep in mind while implementing: a wrong `not_booked` makes the engine release the
   *  hold and book again — a double charge on a non-refundable rate. A wrong `unknown` costs a
   *  manual reconciliation. When in doubt, return `unknown`. */
  reconcile?(holdRef: string): Promise<ReconcileOutcome>;
}

/** Three-valued reconciliation result — see `BookingRail.reconcile`. */
export type ReconcileOutcome =
  /** The rail confirms a booking exists for this hold. */
  | { outcome: "booked"; result: BookResult }
  /** The rail can positively demonstrate no booking was created. Only return this when the rail
   *  genuinely knows — never as a stand-in for "I looked and didn't find it". */
  | { outcome: "not_booked" }
  /** The rail cannot determine the answer. The engine will stop and ask for human reconciliation. */
  | { outcome: "unknown"; detail?: string };
