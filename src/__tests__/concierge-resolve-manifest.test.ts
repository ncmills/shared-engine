import { describe, it, expect } from "vitest";
import { resolveManifest, DeterministicProposalSource } from "../concierge/resolver";
import { MockRail } from "../concierge/mock-rail";
import type { BookingIntent } from "../concierge/types";

const mixed: BookingIntent[] = [
  { itemId: "stay-1", category: "lodging", query: { area: "Nashville", dateTime: "2026-08-01T15:00:00Z", partySize: 6, maxPriceCents: 100000 } },
  { itemId: "tour-1", category: "activity", query: { area: "Nashville", dateTime: "2026-08-02T14:00:00Z", partySize: 6, maxPriceCents: 20000 } },
];

describe("resolveManifest", () => {
  it("resolves intents of mixed categories against one rail", async () => {
    const manifest = await resolveManifest({
      tripId: "trip-1",
      tenant: "moh",
      intents: mixed,
      rail: new MockRail({ priceCents: 8500 }),
      proposals: new DeterministicProposalSource(),
    });
    expect(manifest.items.map((i) => i.intent.category)).toEqual(["lodging", "activity"]);
    expect(manifest.items.every((i) => i.chosen !== null)).toBe(true);
  });

  it("still applies the budget-cap guardrail per intent", async () => {
    const manifest = await resolveManifest({
      tripId: "trip-2",
      tenant: "moh",
      intents: [{ itemId: "x", category: "lodging", query: { area: "Z", dateTime: "2026-08-01T15:00:00Z", partySize: 6, maxPriceCents: 100 } }],
      rail: new MockRail({ priceCents: 8500 }),
      proposals: new DeterministicProposalSource(),
    });
    expect(manifest.items[0]!.chosen).toBeNull();
  });
});
