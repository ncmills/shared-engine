import { describe, it, expect } from "vitest";
import { resolveActivities, DeterministicProposalSource, validateChoice } from "../concierge/resolver";
import { MockRail } from "../concierge/mock-rail";
import type { BookingIntent } from "../concierge/types";

const activityIntents: BookingIntent[] = [
  { itemId: "tour-1", category: "activity", query: { area: "Nashville", dateTime: "2026-08-01T14:00:00Z", partySize: 6, maxPriceCents: 10000 } },
];

describe("resolveActivities", () => {
  it("produces a manifest with a chosen paid slot per activity intent", async () => {
    const manifest = await resolveActivities({
      tripId: "trip-1",
      tenant: "moh",
      intents: activityIntents,
      rail: new MockRail({ priceCents: 8500 }),
      proposals: new DeterministicProposalSource(),
    });
    expect(manifest.items[0]!.chosen).not.toBeNull();
    expect(manifest.items[0]!.chosen!.priceCents).toBe(8500);
  });

  it("leaves chosen null when every candidate exceeds the budget cap", async () => {
    const manifest = await resolveActivities({
      tripId: "trip-2",
      tenant: "moh",
      intents: [{ itemId: "t", category: "activity", query: { area: "Z", dateTime: "2026-08-01T14:00:00Z", partySize: 6, maxPriceCents: 100 } }],
      rail: new MockRail({ priceCents: 8500 }),
      proposals: new DeterministicProposalSource(),
    });
    expect(manifest.items[0]!.chosen).toBeNull();
  });

  it("throws when a non-activity intent reaches resolveActivities", async () => {
    await expect(
      resolveActivities({
        tripId: "trip-3",
        tenant: "moh",
        intents: [{ itemId: "d", category: "dining", query: { area: "A", dateTime: "2026-08-01T19:00:00Z", partySize: 4 } }],
        rail: new MockRail(),
        proposals: new DeterministicProposalSource(),
      }),
    ).rejects.toThrow(/non-activity/);
  });

  it("guardrail rejects a PAID slot whose refundable policy has no deadline and no refund amount", () => {
    const err = validateChoice(
      { itemId: "x", category: "activity", query: { area: "A", dateTime: "2026-08-01T14:00:00Z", partySize: 2 } },
      { railSlotId: "s", label: "s", priceCents: 5000, startsAt: "2026-08-01T14:00:00Z", cancellation: { refundable: true, freeCancelUntil: null, refundAmountCents: 0 } },
    );
    expect(err).toMatch(/policy/i);
  });

  it("guardrail allows a paid slot with a concrete free-cancel deadline", () => {
    const err = validateChoice(
      { itemId: "x", category: "activity", query: { area: "A", dateTime: "2026-08-01T14:00:00Z", partySize: 2 } },
      { railSlotId: "s", label: "s", priceCents: 5000, startsAt: "2026-08-01T14:00:00Z", cancellation: { refundable: true, freeCancelUntil: "2026-07-30T00:00:00Z", refundAmountCents: 5000 } },
    );
    expect(err).toBeNull();
  });
});
