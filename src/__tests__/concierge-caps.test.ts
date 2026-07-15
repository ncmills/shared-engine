import { describe, it, expect } from "vitest";
import { checkSpendCaps } from "../concierge/caps";
import type { BookingCategory } from "../concierge/types";

const items = (rows: [BookingCategory, number][]) => rows.map(([category, priceCents]) => ({ category, priceCents }));

describe("checkSpendCaps", () => {
  it("returns null when no caps are provided", () => {
    expect(checkSpendCaps(items([["lodging", 50000]]), undefined)).toBeNull();
  });

  it("passes when total is at or under the total cap", () => {
    expect(checkSpendCaps(items([["lodging", 30000], ["activity", 20000]]), { totalCapCents: 50000 })).toBeNull();
  });

  it("rejects when total exceeds the total cap", () => {
    const err = checkSpendCaps(items([["lodging", 30000], ["activity", 25000]]), { totalCapCents: 50000 });
    expect(err).toMatch(/total/i);
  });

  it("rejects when a single category exceeds its category cap", () => {
    const err = checkSpendCaps(items([["lodging", 60000], ["activity", 5000]]), { categoryCapsCents: { lodging: 50000 } });
    expect(err).toMatch(/lodging/i);
  });

  it("passes when each category is within its cap", () => {
    expect(checkSpendCaps(items([["lodging", 40000], ["activity", 8000]]), { categoryCapsCents: { lodging: 50000, activity: 10000 } })).toBeNull();
  });
});
