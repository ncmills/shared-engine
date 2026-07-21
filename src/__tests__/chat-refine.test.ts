import { describe, it, expect } from "vitest";
import { proposeWizardPatch, buildRefineSystemPrompt } from "../chat/refine";
import type { RefineConfig } from "../chat/types";

// Minimal brand state for the generic core.
interface TestState { destination: string; numberOfDays: number; organizerEmail: string }

const validate = (raw: unknown): TestState => {
  const o = raw as Record<string, unknown>;
  const dest = typeof o.destination === "string" ? o.destination : "";
  if (!dest) throw new Error("destination required");
  const days = Math.max(2, Math.min(7, Number(o.numberOfDays) || 3));
  return { destination: dest, numberOfDays: days, organizerEmail: String(o.organizerEmail ?? "") };
};

const CONFIG: RefineConfig<TestState> = {
  editableFields: ["destination", "numberOfDays"],
  validate,
  fieldGuide: "destination: a US city string\nnumberOfDays: integer 2-7",
  plannerNoun: "test-trip planner",
  cascadeExampleFields: "`numberOfDays`",
  destinationRule: "APPLY any US place the user names.",
  directionalRule: "\"longer\" → more days.",
  alreadySetRule: "If already set, return patch: {} + unmet.",
  typeTagsRule: "7. `activities` are short TYPE tags — never write specific venue names.",
  humanLabels: { numberOfDays: "trip length" },
  noopFallbackNote: "I can change destination or trip length.",
};

const gen = (out: string) => async () => out;

describe("chat/refine", () => {
  it("system prompt weaves brand slots into the invariant skeleton", () => {
    const p = buildRefineSystemPrompt(CONFIG);
    expect(p).toContain("test-trip planner");
    expect(p).toContain("destination: a US city string");
    expect(p).toContain('{ "patch":'); // invariant JSON contract retained
    expect(p).toContain("short TYPE tags");
  });

  it("whitelists to editable fields and drops PII/unknown keys", async () => {
    const r = await proposeWizardPatch<TestState>(
      { destination: "Austin, TX", numberOfDays: 3, organizerEmail: "a@b.co" },
      "make it 4 days",
      { generate: gen('{"patch":{"numberOfDays":4,"organizerEmail":"evil@x.co","bogus":1},"unmet":null}'), config: CONFIG },
    );
    expect(r.next.numberOfDays).toBe(4);
    expect(r.next.organizerEmail).toBe("a@b.co"); // PII not editable → untouched
    expect(r.patch).not.toHaveProperty("organizerEmail");
    expect(r.patch).not.toHaveProperty("bogus");
    expect(r.changed).toEqual(["numberOfDays"]);
    expect(r.note).toBe("Updated trip length.");
  });

  it("returns original unchanged + unmet when merge fails validation", async () => {
    const r = await proposeWizardPatch<TestState>(
      { destination: "Austin, TX", numberOfDays: 3, organizerEmail: "" },
      "clear the destination",
      { generate: gen('{"patch":{"destination":""},"unmet":null}'), config: CONFIG },
    );
    expect(r.next.destination).toBe("Austin, TX");
    expect(r.changed).toEqual([]);
    expect(r.unmet?.what).toContain("apply that change");
  });

  it("passes model unmet through and shows the no-op fallback when nothing maps", async () => {
    const r = await proposeWizardPatch<TestState>(
      { destination: "Austin, TX", numberOfDays: 3, organizerEmail: "" },
      "make it fancier",
      { generate: gen('{"patch":{},"unmet":null}'), config: CONFIG },
    );
    expect(r.changed).toEqual([]);
    expect(r.note).toBe("I can change destination or trip length.");
  });

  it("tolerates a ```json code fence", async () => {
    const r = await proposeWizardPatch<TestState>(
      { destination: "Austin, TX", numberOfDays: 3, organizerEmail: "" },
      "5 days",
      { generate: gen('```json\n{"patch":{"numberOfDays":5},"unmet":null}\n```'), config: CONFIG },
    );
    expect(r.next.numberOfDays).toBe(5);
  });
});
