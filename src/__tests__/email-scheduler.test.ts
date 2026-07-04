// src/__tests__/email-scheduler.test.ts
import { describe, it, expect } from "vitest";
import { buildWelcomeSchedule, scheduleWelcomeSequence } from "../email-scheduler";

describe("email-scheduler", () => {
  it("computes send_at from hour offsets (1-based step)", () => {
    const rows = buildWelcomeSchedule(
      [{ step: 1, sendAtOffsetHours: 0, template: "welcome" }, { step: 2, sendAtOffsetHours: 24, template: "tips" }],
      "2026-07-03T00:00:00.000Z"
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.step).toBe(1);
    expect(rows[0]!.send_at).toBe("2026-07-03T00:00:00.000Z");
    expect(rows[1]!.send_at).toBe("2026-07-04T00:00:00.000Z");
  });

  it("throws before touching the DB when a step is 0 (violates DB CHECK 1..10)", async () => {
    const fakeSupabase = {
      from: () => ({
        upsert: async () => {
          throw new Error("should never be called — validation must throw first");
        },
      }),
    } as unknown as import("@supabase/supabase-js").SupabaseClient;

    await expect(
      scheduleWelcomeSequence(fakeSupabase, {
        brand: "moh",
        email: "test@example.com",
        sequence: [{ step: 0, sendAtOffsetHours: 0, template: "welcome" }],
        nowIso: "2026-07-03T00:00:00.000Z",
      })
    ).rejects.toThrow(/step must be 1\.\.10, got 0/);
  });

  it("throws when a step is > 10 (violates DB CHECK 1..10)", async () => {
    const fakeSupabase = {
      from: () => ({
        upsert: async () => {
          throw new Error("should never be called — validation must throw first");
        },
      }),
    } as unknown as import("@supabase/supabase-js").SupabaseClient;

    await expect(
      scheduleWelcomeSequence(fakeSupabase, {
        brand: "moh",
        email: "test@example.com",
        sequence: [{ step: 11, sendAtOffsetHours: 0, template: "welcome" }],
        nowIso: "2026-07-03T00:00:00.000Z",
      })
    ).rejects.toThrow(/step must be 1\.\.10, got 11/);
  });

  it("throws (does not swallow) when the Supabase upsert returns an error", async () => {
    const fakeSupabase = {
      from: () => ({
        upsert: async () => ({ error: { message: "duplicate key value violates unique constraint" } }),
      }),
    } as unknown as import("@supabase/supabase-js").SupabaseClient;

    await expect(
      scheduleWelcomeSequence(fakeSupabase, {
        brand: "moh",
        email: "test@example.com",
        sequence: [{ step: 1, sendAtOffsetHours: 0, template: "welcome" }],
        nowIso: "2026-07-03T00:00:00.000Z",
      })
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it("returns { scheduled: N } on success", async () => {
    const fakeSupabase = {
      from: () => ({
        upsert: async () => ({ error: null }),
      }),
    } as unknown as import("@supabase/supabase-js").SupabaseClient;

    const result = await scheduleWelcomeSequence(fakeSupabase, {
      brand: "moh",
      email: "test@example.com",
      sequence: [
        { step: 1, sendAtOffsetHours: 0, template: "welcome" },
        { step: 2, sendAtOffsetHours: 24, template: "tips" },
      ],
      nowIso: "2026-07-03T00:00:00.000Z",
    });

    expect(result).toEqual({ scheduled: 2 });
  });
});
