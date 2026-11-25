import { describe, it, expect } from "vitest";
import { InMemoryAuditLog, type AuditEntry } from "../concierge/audit";

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  ts: "2026-07-20T12:00:00.000Z",
  tripId: "trip-1",
  itemId: "item-1",
  actor: "orchestrator",
  action: "book",
  rail: "mock",
  externalRef: "ref-1",
  amountCents: 5000,
  ...over,
});

describe("InMemoryAuditLog", () => {
  it("appends and returns entries for a trip in order", async () => {
    const log = new InMemoryAuditLog();
    await log.append(entry({ action: "hold", externalRef: "hold-1", amountCents: 0 }));
    await log.append(entry({ action: "book" }));
    const rows = await log.entries("trip-1");
    expect(rows.map((r) => r.action)).toEqual(["hold", "book"]);
  });

  it("scopes entries by tripId — no cross-trip leakage", async () => {
    const log = new InMemoryAuditLog();
    await log.append(entry({ tripId: "trip-1" }));
    await log.append(entry({ tripId: "trip-2" }));
    expect(await log.entries("trip-1")).toHaveLength(1);
    expect(await log.entries("trip-2")).toHaveLength(1);
  });
});
