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
