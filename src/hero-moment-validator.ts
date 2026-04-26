/**
 * Hero-moment validator.
 *
 * Every plan tier produced by the wizard must include a `heroMoment` — a
 * single, named, specific beat that anchors the editorial DNA of the
 * curated atlases. This validator is the gate that keeps the model honest
 * when it tries to free-generate "dinner downtown" or "drinks at a rooftop
 * bar" instead of "Capt. Nick Stanczyk at midnight, 1500ft, broadbills
 * under the spreader lights."
 *
 * v1 is regex/lexical only — fast, deterministic, no API calls. The Plan
 * agent's design called for a hybrid (regex first, Haiku judge for
 * suspects); the judge is deferred to a tuning iteration once we observe
 * how often regex-pass-but-still-generic outputs slip through.
 *
 * See ~/.claude/plans/here-is-a-prompt-concurrent-gizmo.md, Phase 1.
 */

import type { HeroMoment } from "./types";

export interface HeroMomentValidationResult {
  ok: boolean;
  /** Empty when ok; otherwise human-readable reasons for rejection. */
  reasons: string[];
  /** Specificity score (0–10). Useful for telemetry / future judge gating. */
  score: number;
}

// Generic activity nouns that ALONE can't carry a hero moment. They have to
// pair with a named operator or a specific venue/time/equipment to pass.
const GENERIC_ACTIVITY_RE =
  /\b(dinner|lunch|brunch|breakfast|drinks?|night ?out|day ?trip|happy hour|cocktails?|food tour|bar crawl|bar hopping|wine tasting|spa day|pool day|beach day|sightseeing|shopping)\b/i;

// Time-of-day or seasonal markers that signal specificity.
const TIME_MARKER_RE =
  /\b(\d{1,2}(?::\d{2})?\s?(?:am|pm)|midnight|dawn|dusk|sunrise|sunset|pre-?dawn|after\s+\d|spring|summer|fall|autumn|winter|january|february|march|april|may|june|july|august|september|october|november|december|opener|rut|peak|run|window|migration|harvest|season)\b/i;

// Equipment / specifics that signal a hero moment isn't generic.
const SPECIFIC_NOUN_RE =
  /\b(\d+\s?(?:ft|feet|foot|miles?|knots?|lb|pound|inches?|hp|horsepower|grain|gauge|cc|liter)|spreader lights?|fly rod|float ?plane|helicopter|R\d{2}|UTV|ATV|sloop|schooner|bobsled|trawler|outboard|drift boat|side-?by-?side|.50\s?cal|.30-?06|spotter|guide|outfitter|hatch|spawn|run|chukar|elk|tarpon|swordfish|broadbill|bonefish|mahi|striper|stripers?)\b/i;

// Lightweight proper-noun heuristic: capitalized non-stopword words that
// aren't sentence-starters. False positives are fine; false negatives are
// the worry. We just need to know if SOMETHING is named.
const STOPWORDS = new Set([
  "The", "A", "An", "And", "Or", "But", "On", "At", "In", "Of", "For", "To",
  "With", "By", "From", "Day", "Night", "Morning", "Evening", "Weekend",
  "Trip", "Tour", "Group", "Party", "I", "We", "You", "It", "This", "That",
  "These", "Those", "His", "Her", "Their", "Our", "My",
]);

function countProperNouns(text: string): number {
  let count = 0;
  // Skip the first word of each sentence (capitalization isn't a signal there).
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const tokens = sentence.split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      const raw = tokens[i];
      if (!raw) continue;
      const tok = raw.replace(/[^\w'-]/g, "");
      if (!tok) continue;
      if (i === 0) continue; // first word of sentence
      if (STOPWORDS.has(tok)) continue;
      if (/^[A-Z][a-zA-Z'-]+$/.test(tok)) count += 1;
    }
  }
  return count;
}

function looksGenericTitle(title: string, namedOperator?: string): boolean {
  if (!GENERIC_ACTIVITY_RE.test(title)) return false;
  // A generic activity word is OK when paired with a named operator,
  // a proper-noun specific venue token, or a time/season marker.
  if (namedOperator && namedOperator.trim().length >= 3) return false;
  if (TIME_MARKER_RE.test(title)) return false;
  if (SPECIFIC_NOUN_RE.test(title)) return false;
  if (countProperNouns(title) >= 1) return false;
  return true;
}

export function validateHeroMoment(
  h: HeroMoment | undefined | null,
): HeroMomentValidationResult {
  const reasons: string[] = [];

  if (!h) {
    return { ok: false, reasons: ["heroMoment is missing"], score: 0 };
  }

  const title = (h.title ?? "").trim();
  const description = (h.description ?? "").trim();
  const namedOperator = (h.namedOperator ?? "").trim() || undefined;
  const season = (h.season ?? "").trim() || undefined;

  if (title.length === 0) reasons.push("title is empty");
  if (title.length > 80) reasons.push(`title is ${title.length} chars (>80)`);
  if (description.length < 40) {
    reasons.push(`description is ${description.length} chars (<40 minimum)`);
  }

  const combined = `${title}. ${description}`;
  const properNounCount = countProperNouns(combined);
  const hasTimeMarker = TIME_MARKER_RE.test(combined) || Boolean(season);
  const hasSpecificNoun = SPECIFIC_NOUN_RE.test(combined);
  const hasOperator = Boolean(namedOperator);

  if (looksGenericTitle(title, namedOperator)) {
    reasons.push(
      `title "${title}" reads as generic; pair with a named operator, ` +
        `specific venue, or time/season marker`,
    );
  }

  if (properNounCount === 0 && !hasOperator) {
    reasons.push(
      "no proper-noun specifics in title+description and no namedOperator " +
        "— hero moments must be anchored to something/someone real",
    );
  }

  if (!hasTimeMarker && !hasSpecificNoun && properNounCount < 2) {
    reasons.push(
      "missing all of: time/season marker, specific equipment/species, " +
        "or 2+ named entities — at least one required for a hero moment",
    );
  }

  // Specificity score: rough indicator for telemetry.
  const score =
    (hasOperator ? 3 : 0) +
    (hasTimeMarker ? 2 : 0) +
    (hasSpecificNoun ? 2 : 0) +
    Math.min(properNounCount, 3);

  return { ok: reasons.length === 0, reasons, score };
}

/**
 * Optional LLM-judge fallback for hero-moment validation.
 *
 * Engine stays framework-agnostic — the consumer provides a `judge`
 * function that returns `{ ok, reason }` for a borderline heroMoment.
 * Adapter callers wire this to Haiku 4.5 (or any other model) and
 * decide when to invoke it based on observed `degraded:true` rate.
 *
 * The judge ONLY runs when regex validation FAILS — never costs an
 * API call on success. Returns the original regex result if no judge
 * is provided or the judge throws.
 */
export interface HeroMomentJudgeInput {
  heroMoment: HeroMoment;
  regexReasons: string[];
}
export interface HeroMomentJudgeResult {
  ok: boolean;
  reason?: string;
}
export type HeroMomentJudge = (input: HeroMomentJudgeInput) => Promise<HeroMomentJudgeResult>;

export interface HeroMomentValidationResultWithJudge extends HeroMomentValidationResult {
  /** Set when the judge overrode regex (true=judge passed, false=judge upheld regex). */
  judgeOverrode?: boolean;
  /** Judge's verbatim reason (for telemetry). */
  judgeReason?: string;
}

export async function validateHeroMomentWithJudge(
  h: HeroMoment | undefined | null,
  judge?: HeroMomentJudge,
): Promise<HeroMomentValidationResultWithJudge> {
  const regex = validateHeroMoment(h);
  if (regex.ok || !judge || !h) return regex;
  try {
    const verdict = await judge({ heroMoment: h, regexReasons: regex.reasons });
    if (verdict.ok) {
      // Judge override — promote to ok=true, keep regex reasons in case ops wants to see why regex flagged.
      return {
        ok: true,
        reasons: regex.reasons,
        score: regex.score,
        judgeOverrode: true,
        judgeReason: verdict.reason,
      };
    }
    return {
      ...regex,
      judgeOverrode: false,
      judgeReason: verdict.reason,
    };
  } catch {
    // Judge errored — fall back to regex verdict, don't crash the tier.
    return regex;
  }
}

/**
 * Build a corrective message to inject on retry when validation fails.
 * Used by the generate-plan route to give Claude one more shot before
 * tagging the tier `degraded: true`.
 */
export function buildHeroMomentRetryHint(
  result: HeroMomentValidationResult,
): string {
  const issues = result.reasons.length === 0 ? "(unspecified)" : result.reasons.join("; ");
  return [
    "Your previous heroMoment failed the editorial gate.",
    `Issues: ${issues}`,
    "Required: a single specific beat with at least ONE of:",
    "  • a named operator/captain/lodge/distillery (e.g. 'Capt. Nick Stanczyk', 'Garrison Brothers')",
    "  • a specific season window or time-of-day (e.g. 'September elk rut', 'pre-dawn flat-water')",
    "  • specific equipment / species / depth / distance / horsepower",
    "Do NOT submit generic phrases like 'dinner downtown', 'drinks at a rooftop bar',",
    "or 'wine tasting day' without anchoring detail. Regenerate this tier.",
  ].join("\n");
}
