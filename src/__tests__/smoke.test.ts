import { describe, it, expect } from "vitest";
import { stripPII } from "../signals";

describe("shared-engine test harness", () => {
  it("imports and runs", () => {
    expect(stripPII({ keep: "yes" })).toEqual({ keep: "yes" });
  });
});
