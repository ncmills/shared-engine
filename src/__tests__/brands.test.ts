import { describe, it, expect } from "vitest";
import { logSelection, type Brand, type SignalPayload } from "../signals";

describe("Brand tag extension", () => {
  it("accepts all five brand tags at the type level", () => {
    const brands: Brand[] = ["moh", "bestman", "tdf", "offsite", "handicaphq"];
    expect(brands).toHaveLength(5);
  });
  it("accepts a SignalPayload branded offsite/handicaphq", () => {
    const a: SignalPayload = { brand: "offsite" };
    const b: SignalPayload = { brand: "handicaphq" };
    expect([a.brand, b.brand]).toEqual(["offsite", "handicaphq"]);
  });
  it("logSelection is callable with the new brands (no throw, fire-and-forget)", () => {
    expect(() => logSelection("offsite", { slot: "vibe", action: "add" })).not.toThrow();
    expect(() => logSelection("handicaphq", { slot: "course", action: "add" })).not.toThrow();
  });
});
