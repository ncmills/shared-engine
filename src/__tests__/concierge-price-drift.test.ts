import { describe, it, expect } from "vitest";
import { checkPriceDrift } from "../concierge/price-drift";

describe("checkPriceDrift", () => {
  it("returns null when the locked price equals the quoted price", () => {
    expect(checkPriceDrift(45000, 45000)).toBeNull();
  });

  it("returns null when the locked price is CHEAPER than quoted (drift in our favor)", () => {
    expect(checkPriceDrift(45000, 44000)).toBeNull();
  });

  it("flags an upward drift beyond zero tolerance, naming both amounts", () => {
    const err = checkPriceDrift(45000, 46500);
    expect(err).toBeTruthy();
    expect(err).toMatch(/45000/);
    expect(err).toMatch(/46500/);
  });

  it("allows upward drift within an absolute toleranceCents (inclusive)", () => {
    expect(checkPriceDrift(45000, 45500, { toleranceCents: 500 })).toBeNull();
    expect(checkPriceDrift(45000, 45501, { toleranceCents: 500 })).toBeTruthy();
  });

  it("allows upward drift within a fractional tolerance (inclusive)", () => {
    // 2% of 45000 = 900 cents
    expect(checkPriceDrift(45000, 45900, { toleranceFraction: 0.02 })).toBeNull();
    expect(checkPriceDrift(45000, 45901, { toleranceFraction: 0.02 })).toBeTruthy();
  });

  it("uses the MORE generous of the two tolerances when both are given", () => {
    // abs 500 vs fraction 2% (900) -> effective 900
    expect(checkPriceDrift(45000, 45900, { toleranceCents: 500, toleranceFraction: 0.02 })).toBeNull();
  });

  it("fails loud (never silently passes) on NaN / non-finite / negative inputs", () => {
    expect(checkPriceDrift(NaN, 45000)).toBeTruthy();
    expect(checkPriceDrift(45000, Number.POSITIVE_INFINITY)).toBeTruthy();
    expect(checkPriceDrift(-1, 45000)).toBeTruthy();
  });
});
