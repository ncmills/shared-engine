import { describe, it, expect } from "vitest";
import { runConciergeSagaDryRun } from "../concierge/dry-run";
import type { BookingIntent } from "../concierge/types";

const intents: BookingIntent[] = [
  { itemId: "tour-1", category: "activity", query: { area: "Nashville", dateTime: "2026-08-01T14:00:00Z", partySize: 6, maxPriceCents: 20000 } },
  { itemId: "tour-2", category: "activity", query: { area: "Austin", dateTime: "2026-08-02T14:00:00Z", partySize: 6, maxPriceCents: 20000 } },
];

describe("runConciergeSagaDryRun", () => {
  it("turns activity intents into confirmed (mock) bookings with a complete audit trail", async () => {
    const { manifest, saga, audit } = await runConciergeSagaDryRun({
      tripId: "trip-dry-1",
      tenant: "moh",
      intents,
      now: "2026-07-20T12:00:00.000Z",
      priceCents: 8500,
    });
    expect(manifest.items).toHaveLength(2);
    expect(saga.status).toBe("confirmed");
    expect(saga.results.every((r) => r.status === "confirmed")).toBe(true);
    // Audit completeness: a hold and a book per item.
    expect(audit.filter((e) => e.action === "hold")).toHaveLength(2);
    expect(audit.filter((e) => e.action === "book")).toHaveLength(2);
  });
});
