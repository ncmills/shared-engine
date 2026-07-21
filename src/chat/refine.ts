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
  // NOTE: the note/what/why/fix strings below are intentionally INVARIANT, not brand-configurable —
  // verified byte-identical across MOH/BMHQ/HHQ 2026-07-21. Do not add a config slot for these; a
  // future brand-onboarder should assume they're shared, not something to customize per-brand.
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
  );

  let note: string;
  if (changed.length) {
    note = `Updated ${changed.map((k) => config.humanLabels[k as keyof TState & string] ?? String(k)).join(", ")}.`;
  } else if (unmet) {
    // NOTE: intentionally INVARIANT, like the catch-block note above — not a config slot.
    note = "I couldn't make that change here.";
  } else {
    note = config.noopFallbackNote;
  }

  return { next, changed: changed.map((k) => String(k)), note, unmet, patch };
}
