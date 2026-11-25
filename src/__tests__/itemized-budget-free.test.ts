import { describe, it, expect } from "vitest";
import { computeItemizedBudget } from "../room/itemized-budget";

// Audit 2026-07-24 HIGH: an activity/dining/bar the model explicitly priced at
// $0 was silently re-billed at the tier default (card showed $0 while $60–115
// landed in the headline). An explicit $0 must be honored as free.
describe("itemized budget — explicit $0 is honored as free", () => {
  it("keeps a $0 activity at $0 (source 'free'), not the tier default", () => {
    const b = computeItemizedBudget(
      { activities: [{ name: "Record Store Browse", costPerPerson: "$0", estimatedCostPerPerson: 0 }] } as never,
      "theLegend", 10, 3,
    );
    const act = b.items.find((i) => i.name === "Record Store Browse")!;
    expect(act.estimatedCostPerPerson).toBe(0);
    expect(act.source).toBe("free");
  });

  it("a $0 string with no structured price is still free", () => {
    const b = computeItemizedBudget(
      { activities: [{ name: "Free Viewpoint", costPerPerson: "$0" }] } as never,
      "theLegend", 10, 3,
    );
    expect(b.items.find((i) => i.name === "Free Viewpoint")!.estimatedCostPerPerson).toBe(0);
  });

  it("a MISSING price still falls back to a tier default (not free)", () => {
    const b = computeItemizedBudget(
      { activities: [{ name: "Mystery Activity" }] } as never,
      "theLegend", 10, 3,
    );
    const act = b.items.find((i) => i.name === "Mystery Activity")!;
    expect(act.source).toBe("tier-default");
    expect(act.estimatedCostPerPerson).toBeGreaterThan(0);
  });
});
