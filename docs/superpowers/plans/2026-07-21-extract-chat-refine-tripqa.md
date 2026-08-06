# Extract refine() + trip-qa() into shared-engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the triplicated `refine-plan.ts` / `trip-qa.ts` logic into a single generic, config-injected `shared-engine/src/chat` module so MOH, BMHQ, and HHQ consume one hardened copy and can never drift again.

**Architecture:** A new `src/chat/` module in `shared-engine` holds the brand-invariant algorithm (whitelist → validate → diff → unmet; QA grounding) and the hardened guardrail skeleton, generic over each brand's `WizardState`/`GeneratedPlan`/`StoredPlan`. Brand-specific pieces — editable-field list, field guide, destination/directional/already-set rule bodies, `validate`, `serializePlan`, `pickViewedPlan`, human labels, copy nouns — are passed in a per-brand config object. The LLM transport stays injected at the route (unchanged). Each consumer keeps a thin `src/lib/refine-plan.ts` / `src/lib/trip-qa.ts` that builds its config and re-exports the shared functions bound to it, so **API route imports do not change**.

**Tech Stack:** TypeScript (strict, ESM), vitest, Next.js (consumers transpile shared-engine as raw TS), `shared-engine` consumed via `github:ncmills/shared-engine`.

## Global Constraints

- shared-engine has **no build step**: `main`/`types` → `src/index.ts`, consumed as raw TS. Never add emit; keep everything importable from the barrel.
- shared-engine is **generic over brand types** — the chat module must NOT import any concrete `WizardState`/`GeneratedPlan`/`StoredPlan` (those differ per brand). Use type parameters.
- **Namespace is `src/chat/`, NOT `src/concierge/`.** `src/concierge/` is the in-flight reservation-rails engine (separate effort) — do not touch or collide with it.
- Work on shared-engine branch **off `main`**, not the current `concierge-engine-spec` branch. Use a worktree (`superpowers:using-git-worktrees`) so the concierge branch checkout is undisturbed.
- The injected `generate` transport and each brand's `validate` stay **injected/parameterized** — never centralize them (MOH/BMHQ use Vercel `ai`, HHQ uses raw `@anthropic-ai/sdk`; validators are brand-specific and named differently).
- Behavior must be **byte-identical** to today's per-repo output for each brand, EXCEPT the one intentional fix: HHQ's no-op fallback note becomes golf-correct (today `handicap-hq/src/lib/refine-plan.ts:269-272` wrongly lists MOH fields "vibe, intensity… honoring moment").
- Consumers resolve shared-engine from `main`. Land + merge the shared module to `main` BEFORE rewiring any consumer.
- Model/rate-limit/route behavior stays exactly as-is (`claude-haiku-4-5-20251001`, refine 20/min + maxTokens 800/temp 0, ask 30/min + 500/temp 0.2, `maxDuration=60`).

---

## File Structure

**shared-engine (new):**
- `src/chat/types.ts` — `RefineGenerate`, `QAGenerate`, `Unmet`, `RefineResult<TState>`, `QAResult`, `RefineConfig<TState>`, `QAConfig<TStored, TPlan>`.
- `src/chat/refine.ts` — `buildRefineSystemPrompt(cfg)`, `proposeWizardPatch<TState>(current, tweak, { generate, config })`, private helpers (`parseModelJson`, `clip`, `coerceUnmet`, `buildRefineUserPrompt`).
- `src/chat/trip-qa.ts` — `buildQASystemPrompt(cfg)`, `answerTripQuestion<TPlan>(plan, question, { generate, config, timing? })`.
- `src/chat/index.ts` — barrel for the three above.
- `src/__tests__/chat-refine.test.ts`, `src/__tests__/chat-trip-qa.test.ts`.
- `src/index.ts` — add `export * from './chat';`.

**Each consumer (`maid-of-honor-hq`, `plan-my-party`, `handicap-hq`):**
- `src/lib/refine-plan.ts` — SHRINKS to: brand `RefineConfig` + thin `proposeWizardPatch` wrapper + type re-exports. Route import path unchanged.
- `src/lib/trip-qa.ts` — SHRINKS to: brand `QAConfig` + thin `answerTripQuestion` wrapper + `pickViewedPlan`/`serializePlanForQA` (stay here, referenced by config).
- `package.json` / `package-lock.json` — MOH/BMHQ bump the shared-engine pin; **HHQ adds the dep**.
- Routes (`src/app/api/refine/route.ts`, `src/app/api/ask/route.ts`), `validate.ts`, and UI components are **untouched**.

---

## Task 1: shared-engine chat types + generic refine core

**Files:**
- Create: `~/shared-engine/src/chat/types.ts`
- Create: `~/shared-engine/src/chat/refine.ts`
- Test: `~/shared-engine/src/__tests__/chat-refine.test.ts`

**Interfaces:**
- Produces:
  - `type RefineGenerate = (args: { system: string; prompt: string }) => Promise<string>`
  - `interface Unmet { what: string; why: string; fix: string }`
  - `interface RefineResult<TState> { next: TState; changed: string[]; note: string; unmet: Unmet | null; patch: Partial<TState> }`
  - `interface RefineConfig<TState>` (see Step 1 code)
  - `function buildRefineSystemPrompt<TState>(config: RefineConfig<TState>): string`
  - `async function proposeWizardPatch<TState>(current: TState, tweak: string, opts: { generate: RefineGenerate; config: RefineConfig<TState> }): Promise<RefineResult<TState>>`

- [ ] **Step 1: Write `src/chat/types.ts`**

```ts
/** LLM transport: takes a system + user prompt, returns raw model text (expected JSON). */
export type RefineGenerate = (args: { system: string; prompt: string }) => Promise<string>;
export type QAGenerate = (args: { system: string; prompt: string }) => Promise<string>;

/** What the box couldn't honor — surfaced verbatim to the user (what / why / how to fix). */
export interface Unmet {
  what: string;
  why: string;
  fix: string;
}

export interface RefineResult<TState> {
  /** The validated, patched wizard input — resubmit this to `/api/generate-plan`. */
  next: TState;
  /** Editable fields whose value actually changed (post-validation). Empty = nothing to rebuild. */
  changed: string[];
  /** Short human summary of what changed (or why nothing did). Safe to show the user. */
  note: string;
  /** Present when part (or all) of the request could NOT be honored. Else null. */
  unmet: Unmet | null;
  /** The raw whitelisted patch that was applied (for logging/telemetry). */
  patch: Partial<TState>;
}

/**
 * Per-brand refine configuration. The brand-INVARIANT guardrail skeleton lives in
 * `buildRefineSystemPrompt`; these fields are the brand-specific slots woven into it.
 */
export interface RefineConfig<TState> {
  /** Trip-shaping fields the box may edit. Auth/PII/identity fields are deliberately excluded. */
  editableFields: readonly (keyof TState)[];
  /** Re-sanitizes/validates the merged state; throws if a required field is missing/invalid. */
  validate: (raw: unknown) => TState;
  /** Compact field guide — the only fields+values the model may emit. Brand-specific enums. */
  fieldGuide: string;
  /** e.g. "bachelorette-trip planner" | "golf-trip planner". */
  plannerNoun: string;
  /** Example unrelated fields for the no-cascade rule, e.g. "`vibeTags`/`brideType`/`activityIntensity`". */
  cascadeExampleFields: string;
  /** Full body of Rule 4 (destination scope + named-venue handling) — brand-specific. */
  destinationRule: string;
  /** Full body of Rule 5 (directional words → axis) — brand-specific examples. */
  directionalRule: string;
  /** Full body of Rule 6 (already-set honesty) — brand-specific examples. */
  alreadySetRule: string;
  /** Full body of Rule 7 (type-tags-not-venues) — brand-specific vocab/examples (MOH says "spa"/"wine tasting", HHQ says "venue/course names"). */
  typeTagsRule: string;
  /** Field → human label for the change note. */
  humanLabels: Partial<Record<keyof TState & string, string>>;
  /** Shown when a request is in-scope but maps to nothing (lists what this box CAN change). */
  noopFallbackNote: string;
}

/** Per-brand Q&A configuration. QA bans are invariant; these are the brand slots. */
export interface QAConfig<TStored, TPlan> {
  /** Pick the plan the user is viewing (brand tier names differ). */
  pickViewedPlan: (stored: TStored, dest?: string, tier?: string) => TPlan | null;
  /** Compact answerable slice of the plan — the ONLY facts the model may use. */
  serializePlan: (plan: TPlan, timing?: string) => string;
  /** e.g. "bachelorette trip" | "golf trip". */
  tripNoun: string;
  /** Extra brand guardrails appended after the invariant bans (e.g. HHQ day-labeling ban). */
  extraGuardrails?: string[];
}

export interface QAResult {
  answer: string;
}
```

- [ ] **Step 2: Write the failing test `src/__tests__/chat-refine.test.ts`**

```ts
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
    expect(p).toContain("short TYPE tags"); // brand typeTagsRule (Rule 7) slot woven in
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd ~/shared-engine && npx vitest run src/__tests__/chat-refine.test.ts`
Expected: FAIL — cannot find module `../chat/refine`.

- [ ] **Step 4: Write `src/chat/refine.ts`**

Port the algorithm from `~/maid-of-honor-hq/src/lib/refine-plan.ts` (the reference), made generic and config-driven. Copy `parseModelJson` (lines 158-173), `clip` (175-181), `coerceUnmet` (182-190) **verbatim** as private helpers.

```ts
import type { RefineGenerate, RefineResult, Unmet, RefineConfig } from "./types";

export type { RefineGenerate, RefineResult, Unmet, RefineConfig };

/**
 * Brand-INVARIANT refine system prompt. The hardened guardrails (JSON contract, no-cascade,
 * unmet-not-force-fit, no-ambiguous-with-patch, type-tags-not-venues) live here and are shared
 * by every brand. Brand-specific rule bodies (destination scope, directional words, already-set
 * examples, field guide, planner noun) come from `config`.
 */
export function buildRefineSystemPrompt<TState>(config: RefineConfig<TState>): string {
  return [
    `You adjust the STRUCTURED INPUT of a ${config.plannerNoun} from a user's plain-English change`,
    "request. A separate deterministic engine regenerates the whole plan (itinerary, real venues, prices)",
    "from the input you return. You never write the plan, venues, prices, or prose yourself.",
    "",
    "Return ONLY this JSON (no prose, no code fence):",
    '{ "patch": { <fields to change> }, "unmet": { "what": "...", "why": "...", "fix": "..." } | null }',
    "",
    "ACCURACY IS MANDATORY. Follow these rules exactly:",
    "1. In `patch`, change a field ONLY IF the request maps to it CLEARLY and UNAMBIGUOUSLY and the new",
    "   value is one of the exact options in the FIELD GUIDE. Change the FEWEST fields necessary — only",
    "   the field(s) the user actually named. Never guess, never cascade edits the user didn't ask for.",
    `   e.g. changing the DESTINATION never means changing ${config.cascadeExampleFields} —`,
    "   leave every unnamed field exactly as-is. Return `patch: {}` if nothing clearly and specifically applies.",
    "2. If ANY part of the request cannot be honored, DO NOT force it into a field and DO NOT drop it",
    "   silently. Put it in `unmet` with: `what` (the part you couldn't do), `why` (plain reason), `fix`",
    "   (a concrete next step the user can take). Set `unmet` to null only when the ENTIRE request was",
    "   fully and accurately applied in `patch`.",
    "3. NEVER return both a real change in `patch` AND an `unmet` that says the request was too vague to",
    "   act on. If you're unsure enough to call it ambiguous, the patch for that part must be empty.",
    config.destinationRule,
    config.directionalRule,
    config.alreadySetRule,
    config.typeTagsRule,
    "",
    "FIELD GUIDE (the only fields and values you may use in `patch`):",
    config.fieldGuide,
  ].join("\n");
}

function buildRefineUserPrompt<TState>(current: TState, tweak: string, editableFields: readonly (keyof TState)[]): string {
  const editable: Record<string, unknown> = {};
  for (const k of editableFields) editable[k as string] = (current as Record<string, unknown>)[k as string];
  return [
    "CURRENT INPUT (editable fields only):",
    JSON.stringify(editable),
    "",
    "CHANGE REQUEST:",
    tweak.trim(),
    "",
    "Return the JSON now.",
  ].join("\n");
}

// --- parseModelJson / clip / coerceUnmet: copy verbatim from maid-of-honor-hq/src/lib/refine-plan.ts:158-190 ---
function parseModelJson(raw: string): Record<string, unknown> {
  if (!raw) return {};
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return {};
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function clip(s: string, max = 240): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, "") + "…";
}

function coerceUnmet(v: unknown): Unmet | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");
  const what = str(o.what), why = str(o.why), fix = str(o.fix);
  if (!what && !why && !fix) return null;
  return { what: clip(what), why: clip(why), fix: clip(fix) };
}

/**
 * Turn a natural-language tweak into a validated, patched state PLUS an honest account of anything
 * it couldn't do. Generic over the brand's state type; `config.validate` re-sanitizes the merge.
 */
export async function proposeWizardPatch<TState>(
  current: TState,
  tweak: string,
  opts: { generate: RefineGenerate; config: RefineConfig<TState> },
): Promise<RefineResult<TState>> {
  const { config } = opts;
  const editableSet = new Set<string>(config.editableFields.map((k) => k as string));

  const raw = await opts.generate({
    system: buildRefineSystemPrompt(config),
    prompt: buildRefineUserPrompt(current, tweak, config.editableFields),
  });

  const parsed = parseModelJson(raw);
  const patchSource =
    parsed.patch && typeof parsed.patch === "object" && !Array.isArray(parsed.patch)
      ? (parsed.patch as Record<string, unknown>)
      : ("patch" in parsed ? {} : parsed);
  const unmet = coerceUnmet(parsed.unmet);

  // 1. Whitelist: keep only editable fields the model returned.
  const patch: Partial<TState> = {};
  for (const [k, v] of Object.entries(patchSource)) {
    if (editableSet.has(k) && v !== undefined) (patch as Record<string, unknown>)[k] = v;
  }

  // 2. Merge + validate. An invalid required state is a no-op reported as unmet.
  let next: TState;
  try {
    next = config.validate({ ...current, ...patch });
  } catch {
    return {
      next: current,
      changed: [],
      note: "I couldn't make that change.",
      unmet: {
        what: "apply that change",
        why: "it would leave the trip without a required detail (like a destination).",
        fix: "re-state it with the specifics — e.g. name the city or region you want.",
      },
      patch: {},
    };
  }

  // 3. Diff on editable fields only (validation may have coerced values back).
  const changed = config.editableFields.filter(
    (k) => JSON.stringify((next as Record<string, unknown>)[k as string]) !== JSON.stringify((current as Record<string, unknown>)[k as string]),
  ) as (keyof TState)[];

  let note: string;
  if (changed.length) {
    note = `Updated ${changed.map((k) => config.humanLabels[k as keyof TState & string] ?? String(k)).join(", ")}.`;
  } else if (unmet) {
    note = "I couldn't make that change here.";
  } else {
    note = config.noopFallbackNote;
  }

  return { next, changed: changed.map((k) => String(k)), note, unmet, patch };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd ~/shared-engine && npx vitest run src/__tests__/chat-refine.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck**

Run: `cd ~/shared-engine && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd ~/shared-engine
git add src/chat/types.ts src/chat/refine.ts src/__tests__/chat-refine.test.ts
git commit -m "feat(chat): generic config-injected refine core"
```

---

## Task 2: shared-engine generic trip-qa core

**Files:**
- Create: `~/shared-engine/src/chat/trip-qa.ts`
- Test: `~/shared-engine/src/__tests__/chat-trip-qa.test.ts`

**Interfaces:**
- Consumes: `QAGenerate`, `QAResult`, `QAConfig` from `./types` (Task 1).
- Produces:
  - `function buildQASystemPrompt<TStored, TPlan>(config: QAConfig<TStored, TPlan>): string`
  - `async function answerTripQuestion<TStored, TPlan>(plan: TPlan, question: string, opts: { generate: QAGenerate; config: QAConfig<TStored, TPlan>; timing?: string }): Promise<QAResult>`

- [ ] **Step 1: Write the failing test `src/__tests__/chat-trip-qa.test.ts`**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/shared-engine && npx vitest run src/__tests__/chat-trip-qa.test.ts`
Expected: FAIL — cannot find module `../chat/trip-qa`.

- [ ] **Step 3: Write `src/chat/trip-qa.ts`**

Port from `~/maid-of-honor-hq/src/lib/trip-qa.ts:58-96`, made generic. `pickViewedPlan`/`serializePlanForQA` do NOT move here — they stay in each consumer (brand-specific) and are supplied via `config`.

```ts
import type { QAGenerate, QAResult, QAConfig } from "./types";

export type { QAGenerate, QAResult, QAConfig };

/**
 * Brand-INVARIANT Q&A system prompt. The hardened bans (answer-only-from-data, no weather/forecast,
 * exact-price-no-estimates, no-mutation, plain-text) are shared. Brand slots: the trip noun and any
 * `extraGuardrails` (e.g. HHQ's Day-1/Day-2 labeling ban).
 */
export function buildQASystemPrompt<TStored, TPlan>(config: QAConfig<TStored, TPlan>): string {
  return [
    `You answer a guest's question about ONE specific, already-planned ${config.tripNoun}. You are a`,
    "helpful concierge for THIS trip only.",
    "",
    "Rules — follow exactly:",
    "1. Answer ONLY using the TRIP DATA provided. Every fact (venue, price, time, address, activity) must",
    "   come from that data verbatim. NEVER invent, guess, or add venues, prices, or details not present.",
    "2. If the answer isn't in the TRIP DATA, say so plainly (e.g. \"That's not spelled out in this plan\")",
    "   and, if useful, say where they'd find it or that the organizer can adjust the trip. Do NOT support",
    "   that by citing a pro tip, venue, or plan detail that isn't actually in the TRIP DATA — invent nothing.",
    "   NEVER describe weather, temperatures, or a forecast — that is never in the plan; say you don't have it.",
    "3. Do NOT change the trip. If asked to modify it (different city, drop a night, swap a venue), say you",
    "   can only answer questions — the organizer can use the “Tell us what to change” box (or Swap on a",
    "   stop) to edit it.",
    "4. PRICES/money: quote the EXACT figure from the TRIP DATA verbatim — never round, average, alter,",
    "   or invent a price. Use the per-item price when it's in the data (e.g. a dinner's cost); if a",
    "   specific price isn't there, say so — do not guess. Do NOT volunteer ballpark estimates or generic",
    "   advice not in the data (typical ride costs, what a guide might suggest). Be concise, warm, specific.",
    "5. Plain text only, no markdown headers. A few sentences at most.",
    ...(config.extraGuardrails ?? []),
  ].join("\n");
}

export async function answerTripQuestion<TStored, TPlan>(
  plan: TPlan,
  question: string,
  opts: { generate: QAGenerate; config: QAConfig<TStored, TPlan>; timing?: string },
): Promise<QAResult> {
  const raw = await opts.generate({
    system: buildQASystemPrompt(opts.config),
    prompt: ["TRIP DATA:", opts.config.serializePlan(plan, opts.timing), "", "QUESTION:", question.trim(), "", "Answer from the TRIP DATA only:"].join("\n"),
  });
  const answer = (raw ?? "").trim();
  return { answer: answer || "Sorry — I couldn't find that in this plan. Try rephrasing, or the organizer can adjust the trip." };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/shared-engine && npx vitest run src/__tests__/chat-trip-qa.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/shared-engine
git add src/chat/trip-qa.ts src/__tests__/chat-trip-qa.test.ts
git commit -m "feat(chat): generic config-injected trip-qa core"
```

---

## Task 3: Barrel-export chat module, land on main

**Files:**
- Create: `~/shared-engine/src/chat/index.ts`
- Modify: `~/shared-engine/src/index.ts`

**Interfaces:**
- Produces: everything from `src/chat/{refine,trip-qa,types}` re-exported from the shared-engine barrel.

- [ ] **Step 1: Write `src/chat/index.ts`**

Export the types ONCE (from `./types`), and only the FUNCTIONS from the logic files — `refine.ts`/`trip-qa.ts` also re-export the types, so `export * from "./refine"` + `export * from "./types"` would double-export `RefineConfig`/`QAConfig`/etc. and trip a TS2308 ambiguity. Explicit function exports avoid it:

```ts
export * from "./types";
export { buildRefineSystemPrompt, proposeWizardPatch } from "./refine";
export { buildQASystemPrompt, answerTripQuestion } from "./trip-qa";
```

- [ ] **Step 2: Add the barrel line to `src/index.ts`**

Append after the existing `export * from './room';` block (keep it before the aliased `PopularityRedisLike` note if ordering matters; a fresh line at end of file is safe):

```ts
export * from './chat';
```

- [ ] **Step 3: Full typecheck + test suite (no regressions)**

Run: `cd ~/shared-engine && npm run typecheck && npm run test`
Expected: typecheck clean; all tests pass including the two new chat suites.
Note: if `export *` surfaces a name collision (as documented for `RedisLike`), narrow the chat barrel to explicit named exports instead. `Unmet`/`RefineResult`/`RefineConfig`/`QAConfig`/`QAResult`/`RefineGenerate`/`QAGenerate` are unlikely to collide — verify in the typecheck output.

- [ ] **Step 4: Commit, push, merge to main**

```bash
cd ~/shared-engine
git add src/chat/index.ts src/index.ts docs/superpowers/plans/2026-07-21-extract-chat-refine-tripqa.md docs/superpowers/plans/2026-07-21-extract-chat-is-this-worth-it.md
git commit -m "feat(chat): export chat module from barrel"
git push -u origin HEAD
gh pr create --repo ncmills/shared-engine --title "Extract refine + trip-qa into shared-engine chat module" --body "Generic, config-injected chat core so MOH/BMHQ/HHQ stop drifting. See docs/superpowers/plans/2026-07-21-extract-chat-refine-tripqa.md"
```

Then merge the PR to `main` (squash). **Record the merged main HEAD commit SHA** — consumers pin to it in Tasks 4-6.

Run after merge: `git ls-remote git@github.com:ncmills/shared-engine.git refs/heads/main`
Expected: prints the new main HEAD SHA (call it `<SHA>`).

---

## Task 4: Rewire MOH (reference consumer)

**Files:**
- Modify: `~/maid-of-honor-hq/src/lib/refine-plan.ts` (shrink to config + wrapper)
- Modify: `~/maid-of-honor-hq/src/lib/trip-qa.ts` (shrink to config + wrapper)
- Modify: `~/maid-of-honor-hq/package-lock.json` (bump shared-engine pin to `<SHA>`)

**Interfaces:**
- Consumes: `proposeWizardPatch`, `buildRefineSystemPrompt`, `answerTripQuestion`, `RefineConfig`, `QAConfig`, and the `Unmet`/`RefineResult`/`QAResult`/`*Generate` types from `shared-engine`.
- Produces: unchanged public surface — `proposeWizardPatch`, `RefineResult`, `Unmet`, `RefineGenerate`, `EDITABLE_WIZARD_FIELDS` from `@/lib/refine-plan`; `answerTripQuestion`, `pickViewedPlan`, `serializePlanForQA`, `QAResult`, `QAGenerate` from `@/lib/trip-qa`. Routes and tests importing these keep working.

- [ ] **Step 1: Bump the shared-engine pin**

```bash
cd ~/maid-of-honor-hq
npm install shared-engine@github:ncmills/shared-engine
```
Confirm `package-lock.json` now resolves shared-engine at `<SHA>` (the Task 3 merge). Run `git diff package-lock.json | grep -A2 shared-engine | head`.

- [ ] **Step 2: Find all in-repo consumers of the symbols that must survive**

Run: `cd ~/maid-of-honor-hq && grep -rn "EDITABLE_WIZARD_FIELDS\|buildRefineSystemPrompt\|serializePlanForQA\|pickViewedPlan\|from \"@/lib/refine-plan\"\|from \"@/lib/trip-qa\"" src`
Expected: the two routes + any tests. Every symbol they import must remain exported after the shrink (Steps 3-4).

- [ ] **Step 3: Rewrite `src/lib/refine-plan.ts` to config + wrapper**

Move the brand values verbatim from the CURRENT file: `EDITABLE_WIZARD_FIELDS` (lines 30-38), `FIELD_GUIDE` (64-88), `humanLabel` (192-201), and split the current system-prompt rules 4/5/6 (lines 111-135) into `destinationRule`/`directionalRule`/`alreadySetRule`. Replace the whole file with:

```ts
import type { WizardState } from "./plan-types";
import { validateWizardState } from "./validate";
import { proposeWizardPatch as sharedProposeWizardPatch, type RefineConfig } from "shared-engine";

export type { RefineGenerate, RefineResult, Unmet } from "shared-engine";

/** Trip-shaping fields the refine box may edit. Auth/PII/identity fields are deliberately EXCLUDED. */
export const EDITABLE_WIZARD_FIELDS = [
  "destinationType", "destination", "region", "states", "tripMonth", "tripYear", "flexible",
  "preferredSeason", "numberOfDays", "groupSize", "brideType", "ageRange", "nightlifePreference",
  "activityIntensity", "vibeTags", "lodging", "lodgingAmenities", "transportPreference", "dining",
  "activities", "budget", "budgetPriorities", "specialRequests", "anyPregnant", "anySober",
  "anyMobilityLimited", "bridePaysShare", "downtimePreference", "honoringMomentPreference",
  "dietaryRestrictions", "newMembers", "brideHobbies", "brideFavoriteMusic", "brideFavoriteDrink",
  "brideFavoriteFood",
] as const satisfies readonly (keyof WizardState)[];

const FIELD_GUIDE = `
<PASTE lines 64-88 of the current refine-plan.ts verbatim — the MOH FIELD_GUIDE body>`.trim();

// Rule 4 (destination scope + named-venue) — verbatim from current lines 111-123, joined with "\n".
const DESTINATION_RULE = [
  "4. APPLY any destination anywhere in the USA the user names, however phrased — a city, a state, a",
  // ... paste lines 112-123 verbatim ...
].join("\n");

// Rule 5 (directional words) — verbatim from current lines 124-130.
const DIRECTIONAL_RULE = [
  "5. DIRECTIONAL words that mean more/less of an existing axis are NOT vague — APPLY them to that field:",
  // ... paste lines 125-130 verbatim ...
].join("\n");

// Rule 6 (already-set honesty) — verbatim from current lines 131-135.
const ALREADY_SET_RULE = [
  "6. If the requested change is ALREADY the current value (ANY field — a bride type already set,",
  // ... paste lines 132-135 verbatim ...
].join("\n");

export const REFINE_CONFIG: RefineConfig<WizardState> = {
  editableFields: EDITABLE_WIZARD_FIELDS,
  validate: validateWizardState,
  fieldGuide: FIELD_GUIDE,
  plannerNoun: "bachelorette-trip planner",
  cascadeExampleFields: "`vibeTags`/`brideType`/`activityIntensity`",
  destinationRule: DESTINATION_RULE,
  directionalRule: DIRECTIONAL_RULE,
  alreadySetRule: ALREADY_SET_RULE,
  // Rule 7 — MOH verbatim (current refine-plan.ts:136-137). NOT invariant: HHQ/BMHQ differ.
  typeTagsRule: [
    "7. `activities`/`dining` are short TYPE tags (e.g. \"spa\", \"wine tasting\") — never write specific venue",
    "   names or itinerary prose into them. `what`/`why`/`fix` must be short, specific, user-facing, no jargon.",
  ].join("\n"),
  humanLabels: {
    numberOfDays: "trip length", groupSize: "group size", activityIntensity: "intensity",
    budgetPriorities: "budget priorities", specialRequests: "special requests",
    honoringMomentPreference: "the honoring moment", downtimePreference: "pacing",
    dietaryRestrictions: "dietary needs",
  },
  noopFallbackNote:
    "That didn't map to anything I can change. I can adjust destination, dates, trip length, group " +
    "size, vibe, intensity, budget, lodging style, dining, activities, pacing, or the honoring moment — " +
    "try naming one of those.",
};

/** MOH-bound refine. Route import path (`@/lib/refine-plan`) is unchanged. */
export function proposeWizardPatch(
  current: WizardState,
  tweak: string,
  opts: { generate: import("shared-engine").RefineGenerate },
) {
  return sharedProposeWizardPatch<WizardState>(current, tweak, { generate: opts.generate, config: REFINE_CONFIG });
}
```
Note: the `RefineResult<T>` returned now carries `changed: string[]` (was `EditableField[]`). If any caller relied on the narrower element type, widen the annotation — string values are identical.

- [ ] **Step 4: Rewrite `src/lib/trip-qa.ts` to config + wrapper**

Keep `pickViewedPlan` (current lines 14-30) and `serializePlanForQA` (33-56) exactly as-is; drop `buildQASystemPrompt`/`answerTripQuestion`/`QAResult`/`QAGenerate` local defs and source them from shared:

```ts
import type { GeneratedPlan, StoredPlan } from "./plan-types";
import { answerTripQuestion as sharedAnswerTripQuestion, type QAConfig } from "shared-engine";

export type { QAGenerate, QAResult } from "shared-engine";

export function pickViewedPlan(stored: StoredPlan, dest?: string, tier?: string): GeneratedPlan | null {
  // ... verbatim current lines 14-30 ...
}

export function serializePlanForQA(plan: GeneratedPlan): string {
  // ... verbatim current lines 33-56 ...
}

const QA_CONFIG: QAConfig<StoredPlan, GeneratedPlan> = {
  pickViewedPlan,
  serializePlan: (plan) => serializePlanForQA(plan),
  tripNoun: "bachelorette trip",
  // MOH has no extra guardrails.
};

/** MOH-bound Q&A. Route import path (`@/lib/trip-qa`) is unchanged. */
export function answerTripQuestion(
  plan: GeneratedPlan,
  question: string,
  opts: { generate: import("shared-engine").QAGenerate },
) {
  return sharedAnswerTripQuestion<StoredPlan, GeneratedPlan>(plan, question, { generate: opts.generate, config: QA_CONFIG });
}
```

- [ ] **Step 5: Typecheck + build**

Run: `cd ~/maid-of-honor-hq && npx tsc --noEmit && npm run build`
Expected: no type errors; build succeeds. Fix any import-type mismatches surfaced (they indicate a caller relying on a removed local symbol — re-export it).

- [ ] **Step 6: Behavior-parity spot check (real transport optional; prompt-parity required)**

Run a Node/tsx snippet that builds `REFINE_CONFIG` and asserts `buildRefineSystemPrompt(REFINE_CONFIG)` (imported from shared-engine) equals the OLD prompt string for MOH. Easiest: before the rewrite, save `git show HEAD:src/lib/refine-plan.ts` output of the old `buildRefineSystemPrompt()` to a fixture, then diff.

```bash
cd ~/maid-of-honor-hq
npx tsx -e "import {buildRefineSystemPrompt} from 'shared-engine'; import {REFINE_CONFIG} from './src/lib/refine-plan'; console.log(buildRefineSystemPrompt(REFINE_CONFIG))" > /tmp/moh-refine-new.txt
# Compare against the pre-extraction prompt captured from the old file.
diff /tmp/moh-refine-old.txt /tmp/moh-refine-new.txt && echo "REFINE PROMPT IDENTICAL"
```
Expected: `REFINE PROMPT IDENTICAL` (byte-for-byte — the whole point is behavior preservation). Repeat for the QA prompt.

- [ ] **Step 7: Commit + push (auto-deploys)**

```bash
cd ~/maid-of-honor-hq
git add src/lib/refine-plan.ts src/lib/trip-qa.ts package.json package-lock.json
git commit -m "refactor(chat): consume shared-engine chat core (MOH)"
git push origin main
```

---

## Task 5: Rewire BMHQ (`plan-my-party`)

**Files:**
- Modify: `~/plan-my-party/src/lib/refine-plan.ts`
- Modify: `~/plan-my-party/src/lib/trip-qa.ts`
- Modify: `~/plan-my-party/package-lock.json`

**Interfaces:**
- Consumes: same shared-engine surface as Task 4.
- Produces: same unchanged local surface as Task 4, with BMHQ's validator named `validateWizardInput` (aliased) and BMHQ's groom/bachelor vocab.

- [ ] **Step 1: Bump pin** — `cd ~/plan-my-party && npm install shared-engine@github:ncmills/shared-engine` (resolves to `<SHA>`).

- [ ] **Step 2: Survivor grep** — `grep -rn "EDITABLE_WIZARD_FIELDS\|serializePlanForQA\|pickViewedPlan\|from \"@/lib/refine-plan\"\|from \"@/lib/trip-qa\"" src`. Preserve every imported symbol.

- [ ] **Step 3: Rewrite `src/lib/refine-plan.ts`** exactly as Task 4 Step 3, but with BMHQ's brand values pasted verbatim from the CURRENT `plan-my-party/src/lib/refine-plan.ts`:
  - `EDITABLE_WIZARD_FIELDS` — BMHQ list (groom fields, `regionStates`, `mixedGenerations`, no `anyPregnant/anySober/anyMobilityLimited`).
  - `FIELD_GUIDE` — BMHQ body.
  - `plannerNoun: "bachelor-party planner"`.
  - `cascadeExampleFields` — BMHQ's example-field triple from its rule 1.
  - `destinationRule`/`directionalRule`/`alreadySetRule` — BMHQ's rule 4/5/6 bodies verbatim.
  - `typeTagsRule` — BMHQ's rule 7 body verbatim (the two lines joined by `"\n"`). NOT invariant — copy BMHQ's exact wording.
  - `humanLabels` — BMHQ map.
  - `noopFallbackNote` — BMHQ copy.
  - validator: `import { validateWizardInput as validateWizardState } from "./validate"` (BMHQ names it `validateWizardInput`).

- [ ] **Step 4: Rewrite `src/lib/trip-qa.ts`** as Task 4 Step 4, `tripNoun: "bachelor party"`, BMHQ's `pickViewedPlan`/`serializePlanForQA` kept verbatim, no `extraGuardrails`.

- [ ] **Step 5: Typecheck + build** — `cd ~/plan-my-party && npx tsc --noEmit && npm run build`. Expected: clean.

- [ ] **Step 6: Prompt-parity diff** — same capture/diff as Task 4 Step 6 against BMHQ's pre-extraction prompts. Expected: IDENTICAL. **Watch the enum-drift fix from this session** (chill-king/adrenaline/golfer/comedy-entertainment) is preserved in the pasted FIELD_GUIDE.

- [ ] **Step 7: Commit + push**

```bash
cd ~/plan-my-party
git add src/lib/refine-plan.ts src/lib/trip-qa.ts package.json package-lock.json
git commit -m "refactor(chat): consume shared-engine chat core (BMHQ)"
git push origin main
```
Note: MOH + BMHQ share a pre-commit brand-drift/parity check (`reference_moh_bm_precommit_parity`) — let it run; resolve any parity complaint before pushing.

---

## Task 6: Rewire HHQ (`handicap-hq`) — adds the shared-engine dependency

**Files:**
- Modify: `~/handicap-hq/package.json` (ADD `shared-engine` dep), `~/handicap-hq/package-lock.json`
- Modify: `~/handicap-hq/src/lib/refine-plan.ts`
- Modify: `~/handicap-hq/src/lib/trip-qa.ts`

**Interfaces:**
- Consumes: same shared-engine surface. HHQ's `answerTripQuestion` wrapper additionally threads `timing`.
- Produces: same unchanged local surface, PLUS the golf-correct `noopFallbackNote` (fixes today's copy bug).

- [ ] **Step 1: Add the dependency**

```bash
cd ~/handicap-hq
npm install shared-engine@github:ncmills/shared-engine
```
Confirm `package.json` now has `"shared-engine": "github:ncmills/shared-engine"` and the lock resolves `<SHA>`. Verify the existing `shared-data` pin is untouched.

- [ ] **Step 2: Confirm Next transpiles shared-engine**

HHQ has never depended on shared-engine. Check `next.config.*` for `transpilePackages`. If MOH/BMHQ list `shared-engine` there and HHQ does not, add it:

Run: `grep -n "transpilePackages" ~/maid-of-honor-hq/next.config.* ~/handicap-hq/next.config.*`
If MOH includes `shared-engine` and HHQ omits it, add `shared-engine` to HHQ's `transpilePackages` array. Expected after: HHQ config transpiles shared-engine like its siblings.

- [ ] **Step 3: Survivor grep** — `grep -rn "EDITABLE_WIZARD_FIELDS\|serializePlanForQA\|pickViewedPlan\|from \"@/lib/refine-plan\"\|from \"@/lib/trip-qa\"" src`. Note the ask route computes `timing` and passes it — preserve that path.

- [ ] **Step 4: Rewrite `src/lib/refine-plan.ts`** as Task 4 Step 3 with HHQ's golf brand values pasted verbatim from the CURRENT `handicap-hq/src/lib/refine-plan.ts`:
  - `EDITABLE_WIZARD_FIELDS` — HHQ golf list (lines 34-39).
  - `FIELD_GUIDE` — HHQ golf body (lines 65-86).
  - `plannerNoun: "golf-trip planner"`.
  - `cascadeExampleFields: "`courseQuality`/`skillMix`/`nightlife`"`.
  - `destinationRule` — HHQ rule 4 (lines 109-121, incl. the named-course-vs-destination + international scope).
  - `directionalRule` — HHQ rule 5 (lines 122-129).
  - `alreadySetRule` — HHQ rule 6 (lines 130-134).
  - `typeTagsRule` — HHQ rule 7 verbatim (lines 135-136), the two lines joined by `"\n"`:
    ```
    "7. `activities`/`dining` are short TYPE tags from the guide — never write specific venue/course names\n" +
    "   or itinerary prose into them. `what`/`why`/`fix` must be short, specific, user-facing, no jargon."
    ```
  - `humanLabels` — HHQ map (lines 191-201).
  - **`noopFallbackNote` — GOLF-CORRECT** (do NOT copy the MOH-worded current lines 269-272):
    ```
    "That didn't map to anything I can change. I can adjust destination, dates, trip length, group " +
    "size, rounds per day, course quality, walking vs riding, budget, lodging, dining, nightlife, or " +
    "activities — try naming one of those."
    ```
  - validator: `import { validateWizardState } from "./validate"`.

- [ ] **Step 5: Rewrite `src/lib/trip-qa.ts`** as Task 4 Step 4 with HHQ specifics. **HHQ's Q&A prompt is brand-divergent (golfer/caddie framing, Day-1/Day-2 ban interleaved in Rule 2, golf price examples) — use the `systemPrompt` override, NOT `tripNoun`/`extraGuardrails`, to preserve byte-identity + brand voice:**
  - `pickViewedPlan` — HHQ tier names (`weekender`/`pilgrimage`/`bucketList` + `bucket-list` alias), kept verbatim.
  - `serializePlanForQA(plan, timing?)` — HHQ version verbatim (courses instead of activities, `displayLabel`, timing param).
  - Keep HHQ's CURRENT local `buildQASystemPrompt()` body verbatim (the golf-framed prompt, lines 55-79 of the current file) as a local const/function, and pass its output as `systemPrompt` in `QA_CONFIG`. This is the ONE brand whose QA prompt is passed whole (byte-identical) rather than composed from the shared skeleton.
  - `QA_CONFIG: QAConfig<StoredPlan, GeneratedPlan> = { pickViewedPlan, serializePlan: (plan, timing) => serializePlanForQA(plan, timing), tripNoun: "golf trip", systemPrompt: HHQ_QA_SYSTEM_PROMPT }` (tripNoun is unused when systemPrompt is set, but harmless to keep for clarity).
  - Wrapper threads timing:
    ```ts
    export function answerTripQuestion(
      plan: GeneratedPlan, question: string,
      opts: { generate: import("shared-engine").QAGenerate; timing?: string },
    ) {
      return sharedAnswerTripQuestion<StoredPlan, GeneratedPlan>(plan, question, { generate: opts.generate, config: QA_CONFIG, timing: opts.timing });
    }
    ```
    (`serializePlan: (plan, timing) => serializePlanForQA(plan, timing)`.) Confirm the ask route still passes `{ generate, timing }`.

- [ ] **Step 6: Typecheck + build**

Run: `cd ~/handicap-hq && npx tsc --noEmit && npm run build`
Expected: clean. If build fails resolving `shared-engine`, revisit Step 2 (`transpilePackages`). If `npm run taste` is wired into build, it must still pass (no UI changes here).

- [ ] **Step 7: Prompt-parity diff (with the one intended difference)**

Capture HHQ's pre-extraction refine + QA prompts, diff against new. Expected: QA prompt IDENTICAL; refine prompt IDENTICAL EXCEPT the `noopFallbackNote` is not part of the system prompt (it's a runtime note), so the SYSTEM prompt diff is clean. Separately assert the runtime no-op note now reads the golf-correct copy (Step 4) — this is the deliberate bug fix.

- [ ] **Step 8: Commit + push**

```bash
cd ~/handicap-hq
git add src/lib/refine-plan.ts src/lib/trip-qa.ts package.json package-lock.json next.config.*
git commit -m "refactor(chat): consume shared-engine chat core (HHQ) + fix golf no-op note"
git push origin main
```

---

## Task 7: Cross-repo live verification + drift guard

**Files:**
- Create: `~/work/handoffs/2026-07-21-chat-extraction-verification.md` (results log)

- [ ] **Step 1: Confirm all three prod deploys are READY (not silently Errored)**

Run: `for p in maid-of-honor-hq plan-my-party handicap-hq; do echo "== $p =="; cd ~/$p && vercel ls 2>/dev/null | head -4; done`
Expected: latest Production deploy `● Ready` for each. If any shows `● Error` (font-flake — `reference_vercel_silent_build_error`), `vercel redeploy` it.

- [ ] **Step 2: Brand-integrity protection (per site)**

The refactor must not leak one brand's vocabulary/scope into another. For each site verify, against its OWN brand guidelines (`maid-of-honor-hq/BRAND.md`, HHQ `docs/design-system.md`, BMHQ conventions):
  - The site's `REFINE_CONFIG`/`QA_CONFIG` contain ONLY that brand's vocab — MOH bride/bachelorette, BMHQ groom/bachelor, HHQ golfer/golf. No cross-brand term (grep each config for the OTHER brands' signature words: "groom"/"bachelor"/"crew" must not appear in MOH; "bride"/"bachelorette" must not appear in BMHQ/HHQ; golf terms only in HHQ).
  - Tier names correct per brand (MOH weekendWarrior/theLegend/theKing; HHQ weekender/pilgrimage/bucketList).
  - Destination scope correct: MOH & BMHQ US-only (foreign → unmet); HHQ US + supported international.
  - The MOH↔BMHQ pre-commit brand-drift hook passed (it actively guards "crew"-leak and prop drift) — confirm it ran clean on both commits.
  - Zero UI/branding surface touched: `git diff --stat` for each consumer shows ONLY `src/lib/refine-plan.ts`, `src/lib/trip-qa.ts`, `package.json`, `package-lock.json` (+ HHQ `next.config.ts`) — no component/CSS/OG/favicon/BRAND.md change (so `feedback_favicon_og_on_design_change` is N/A — nothing branded changed).

- [ ] **Step 3: Intense, diverse, real-user live test — both features, every site**

Dispatch one test agent per site (3 parallel) against PRODUCTION (maidofhonorhq.com / bestmanhq.com / handicaphq.com). Each: generate a REAL plan via `POST /api/generate-plan` (persists 21-day TTL; use a clearly-marked test organizer name and NO real/`+qa` alias email so the harness doesn't delete the plan and no lead is captured), capture its `planId` and the exact rendered prices/venues, then exercise the FULL matrix from a real user's POV via `/api/refine` and `/api/ask` (or the live UI). Run each case, record the model's actual response, and PASS/FAIL it.

  Refine matrix (per site, brand-appropriate phrasing):
  1. Valid single-field change ("make it 4 days" / "5 guys instead") → plan rebuilds, ONLY that field changed, note names it.
  2. Valid destination change (in-scope city) → destination changes, no cascade into vibe/course/intensity.
  3. Directional word ("way wilder"/"more golf"/"chill nights") → maps to the right axis; watch for the known unrequested-tag cascade (handoff #7).
  4. Out-of-scope: booking/flights ("book us flights") → `unmet` + points to the right place, no field forced.
  5. Out-of-scope: specific named venue/course ("put us at Pebble Beach specifically" on HHQ; "book Nobu" on MOH) → `unmet` + Swap pointer, NOT a destination change.
  6. Foreign/off-catalog: MOH/BMHQ "let's go to Paris" → `unmet` (US-only); HHQ "take us to Scotland" → applies `region:"International"` + `states:["Scotland"]` and rebuilds a REAL international plan (not a degraded/fallback one — handoff #3).
  7. Already-set honesty: request the current value → `patch:{}` + honest "already set that way" unmet (names current value), NOT the generic no-op note.
  8. Ambiguous directionless ("make it fancier") → `patch:{}` + no-op fallback note in the CORRECT brand vocab (HHQ note must be golf-worded — the bug this extraction fixed).

  Q&A matrix (per site):
  9. Answer strictly from plan data (ask about a real venue/time in the generated plan) → correct verbatim.
  10. Weather ("what's the weather that weekend?") → DECLINED, no forecast invented.
  11. Exact price ("what's the cost per person?") → the EXACT figure from the plan, no rounding/estimate.
  12. No-estimate ("roughly what will Ubers cost?") → declines to ballpark; no invented number.
  13. Change request via Q&A ("can you swap the hotel?") → declines, points to the refine box / Swap.
  14. HHQ only: a weekday question ("what do we do Saturday?") → does NOT guess which day maps to Saturday (Day 1/Day 2 labeling ban).

  Record every case in the verification log with the actual response + PASS/FAIL and the planId used. Any FAIL is a real regression — stop and fix before declaring done.

- [ ] **Step 4: Real-user POV audit (per site)**

Beyond the matrix, one holistic pass per site as a real user: generate → view the itinerary → open the refine box → make a change → confirm the plan visibly rebuilds and the changed field is reflected in the rendered plan (not just the API) → open "Ask about this trip" → ask 2 real questions → confirm answers match what's on screen. Note any UX friction (handoff #6: refine box discoverability/slide-over), broken states, or answer/plan mismatch. Confirm the refine box is owner-only and Q&A is read-only for every audience.

- [ ] **Step 5: Prove the drift is gone (single source of truth)**

Run: `for p in maid-of-honor-hq plan-my-party handicap-hq; do echo "== $p =="; wc -l ~/$p/src/lib/refine-plan.ts ~/$p/src/lib/trip-qa.ts; done`
Expected: each `refine-plan.ts`/`trip-qa.ts` is now a thin config+wrapper (far shorter than the ~276/~96 originals). The algorithm + guardrail skeleton exists in exactly ONE place (`shared-engine/src/chat`).

- [ ] **Step 6: Update memory + close the handoff**

- Update `[[project_moh_nl_refine_box_0720]]`: the "REMAINING: lift refine()/trip-qa() into shared-engine" item is DONE; note `src/chat` module + the three thin consumers + HHQ took the dep + golf no-op-note bug fixed.
- Mark handoff item #1 complete in `~/work/handoffs/2026-07-21-chatbots-next-steps.md` (items #2-#7 remain).
- Optional (matches `feedback_recurring_ask_is_an_automation_signal`): note that future guardrail hardening now edits ONE file; no per-repo propagation.

---

## Self-Review

**Spec coverage:** Handoff item #1 (extract refine + trip-qa, parameterize by {editableFields, fieldGuide, validate, brand copy}, each repo keeps config+route+UI) — Tasks 1-2 build the parameterized core, Tasks 4-6 leave each repo with config+route+UI. HHQ-takes-the-dep decision — Task 6 Step 1. Anti-drift goal — Task 7 Step 3. ✅

**Placeholder scan:** The three consumer rewrites (Tasks 4-6 Step 3/4) intentionally reference "paste verbatim from current file lines X-Y" for the large brand FIELD_GUIDE / rule bodies rather than re-transcribing ~250 lines three times — re-typing them would be MORE error-prone than copying the verified originals, and Step 6/7 prompt-parity diffs mechanically prove the paste was exact. The novel/shared code (Tasks 1-3) is complete and literal. This is a deliberate, safer choice, not an unfilled placeholder.

**Type consistency:** `RefineConfig<TState>`/`QAConfig<TStored,TPlan>` shapes in Task 1 match their use in Tasks 4-6. `RefineResult.changed` widened from `EditableField[]` to `string[]` — flagged in Task 4 Step 3 for callers. `answerTripQuestion` timing param defined in Task 2, consumed in Task 6. Function names (`proposeWizardPatch`, `answerTripQuestion`, `buildRefineSystemPrompt`, `buildQASystemPrompt`, `pickViewedPlan`, `serializePlanForQA`) consistent across tasks. ✅
