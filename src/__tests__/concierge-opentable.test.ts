import { describe, it, expect, vi } from "vitest";
import { OpenTableAdapter } from "../concierge/opentable-adapter";
import { runBookingRailContract } from "../concierge/rail-contract";

function fakeFetch(): typeof fetch {
  return vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("/search")) {
      return json({ slots: [{ id: "rest-1", name: "Testville Grill", time: "2026-08-01T19:00:00Z" }] });
    }
    if (u.includes("/slot_locks")) return json({ lock_id: "lock-1", expires_at: "2026-08-01T19:15:00Z" });
    if (u.includes("/reservations") && init?.method === "POST") return json({ reservation_id: "res-1", confirmation: "OT-123" });
    if (u.includes("/reservations/") && init?.method === "DELETE") return json({ status: "cancelled" });
    if (u.includes("/reservations/")) return json({ status: "confirmed" });
    return json({});
  }) as unknown as typeof fetch;
}

const make = () => new OpenTableAdapter({ baseUrl: "https://sandbox.opentable.test", token: "t", fetchImpl: fakeFetch() });

describe("OpenTableAdapter (mocked)", () => {
  it("maps search response to RailSlot[]", async () => {
    const slots = await make().search({ area: "Testville", dateTime: "2026-08-01T19:00:00Z", partySize: 4 });
    expect(slots[0]!.railSlotId).toBe("rest-1");
    expect(slots[0]!.priceCents).toBe(0);
  });
});

runBookingRailContract("OpenTableAdapter(mock fetch)", make);
