import { describe, it, expect } from "vitest";
import { buildQASystemPrompt, answerTripQuestion } from "../chat/trip-qa";
import type { QAConfig } from "../chat/types";

interface Plan { tripName: string; destination: string }
const CONFIG: QAConfig<unknown, Plan> = {
  pickViewedPlan: () => null,
  serializePlan: (p, timing) => JSON.stringify({ ...p, timing }),
  tripNoun: "golf trip",
  extraGuardrails: ["6. Days are Day 1/Day 2, never weekdays — don't guess which weekday a day maps to."],
};

describe("chat/trip-qa", () => {
  it("keeps the invariant bans and weaves brand noun + extra guardrails", () => {
    const p = buildQASystemPrompt(CONFIG);
    expect(p).toContain("golf trip");
    expect(p).toContain("NEVER describe weather"); // invariant ban retained
    expect(p).toContain("EXACT figure"); // invariant price ban retained
    expect(p).toContain("Days are Day 1/Day 2"); // brand extra guardrail appended
  });

  it("passes timing to serializePlan and returns the model answer trimmed", async () => {
    let sawTiming = "";
    const cfg: QAConfig<unknown, Plan> = { ...CONFIG, serializePlan: (p, t) => { sawTiming = t ?? ""; return JSON.stringify(p); } };
    const r = await answerTripQuestion<unknown, Plan>(
      { tripName: "T", destination: "Bandon, OR" },
      "where are we?",
      { generate: async () => "  Bandon, Oregon.  ", config: cfg, timing: "May · Spring" },
    );
    expect(sawTiming).toBe("May · Spring");
    expect(r.answer).toBe("Bandon, Oregon.");
  });

  it("falls back to a safe message on empty model output", async () => {
    const r = await answerTripQuestion<unknown, Plan>(
      { tripName: "T", destination: "X" },
      "?",
      { generate: async () => "", config: CONFIG },
    );
    expect(r.answer).toContain("couldn't find that in this plan");
  });
});
