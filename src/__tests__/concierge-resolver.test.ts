import { describe, it, expect } from "vitest";
import { resolveDining, DeterministicProposalSource, validateChoice, type ProposalSource } from "../concierge/resolver";
import { MockRail } from "../concierge/mock-rail";
import type { BookingIntent } from "../concierge/types";

const intents: BookingIntent[] = [
  { itemId: "dinner-1", category: "dining", query: { area: "Nashville", dateTime: "2026-08-01T19:00:00Z", partySize: 8 } },
];

describe("resolveDining", () => {
  it("produces a manifest with a chosen slot per intent", async () => {
    const manifest = await resolveDining({
      tripId: "trip-1",
      tenant: "moh",
      intents,
      rail: new MockRail(),
      proposals: new DeterministicProposalSource(),
    });
    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0]!.chosen).not.toBeNull();
    expect(manifest.items[0]!.rail).toBe("mock");
  });

  it("guardrail rejects a chosen slot over the max price", () => {
    const err = validateChoice(
      { itemId: "x", category: "dining", query: { area: "A", dateTime: "2026-08-01T19:00:00Z", partySize: 2, maxPriceCents: 100 } },
      { railSlotId: "s", label: "s", priceCents: 500, startsAt: "2026-08-01T19:00:00Z", cancellation: { refundable: true, freeCancelUntil: null, refundAmountCents: 0 } }
    );
    expect(err).toMatch(/exceeds/i);
  });

  it("leaves chosen null when no candidate passes the guardrail", async () => {
    const manifest = await resolveDining({
      tripId: "trip-2",
      tenant: "moh",
      intents: [{ itemId: "d", category: "dining", query: { area: "Z", dateTime: "2026-08-01T19:00:00Z", partySize: 2, maxPriceCents: -1 } }],
      rail: new MockRail(),
      proposals: new DeterministicProposalSource(),
    });
    expect(manifest.items[0]!.chosen).toBeNull();
  });

  it("rejects a fabricated slot the rail never returned (provenance guard)", async () => {
    const hallucinating: ProposalSource = {
      async rank() {
        return [
          { railSlotId: "FAKE-999", label: "hallucinated", priceCents: 0, startsAt: "2026-08-01T19:00:00Z", cancellation: { refundable: true, freeCancelUntil: null, refundAmountCents: 0 } },
        ];
      },
    };
    const manifest = await resolveDining({
      tripId: "trip-3",
      tenant: "moh",
      intents,
      rail: new MockRail(),
      proposals: hallucinating,
    });
    expect(manifest.items[0]!.chosen).toBeNull();
  });

  it("throws when a non-dining intent reaches resolveDining", async () => {
    await expect(
      resolveDining({
        tripId: "trip-4",
        tenant: "moh",
        intents: [{ itemId: "g", category: "golf", query: { area: "A", dateTime: "2026-08-01T12:00:00Z", partySize: 4 } }],
        rail: new MockRail(),
        proposals: new DeterministicProposalSource(),
      }),
    ).rejects.toThrow(/non-dining/);
  });
});
