import { describe, it, expect } from "vitest";
import { GetYourGuideAdapter } from "../concierge/getyourguide-adapter";
import { OpenTableAdapter } from "../concierge/opentable-adapter";
import { LiteAPIAdapter } from "../concierge/liteapi-adapter";

// Regressions for the adapter findings of the 2026-07-23 adversarial review. Each test is a
// partner-response shape that previously produced a money-safety failure with every guardrail green.

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("GetYourGuide — the `?? 0` findings", () => {
  it("EXCLUDES a tour with no usable price instead of pricing it at 0", async () => {
    // GYG's documented shape is `price: {value, currency}` and it quotes EUR by default. The old
    // `price_cents ?? 0` turned this into a free tour that passed caps, drift, and the paid-item
    // policy check simultaneously — and the guest was still charged EUR 189 by GYG.
    const rail = new GetYourGuideAdapter({
      baseUrl: "https://gyg.local", token: "t",
      fetchImpl: async () => json({ tours: [{ id: "tour-77", title: "Colosseum", price: { value: "189.00", currency: "EUR" }, start_time: "2026-08-01T10:00:00Z" }] }),
    });
    expect(await rail.search({ area: "Rome", dateTime: "2026-08-01T10:00:00Z", partySize: 6 })).toHaveLength(0);
  });

  it("accepts a USD money object and converts it to integer cents", async () => {
    const rail = new GetYourGuideAdapter({
      baseUrl: "https://gyg.local", token: "t",
      fetchImpl: async () => json({ tours: [{ id: "t1", title: "Kayak", price: { value: "85.00", currency: "USD" }, start_time: "2026-08-01T10:00:00Z" }] }),
    });
    const slots = await rail.search({ area: "Austin", dateTime: "2026-08-01T10:00:00Z", partySize: 6 });
    expect(slots[0]?.priceCents).toBe(8500);
  });

  it("THROWS on an un-priced reservation — nothing is committed yet, so throwing is safe", async () => {
    const rail = new GetYourGuideAdapter({
      baseUrl: "https://gyg.local", token: "t",
      fetchImpl: async () => json({ reservation_id: "r1", expires_at: "2026-08-01T09:00:00Z" }),
    });
    await expect(rail.hold("t1", { partySize: 6, dateTime: "2026-08-01T10:00:00Z" })).rejects.toThrow(/no usable \(USD, >0\) price/);
  });
});

describe("null/blank external refs — a booking we cannot address later", () => {
  it("GYG book() throws when the partner renames booking_id", async () => {
    const rail = new GetYourGuideAdapter({
      baseUrl: "https://gyg.local", token: "t",
      fetchImpl: async () => json({ bookingId: "camel-1", voucherCode: "V" }), // renamed on a minor version bump
    });
    await expect(rail.book("res-1", { leadName: "A", leadEmail: "a@b.c" })).rejects.toThrow(/missing booking id/);
  });

  it("OpenTable book() throws when the partner renames reservation_id", async () => {
    const rail = new OpenTableAdapter({
      baseUrl: "https://ot.local", token: "t",
      fetchImpl: async () => json({ reservationId: "camel-2" }),
    });
    await expect(rail.book("lock-1", { leadName: "A", leadEmail: "a@b.c" })).rejects.toThrow(/missing reservation id/);
  });

  it("a whitespace-only ref is rejected too (`.length` alone would pass it)", async () => {
    const rail = new LiteAPIAdapter({
      baseUrl: "https://lite.local", apiKey: "k",
      fetchImpl: async () => json({ bookingId: "   ", price: { amount: 450, currency: "USD" } }),
    });
    await expect(rail.book("pre-1", { leadName: "A", leadEmail: "a@b.c" })).rejects.toThrow(/missing booking id/);
  });
});

describe("Idempotency-Key on every book()", () => {
  it.each([
    ["OpenTable", (f: typeof fetch) => new OpenTableAdapter({ baseUrl: "https://ot.local", token: "t", fetchImpl: f }), { reservation_id: "r1", confirmation: "OK" }],
    ["GetYourGuide", (f: typeof fetch) => new GetYourGuideAdapter({ baseUrl: "https://gyg.local", token: "t", fetchImpl: f }), { booking_id: "b1", voucher_code: "V", amount_cents: 8500 }],
    ["LiteAPI", (f: typeof fetch) => new LiteAPIAdapter({ baseUrl: "https://lite.local", apiKey: "k", fetchImpl: f }), { bookingId: "b1", confirmation: "C", price: { amount: 450, currency: "USD" } }],
  ])("%s derives the key from the hold, so a replayed book is deduped by the partner", async (_name, make, body) => {
    let headers: Record<string, string> = {};
    const rail = make((async (_u, init) => { headers = (init as RequestInit).headers as Record<string, string>; return json(body); }) as typeof fetch);
    await rail.book("hold-abc", { leadName: "A", leadEmail: "a@b.c" });
    expect(headers["idempotency-key"]).toBe("hold-abc");
  });
});

describe("partner ids are URL-encoded before being interpolated", () => {
  it("does not let a composite/traversal id re-target a credentialed request", async () => {
    // The bearer token rides on every request; an id containing `/` or `..` would send it to a
    // different endpoint entirely.
    let url = "";
    const rail = new OpenTableAdapter({
      baseUrl: "https://ot.local", token: "t",
      fetchImpl: async (u) => { url = String(u); return json({ status: "confirmed" }); },
    });
    await rail.status("../../admin/keys");
    expect(url).not.toContain("../");
    expect(url).toContain("%2F");
  });
});
