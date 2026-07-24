import { describe, it, expect } from "vitest";
import { getConciergeTenantConfig, type ConciergeTenant } from "../concierge/tenant";

describe("concierge tenant config", () => {
  it("returns config for the three valid tenants", () => {
    const tenants: ConciergeTenant[] = ["moh", "bestman", "handicaphq"];
    for (const t of tenants) {
      const cfg = getConciergeTenantConfig(t);
      expect(cfg.tenant).toBe(t);
      expect(cfg.categories).toContain("dining");
      expect(cfg.feeAmountCents).toBeGreaterThan(0);
      expect(cfg.currency).toBe("USD");
    }
  });

  it("gives handicaphq a golf category, moh/bestman do not", () => {
    expect(getConciergeTenantConfig("handicaphq").categories).toContain("golf");
    expect(getConciergeTenantConfig("moh").categories).not.toContain("golf");
  });

  it("throws for an unknown tenant", () => {
    // @ts-expect-error offsite is not a concierge tenant
    expect(() => getConciergeTenantConfig("offsite")).toThrow();
  });
});
