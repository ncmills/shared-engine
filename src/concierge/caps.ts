import type { BookingCategory } from "./types";

export interface SpendCaps {
  totalCapCents?: number;
  categoryCapsCents?: Partial<Record<BookingCategory, number>>;
}

/** Deterministic guardrail over the assembled trip. Returns an error string if any cap is
 *  exceeded, else null. Caps are inclusive maxima (total === cap is allowed). */
export function checkSpendCaps(
  items: { category: BookingCategory; priceCents: number }[],
  caps?: SpendCaps,
): string | null {
  if (!caps) return null;
  const total = items.reduce((s, i) => s + i.priceCents, 0);
  if (caps.totalCapCents != null && total > caps.totalCapCents) {
    return `trip total ${total} exceeds cap ${caps.totalCapCents}`;
  }
  if (caps.categoryCapsCents) {
    for (const [cat, cap] of Object.entries(caps.categoryCapsCents) as [BookingCategory, number][]) {
      if (cap == null) continue;
      const catTotal = items.filter((i) => i.category === cat).reduce((s, i) => s + i.priceCents, 0);
      if (catTotal > cap) return `${cat} total ${catTotal} exceeds cap ${cap}`;
    }
  }
  return null;
}
