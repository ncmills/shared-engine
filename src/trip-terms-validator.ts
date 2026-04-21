// Post-LLM arithmetic validator for Trip Terms. Call after JSON-parsing
// the model's output; on `ok: false`, retry generation. On final failure,
// publish anyway with the errors attached as a warning — never block a
// user behind a validator bug.
//
// Input is structural (not the full GeneratedPlan) so this module can
// live in shared-engine without taking a dep on per-app plan-types.ts.

export interface TripTermsValidationInput {
  /** "$1,280" — the headline per-person total shown to users. */
  perPersonTotal: string;
  /** The budget breakdown line items that should sum to perPersonTotal. */
  breakdown?: Array<{ category: string; perPerson: string }>;
  /** Payment-timeline sentences; dollar amounts inside should sum to perPersonTotal. */
  paymentTimeline?: string[];
  /** Full party size (including honoree). */
  groupSize: number;
  /** Absorption mode. Validator only reacts to the literal "covered";
   *  other values ("split", "he-pays", "she-pays", etc.) skip rule 3. */
  honoreeShare?: string;
  /** e.g. "Split across 9 payers instead of 10 → ~$131 extra per person." */
  honoreeShareExplanation?: string;
  /** Lodging rationale string — checked for embedded "$X/night × Y nights split Z ways" math. */
  lodgingRationale?: string;
}

export interface TripTermsValidationResult {
  ok: boolean;
  errors: string[];
}

// Tolerances are deliberately loose — the goal is catching math-broken
// generations, not punishing rounding. Start here; tighten after a week
// of telemetry shows how often each rule fires on real LLM output.
const BREAKDOWN_TOLERANCE_USD = 50;
const TIMELINE_TOLERANCE_USD = 2;
const ABSORPTION_TOLERANCE_USD = 5;
const LODGING_TOLERANCE_USD = 10;

function parseDollar(s: string | undefined): number {
  if (!s) return NaN;
  const m = s.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (!m || !m[1]) return NaN;
  return parseFloat(m[1].replace(/,/g, ""));
}

function parseAllDollars(s: string): number[] {
  const matches = s.match(/\$\s*[\d,]+(?:\.\d+)?/g) ?? [];
  return matches
    .map((m) => parseFloat(m.replace(/[$,\s]/g, "")))
    .filter((n) => Number.isFinite(n));
}

export function validateTripTerms(input: TripTermsValidationInput): TripTermsValidationResult {
  const errors: string[] = [];
  const target = parseDollar(input.perPersonTotal);

  if (!Number.isFinite(target) || target <= 0) {
    errors.push(`perPersonTotal "${input.perPersonTotal}" does not parse to a positive dollar amount`);
    return { ok: false, errors };
  }

  // Rule 1: sum of breakdown line items should land near perPersonTotal.
  if (input.breakdown && input.breakdown.length > 0) {
    const sum = input.breakdown.reduce((acc, line) => {
      const n = parseDollar(line.perPerson);
      return acc + (Number.isFinite(n) ? n : 0);
    }, 0);
    const delta = Math.abs(sum - target);
    if (delta > BREAKDOWN_TOLERANCE_USD) {
      errors.push(
        `breakdown line items sum to $${sum.toFixed(0)} but perPersonTotal is $${target.toFixed(0)} (delta $${delta.toFixed(0)}; tolerance $${BREAKDOWN_TOLERANCE_USD})`
      );
    }
  }

  // Rule 2: numeric amounts in paymentTimeline sentences should sum to perPersonTotal.
  // We ignore payments that sum well below target (they're probably partial descriptions,
  // not full-payment schedules); only flag when the sum exists AND diverges.
  if (input.paymentTimeline && input.paymentTimeline.length > 0) {
    const allAmounts = input.paymentTimeline.flatMap(parseAllDollars);
    if (allAmounts.length >= 2) {
      const sum = allAmounts.reduce((a, b) => a + b, 0);
      // Only flag if the sum looks like a full-plan payment total (within a
      // reasonable range of target). If it's way bigger, it's probably a
      // cumulative+incremental mix and we skip.
      if (sum > target * 0.5 && sum < target * 1.5) {
        const delta = Math.abs(sum - target);
        if (delta > TIMELINE_TOLERANCE_USD) {
          errors.push(
            `paymentTimeline dollar amounts sum to $${sum.toFixed(0)} but perPersonTotal is $${target.toFixed(0)} (delta $${delta.toFixed(0)}; tolerance $${TIMELINE_TOLERANCE_USD})`
          );
        }
      }
    }
  }

  // Rule 3: honoree absorption math. If honoreeShare is "covered", the other
  // (groupSize - 1) payers each cover an extra slice. Expected delta per
  // payer = perPersonTotal / (groupSize - 1). The explanation should cite a
  // number near that.
  if (
    input.honoreeShare === "covered" &&
    input.groupSize > 1 &&
    input.honoreeShareExplanation
  ) {
    const expected = target / (input.groupSize - 1);
    const cited = parseAllDollars(input.honoreeShareExplanation);
    // The explanation may also cite the payer's total ($X + target). Match
    // against the value closest to `expected` to be lenient on phrasing.
    if (cited.length > 0) {
      const closest = cited.reduce((best, v) =>
        Math.abs(v - expected) < Math.abs(best - expected) ? v : best
      );
      const delta = Math.abs(closest - expected);
      if (delta > ABSORPTION_TOLERANCE_USD) {
        errors.push(
          `honoreeShareExplanation cites ~$${closest.toFixed(0)} as the per-payer addition but expected is ~$${expected.toFixed(0)} (groupSize ${input.groupSize}, delta $${delta.toFixed(0)}; tolerance $${ABSORPTION_TOLERANCE_USD})`
        );
      }
    }
  }

  // Rule 4: lodging math. If rationale contains "$X/night × Y nights split Z ways"
  // (or similar patterns with explicit numbers), verify X × Y / Z.
  if (input.lodgingRationale) {
    const m = input.lodgingRationale.match(
      /\$\s*([\d,]+)\s*\/\s*night[^0-9]{0,20}(\d+)\s*night[^0-9]{0,20}split\s*(\d+)\s*ways?/i
    );
    if (m && m[1] && m[2] && m[3] && m.index !== undefined) {
      const perNight = parseFloat(m[1].replace(/,/g, ""));
      const nights = parseFloat(m[2]);
      const split = parseFloat(m[3]);
      if (split > 0 && Number.isFinite(perNight) && Number.isFinite(nights)) {
        const expectedPerPerson = (perNight * nights) / split;
        // Look for a cited per-person figure after the pattern, e.g. "= $325/person".
        const tailStart = m.index + m[0].length;
        const tail = input.lodgingRationale.slice(tailStart, tailStart + 60);
        const cited = parseAllDollars(tail);
        const first = cited[0];
        if (first !== undefined) {
          const delta = Math.abs(first - expectedPerPerson);
          if (delta > LODGING_TOLERANCE_USD) {
            errors.push(
              `lodging math "$${perNight}/night × ${nights} nights split ${split} ways" should be $${expectedPerPerson.toFixed(0)}/person but cites $${first.toFixed(0)} (delta $${delta.toFixed(0)}; tolerance $${LODGING_TOLERANCE_USD})`
            );
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
