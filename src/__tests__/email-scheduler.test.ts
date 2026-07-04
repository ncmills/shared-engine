// src/__tests__/email-scheduler.test.ts
import { describe, it, expect } from "vitest";
import { buildWelcomeSchedule } from "../email-scheduler";

describe("email-scheduler", () => {
  it("computes send_at from hour offsets", () => {
    const rows = buildWelcomeSchedule(
      [{ step: 0, sendAtOffsetHours: 0, template: "welcome" }, { step: 1, sendAtOffsetHours: 24, template: "tips" }],
      "2026-07-03T00:00:00.000Z"
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.send_at).toBe("2026-07-03T00:00:00.000Z");
    expect(rows[1]!.send_at).toBe("2026-07-04T00:00:00.000Z");
  });
});
