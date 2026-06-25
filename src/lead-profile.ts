/**
 * lead-profile — assemble a sellable, scoreable lead profile (the `profile`
 * jsonb body on wp_leads) by folding a visitor's anonymous behavioral signal
 * rows together with the explicit wizard answers, the derived scalars, and
 * (later) third-party enrichment.
 *
 * Shape mirrors the architecture report §2E "unified lead object":
 *   { explicit, derived, behavior, enrichment?, provenance:{first_seen,last_seen,plan_ids} }
 *
 * Zero I/O. Pure folding of already-fetched rows. The per-repo
 * src/lib/lead-capture.ts does the Supabase/Redis querying and calls these.
 *
 * DEFENSIVE BY DESIGN: signal rows are loose jsonb written by clients over a
 * long period; field names + types drift. Every read is guarded so a malformed
 * row can never throw out of profile assembly (capture must still succeed).
 */

import type { DerivedLeadFields } from "./derive";

// ── Behavioral signal row (as stored in wp_plan_inputs / wp_plan_selections /
//    wp_acquisition_log / wp_plan_bookmarks). Each row is loose. ─────────────

/** A raw signal row as returned from Supabase. `payload` is loose jsonb. */
export interface SignalRow {
  /** Physical wp_* table the row came from. Used to route the fold. */
  table?: string;
  session_id?: string;
  brand?: string;
  payload?: Record<string, unknown> | null;
  created_at?: string | null;
}

export interface BehaviorSummary {
  plans_generated: number;
  steps_completed: number;
  /** Highest step index seen as completed, or null. */
  abandoned_at_step: number | null;
  /** step index (string key) → max dwell ms observed for that step. */
  dwell_ms_by_step: Record<string, number>;
  /** total option-toggle events (add or remove). */
  options_clicked: number;
  /** distinct options currently selected (adds minus removes, floored at 0). */
  options_selected: number;
  /** distinct daily session_ids seen for this vid (coarse return-visit proxy). */
  return_visits: number;
  /** first-touch acquisition, when an acquisition_log row exists. */
  acquisition?: {
    ref?: string;
    utm?: Record<string, string>;
    device?: string;
    landing?: string;
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

/**
 * Fold a visitor's signal rows into a behavior summary. Tolerates rows from
 * any of the wp_* signal tables (routed by `row.table`), unknown shapes, and
 * missing fields. Never throws.
 */
export function assembleBehavior(rows: SignalRow[]): BehaviorSummary {
  const summary: BehaviorSummary = {
    plans_generated: 0,
    steps_completed: 0,
    abandoned_at_step: null,
    dwell_ms_by_step: {},
    options_clicked: 0,
    options_selected: 0,
    return_visits: 0,
  };
  if (!Array.isArray(rows) || rows.length === 0) return summary;

  const sessions = new Set<string>();
  // Track net selection count per "slot::optionId" key so we can floor at 0.
  const netSelections = new Map<string, number>();
  let maxStep = -1;

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const table = asString(row.table) ?? "";
    const sid = asString(row.session_id);
    if (sid) sessions.add(sid);
    const payload = asRecord(row.payload) ?? {};

    // plan_inputs == a generated plan (full WizardState captured at generate).
    if (table.includes("plan_inputs")) {
      summary.plans_generated += 1;
      continue;
    }

    // plan_selections — option toggles AND per-step dwell co-emits.
    if (table.includes("plan_selections")) {
      const slot = asString(payload.slot);
      const action = asString(payload.action); // "add" | "remove"
      const dwellMs = asFiniteNumber(payload.dwellMs);

      // Per-step dwell rows are emitted with slot === "step-N" and a dwellMs.
      if (slot && /^step-/.test(slot) && dwellMs != null) {
        const stepKey = slot.replace(/^step-/, "");
        const stepNum = asFiniteNumber(stepKey);
        if (stepNum != null) {
          maxStep = Math.max(maxStep, stepNum);
          const prev = summary.dwell_ms_by_step[stepKey] ?? 0;
          if (dwellMs > prev) summary.dwell_ms_by_step[stepKey] = Math.round(dwellMs);
        }
        continue;
      }

      // Otherwise it's an option toggle.
      summary.options_clicked += 1;
      const optionId = asString(payload.optionId) ?? "";
      const key = `${slot ?? ""}::${optionId}`;
      const delta = action === "remove" ? -1 : 1;
      netSelections.set(key, (netSelections.get(key) ?? 0) + delta);
      continue;
    }

    if (table.includes("acquisition_log")) {
      // First acquisition wins (rows are passed most-recent-first by the
      // caller; the LAST one we see is the earliest = first touch).
      const utm = asRecord(payload.utm) as Record<string, string> | null;
      summary.acquisition = {
        ref: asString(payload.ref),
        utm: utm ?? undefined,
        device: asString(payload.device),
        landing: asString(payload.landing),
      };
      continue;
    }

    // plan_bookmarks / others — counted as option-ish engagement, non-fatal.
    if (table.includes("plan_bookmarks")) {
      summary.options_clicked += 1;
      continue;
    }
  }

  // options_selected = distinct keys with net positive selection.
  let selected = 0;
  for (const n of netSelections.values()) if (n > 0) selected += 1;
  summary.options_selected = selected;

  summary.return_visits = sessions.size;
  summary.steps_completed = maxStep >= 0 ? Object.keys(summary.dwell_ms_by_step).length : 0;
  summary.abandoned_at_step = maxStep >= 0 ? maxStep : null;

  return summary;
}

// ── Profile assembly ─────────────────────────────────────────────────────

export interface LeadProvenance {
  first_seen: string | null;
  last_seen: string | null;
  plan_ids: string[];
}

export interface LeadProfile {
  explicit: Record<string, unknown>;
  derived: DerivedLeadFields | Record<string, unknown> | null;
  behavior: BehaviorSummary;
  enrichment?: Record<string, unknown>;
  provenance: LeadProvenance;
}

export interface BuildLeadProfileInput {
  /** Compacted explicit wizard answers (the latest WizardState, or a subset). */
  explicit?: Record<string, unknown> | null;
  /** Derived scalars (deriveLeadFields output) — stored verbatim. */
  derived?: DerivedLeadFields | Record<string, unknown> | null;
  /** Behavior summary from assembleBehavior. */
  behavior?: BehaviorSummary | null;
  /** Optional third-party enrichment (deferred — usually omitted in v1). */
  enrichment?: Record<string, unknown> | null;
  /** Provenance: timestamps + plan ids joined for this visitor. */
  provenance?: Partial<LeadProvenance> | null;
}

function emptyBehavior(): BehaviorSummary {
  return {
    plans_generated: 0,
    steps_completed: 0,
    abandoned_at_step: null,
    dwell_ms_by_step: {},
    options_clicked: 0,
    options_selected: 0,
    return_visits: 0,
  };
}

/**
 * Assemble the `profile` jsonb body. Pure + defensive — any missing block is
 * filled with a sane empty default so the stored shape is always consistent.
 */
export function buildLeadProfile(input: BuildLeadProfileInput): LeadProfile {
  const explicit = asRecord(input.explicit) ?? {};
  const behavior = input.behavior ?? emptyBehavior();
  const prov = input.provenance ?? {};
  const profile: LeadProfile = {
    explicit,
    derived: input.derived ?? null,
    behavior,
    provenance: {
      first_seen: prov.first_seen ?? null,
      last_seen: prov.last_seen ?? null,
      plan_ids: Array.isArray(prov.plan_ids) ? prov.plan_ids.filter((x) => typeof x === "string") : [],
    },
  };
  const enrichment = asRecord(input.enrichment);
  if (enrichment && Object.keys(enrichment).length > 0) profile.enrichment = enrichment;
  return profile;
}
