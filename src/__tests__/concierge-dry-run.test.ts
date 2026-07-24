import { describe, it, expect } from "vitest";
import { runConciergeDryRun } from "../concierge/dry-run";
import type { BookingIntent } from "../concierge/types";

const intents: BookingIntent[] = [
  { itemId: "welcome-dinner", category: "dining", query: { area: "Nashville", dateTime: "2026-08-01T19:00:00Z", partySize: 10 } },
  { itemId: "brunch", category: "dining", query: { area: "Nashville", dateTime: "2026-08-02T11:00:00Z", partySize: 10 } },
];

describe("runConciergeDryRun (wedge proof)", () => {
  it("turns dining intents into confirmed bookings end-to-end, no external calls", async () => {
    const { manifest, results } = await runConciergeDryRun({ tripId: "moh-demo", tenant: "moh", intents });
    expect(manifest.items).toHaveLength(2);
    expect(results.map((r) => r.status)).toEqual(["confirmed", "confirmed"]);
    expect(results.every((r) => r.confirmationCode?.startsWith("MOCK-"))).toBe(true);
  });
});
