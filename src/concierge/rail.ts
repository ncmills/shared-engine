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

/** Every rail (mock, OpenTable, LiteAPI, GetYourGuide) implements this. */
export interface BookingRail {
  readonly railId: string;
  search(q: RailSearchQuery): Promise<RailSlot[]>;
  getCancellationPolicy(railSlotId: string): Promise<CancellationPolicy>;
  hold(railSlotId: string, ctx: { partySize: number; dateTime: string }): Promise<HoldResult>;
  book(holdRef: string, ctx: { leadName: string; leadEmail: string }): Promise<BookResult>;
  cancel(railRef: string): Promise<{ refundAmountCents: number }>;
  status(railRef: string): Promise<BookingStatus>;
}
