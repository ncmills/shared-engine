import { describe, it, expect } from "vitest";
import { stripPII } from "../signals";

describe("stripPII canonical superset", () => {
  it("strips new banned keys", () => {
    const out = stripPII({ ip: "1.2.3.4", ssn: "x", attendeeNames: ["a"], vid: "v1", city: "Austin" });
    expect(out).toEqual({ vid: "v1", city: "Austin" });
  });
  it("recurses into array elements", () => {
    const out = stripPII({ attendees: [{ email: "a@b.com", name: "A", role: "gm" }] } as Record<string, unknown>);
    // `attendees` itself is banned → dropped entirely
    expect(out).toEqual({});
  });
  it("scrubs PII nested inside a non-banned array", () => {
    const out = stripPII({ picks: [{ ip: "1.2.3.4", label: "keep" }] } as Record<string, unknown>);
    expect(out).toEqual({ picks: [{ label: "keep" }] });
  });
  it("preserves vid always", () => {
    expect(stripPII({ vid: "v" })).toEqual({ vid: "v" });
  });
});
