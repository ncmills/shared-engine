import { describe, it, expect } from "vitest";
import { buildPriorsOverlay, overlayRedisKey } from "../priors-builder";

describe("priors-builder", () => {
  it("namespaces the overlay key per brand", () => {
    expect(overlayRedisKey("offsite")).toContain("offsite");
    expect(overlayRedisKey("handicaphq")).toContain("handicaphq");
  });
  it("gates fields below minSamples out of the overlay", async () => {
    // supabase null + redis null → zero samples → empty overlay
    const res = await buildPriorsOverlay({ brand: "offsite", fields: ["vibeTags"], supabase: null, redis: null, minSamples: 20 });
    expect(res.sampleCount).toBe(0);
    expect(res.overlay).toEqual({});
  });
});
