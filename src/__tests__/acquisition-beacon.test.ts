import { describe, it, expect } from "vitest";
import { parseAcquisition } from "../acquisition-beacon";

describe("parseAcquisition", () => {
  it("extracts utm + coarse device", () => {
    const sp = new URLSearchParams("utm_source=reddit&utm_medium=social&utm_campaign=launch");
    const out = parseAcquisition(sp, "https://reddit.com/", "Mozilla/5.0 (iPhone)");
    expect(out.source).toBe("reddit");
    expect(out.medium).toBe("social");
    expect(out.device).toBe("mobile");
  });
  it("falls back to referrer host when no utm", () => {
    const out = parseAcquisition(new URLSearchParams(""), "https://news.ycombinator.com/", "Mozilla/5.0 (Macintosh)");
    expect(out.source).toContain("ycombinator");
    expect(out.device).toBe("desktop");
  });
  it("classifies iPad as mobile", () => {
    const out = parseAcquisition(new URLSearchParams(""), "", "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)");
    expect(out.device).toBe("mobile");
  });
});
