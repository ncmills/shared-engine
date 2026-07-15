export type CurrencyCode = "USD";
export type BookingCategory = "lodging" | "activity" | "dining" | "golf";

// OO ('offsite') and 'tdf' are intentionally NOT concierge tenants — unrepresentable.
export type ConciergeTenant = "moh" | "bestman" | "handicaphq";

export interface CancellationPolicy {
  refundable: boolean;
  /** ISO8601 UTC deadline for a free cancel, or null if non-refundable / N/A */
  freeCancelUntil: string | null;
  refundAmountCents: number | null;
}

export interface RailSlot {
  railSlotId: string;
  label: string;
  priceCents: number; // 0 for dining
  startsAt: string; // ISO8601
  cancellation: CancellationPolicy;
}

export interface BookingIntent {
  itemId: string;
  category: BookingCategory;
  query: {
    area: string;
    dateTime: string; // ISO8601
    partySize: number;
    keywords?: string[];
    maxPriceCents?: number;
  };
}

export interface ManifestItem {
  intent: BookingIntent;
  candidates: RailSlot[];
  chosen: RailSlot | null;
  rail: string;
}

export interface BookingManifest {
  tripId: string;
  tenant: ConciergeTenant;
  items: ManifestItem[];
}

export type BookingStatus = "pending" | "held" | "confirmed" | "failed" | "cancelled";

export interface BookingRecord {
  id: string; // bookingRecordId(tripId,itemId,rail)
  tripId: string;
  itemId: string;
  rail: string;
  status: BookingStatus;
  railRef: string | null;
  confirmationCode: string | null;
  amountCents: number;
  error: string | null;
}

export interface BookingResult {
  itemId: string;
  status: BookingStatus;
  confirmationCode: string | null;
  error: string | null;
}

export function bookingRecordId(tripId: string, itemId: string, rail: string): string {
  return `${tripId}:${itemId}:${rail}`;
}
