import { describe, it, expect } from "vitest";
import { runConciergeStagedDryRun } from "../concierge/dry-run";
import type { BookingIntent } from "../concierge/types";

const intents: BookingIntent[] = [
  { itemId: "stay-1", category: "lodging", query: { area: "Nashville", dateTime: "2026-08-01T15:00:00Z", partySize: 6, maxPriceCents: 100000 } },
  { itemId: "tour-1", category: "activity", query: { area: "Austin", dateTime: "2026-08-02T14:00:00Z", partySize: 6, maxPriceCents: 100000 } },
];

describe("runConciergeStagedDryRun", () => {
  it("turns a mixed itinerary into a CONFIRMED staged trip within caps", async () => {
    const { manifest, staged } = await runConciergeStagedDryRun({
      tripId: "trip-dry-2",
      tenant: "moh",
      intents,
      now: "2026-07-20T12:00:00.000Z",
      priceCents: 8500,
      caps: { totalCapCents: 100000 },
    });
    expect(manifest.items).toHaveLength(2);
    expect(staged.state).toBe("CONFIRMED");
    expect(staged.committedOrder).toHaveLength(2);
  });

  it("FAILS and books nothing when the trip breaches the total cap", async () => {
    const { staged } = await runConciergeStagedDryRun({
      tripId: "trip-dry-3",
      tenant: "moh",
      intents,
      now: "2026-07-20T12:00:00.000Z",
      priceCents: 8500,
      caps: { totalCapCents: 10000 },
    });
    expect(staged.state).toBe("FAILED");
    expect(staged.results.some((r) => r.status === "confirmed")).toBe(false);
  });
});
