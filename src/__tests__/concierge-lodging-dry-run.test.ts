import { describe, it, expect } from "vitest";
import { runConciergeLodgingDryRun } from "../concierge/dry-run";
import { LODGING_HOST } from "../concierge/lodging-deeplink";
import type { BookingIntent } from "../concierge/types";

const intents: BookingIntent[] = [
  { itemId: "stay-1", category: "lodging", query: { area: "Nashville", dateTime: "2026-08-01T15:00:00Z", partySize: 6, maxPriceCents: 100000 } },
  { itemId: "stay-2", category: "lodging", query: { area: "Austin", dateTime: "2026-08-03T15:00:00Z", partySize: 6, maxPriceCents: 100000 } },
];

describe("runConciergeLodgingDryRun", () => {
  it("runs the staged engine over the LiteAPI adapter (built-in sandbox) → CONFIRMED with a deeplink per booking", async () => {
    const { manifest, staged, deeplinks } = await runConciergeLodgingDryRun({
      tripId: "trip-lodge-1",
      tenant: "moh",
      intents,
      now: "2026-07-20T12:00:00.000Z",
    });
    expect(manifest.items).toHaveLength(2);
    expect(manifest.items.every((i) => i.rail === "liteapi")).toBe(true);
    expect(staged.state).toBe("CONFIRMED");
    expect(staged.committedOrder).toHaveLength(2);
    // one guest-facing deeplink per confirmed booking, pointing at the tenant host
    expect(deeplinks).toHaveLength(2);
    expect(deeplinks.every((d) => d.url.startsWith(`https://${LODGING_HOST.moh}/stay/`))).toBe(true);
    expect(new Set(deeplinks.map((d) => d.itemId))).toEqual(new Set(["stay-1", "stay-2"]));
  });

  it("emits hold+book audit for every lodging item (zero external calls)", async () => {
    const { audit } = await runConciergeLodgingDryRun({
      tripId: "trip-lodge-2",
      tenant: "bestman",
      intents,
      now: "2026-07-20T12:00:00.000Z",
    });
    const actions = audit.map((e) => e.action);
    expect(actions.filter((a) => a === "hold")).toHaveLength(2);
    expect(actions.filter((a) => a === "book")).toHaveLength(2);
  });
});
