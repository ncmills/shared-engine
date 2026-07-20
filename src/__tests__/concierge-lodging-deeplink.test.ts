import { describe, it, expect } from "vitest";
import { buildLodgingDeeplink, LODGING_HOST } from "../concierge/lodging-deeplink";

describe("buildLodgingDeeplink", () => {
  it("points at the correct per-tenant host", () => {
    expect(buildLodgingDeeplink({ tenant: "moh", railSlotId: "off-1" })).toContain("https://maidofhonorhq.com/stay/off-1");
    expect(buildLodgingDeeplink({ tenant: "bestman", railSlotId: "off-1" })).toContain("https://bestmanhq.com/stay/off-1");
    expect(buildLodgingDeeplink({ tenant: "handicaphq", railSlotId: "off-1" })).toContain("https://handicaphq.com/stay/off-1");
  });

  it("URL-encodes a slot id with special characters", () => {
    const url = buildLodgingDeeplink({ tenant: "moh", railSlotId: "off/1?x=2 y" });
    expect(url).toContain("/stay/off%2F1%3Fx%3D2%20y");
  });

  it("appends provided params in a stable (sorted) order and omits absent ones", () => {
    const url = buildLodgingDeeplink({ tenant: "moh", railSlotId: "off-1", partySize: 6, checkIn: "2026-08-01", checkOut: "2026-08-03" });
    expect(url).toBe("https://maidofhonorhq.com/stay/off-1?checkIn=2026-08-01&checkOut=2026-08-03&partySize=6");
  });

  it("is deterministic (same args -> same url) and carries NO PII", () => {
    const args = { tenant: "moh" as const, railSlotId: "off-1", partySize: 6 };
    const a = buildLodgingDeeplink(args);
    expect(buildLodgingDeeplink(args)).toBe(a);
    expect(a.toLowerCase()).not.toMatch(/email|name|@|lead/);
  });

  it("throws on an empty slot id (a link to nothing is a bug, not a blank)", () => {
    expect(() => buildLodgingDeeplink({ tenant: "moh", railSlotId: "" })).toThrow(/slot/i);
  });

  it("LODGING_HOST covers exactly the three concierge tenants", () => {
    expect(Object.keys(LODGING_HOST).sort()).toEqual(["bestman", "handicaphq", "moh"]);
  });
});
