// Post-LLM brand-voice validator. Call after JSON-parsing the model's output.
//
// Why this exists: as of the 2026-07-31 editorial audit, every brand-voice
// gate in the fleet was STATIC — BM/MOH's `check-brand-drift.ts` lints source
// files, HHQ's and OO's taste gates check colors only. Nothing inspected a
// GENERATED PLAN, which is the actual product. A live MOH run emitted
// "Monogrammed tote bags with 'Marisa's Crew'" — `crew` is banned in MOH's
// BRAND.md and banned twice in MOH's own prompt, and it still shipped.
//
// Follows the `trip-terms-validator.ts` contract: report, don't throw. The
// caller decides whether to retry, scrub, or publish with a warning — never
// block a user behind a validator bug.
//
// Input is a plain object (not GeneratedPlan) so this stays free of per-app
// plan-types deps, same as the trip-terms validator.

import type { BrandId } from './types';

export interface VoiceViolation {
  /** Canonical banned term, e.g. "crew" — not the matched inflection. */
  term: string;
  /** `banned` = the brand's BRAND.md forbids it (worth a retry).
   *  `cliche` = generic AI slop, house style only (worth a log line). */
  severity: 'banned' | 'cliche';
  /** Dotted path into the plan, e.g. "welcomeKit.optional[0]". */
  path: string;
  /** Occurrences within this one string. */
  count: number;
  /** The offending text, trimmed for logging. */
  sample: string;
}

export interface VoiceValidationResult {
  ok: boolean;
  violations: VoiceViolation[];
}

export interface VoiceValidationInput {
  plan: unknown;
  brandId: BrandId;
}

interface BannedTerm {
  /** Canonical name reported in the violation. */
  term: string;
  re: RegExp;
  severity: 'banned' | 'cliche';
}

/** Shared across both party brands — the "research red flag" adjectives and
 *  travel-brochure clichés both BRAND.md files ban. */
const SHARED_BANNED: BannedTerm[] = [
  // Named in both BRAND.md banned lists.
  { term: 'world-class', re: /\bworld[-\s]class\b/gi, severity: 'banned' },
  { term: 'premium', re: /\bpremium\b/gi, severity: 'banned' },
  { term: 'trusted', re: /\btrusted\b/gi, severity: 'banned' },
  { term: 'cutting-edge', re: /\bcutting[-\s]edge\b/gi, severity: 'banned' },
  // Travel-brochure slop — not in either BRAND.md, so advisory only.
  { term: 'hidden gem', re: /\bhidden gem\b/gi, severity: 'cliche' },
  { term: 'nestled', re: /\bnestled\b/gi, severity: 'cliche' },
  { term: 'something for everyone', re: /\bsomething for everyone\b/gi, severity: 'cliche' },
];

// BestMan-coded terms. MOH's BRAND.md: "all BESTMAN voice — never port".
// `send-it` is matched ONLY hyphenated: the bare verb phrase "send it to Jess"
// is ordinary English and flagging it makes the gate untrustworthy.
const BESTMAN_CODED: BannedTerm[] = [
  { term: 'crew', re: /\bcrews?\b/gi , severity: 'banned' },
  { term: 'squad', re: /\bsquads?\b/gi , severity: 'banned' },
  { term: 'send-it', re: /\bsend-it\b/gi , severity: 'banned' },
  { term: 'babe', re: /\bbabes?\b/gi , severity: 'banned' },
  { term: 'bride tribe', re: /\bbride tribe\b/gi , severity: 'banned' },
  { term: 'bachelor', re: /\bbachelor\b/gi , severity: 'banned' },
  { term: 'groom', re: /\bgrooms?\b/gi , severity: 'banned' },
  { term: 'groomsmen', re: /\bgroomsm[ae]n\b/gi , severity: 'banned' },
  { term: 'best man', re: /\bbest man\b/gi , severity: 'banned' },
];

// Bachelorette-coded terms that must not appear in a BestMan plan.
const MOH_CODED: BannedTerm[] = [
  { term: 'bridesmaid', re: /\bbridesmaids?\b/gi , severity: 'banned' },
  { term: 'bachelorette', re: /\bbachelorette\b/gi , severity: 'banned' },
  { term: 'the bride', re: /\bthe bride\b/gi , severity: 'banned' },
];

// BestMan bans king/goat/legend as a NOUN or honorific FOR A PERSON — the
// prompt's own examples are "the groom is a legend", "absolute king", "he's
// the GOAT" (party-planner-prompt.ts:1316). It does not ban the nouns wholesale.
//
// So match only the two shapes that aim the word at someone: an intensifier
// ("absolute king") or a copula ("is a legend", "he's the GOAT"). A bare
// article form would fire on correct prose — a live Memphis plan wrote "Derek
// gets to see where the King lived", which is Elvis's actual epithet.
// The fixed tier names are additionally exempted via `exemptPhrases`.
const HONORIFICS: BannedTerm[] = [
  {
    term: 'king/goat/legend as honorific',
    re: /\b(?:absolute|total|complete|straight-up|certified)\s+(?:king|goat|legend)s?\b/gi,
    severity: 'banned',
  },
  {
    term: 'king/goat/legend as honorific',
    re: /(?:\bis|\bare|\bwas|\bwere|'s|'re)\s+(?:an?|the)\s+(?:king|goat|legend)s?\b/gi,
    severity: 'banned',
  },
];

const EMOJI: BannedTerm[] = [
  { term: 'flame emoji', re: /\u{1F525}/gu , severity: 'banned' },
  { term: 'crown emoji', re: /\u{1F451}/gu , severity: 'banned' },
];

interface BrandVoiceRules {
  banned: BannedTerm[];
  /** Literal product labels stripped before matching, so a fixed tier name
   *  can't trip a rule aimed at prose. */
  exemptPhrases: string[];
}

const RULES: Record<BrandId, BrandVoiceRules> = {
  bestman: {
    banned: [...SHARED_BANNED, ...MOH_CODED, ...HONORIFICS, ...EMOJI],
    exemptPhrases: ['Weekend Warrior', 'The Legend', 'The King'],
  },
  moh: {
    banned: [...SHARED_BANNED, ...BESTMAN_CODED],
    exemptPhrases: [],
  },
};

/** Keys whose values are machine identifiers, not prose. A banned word inside
 *  a URL or slug is not a voice violation. */
const NON_PROSE_KEY = /(?:url|href|src|image|photo|slug|id|key|type)$/i;

function isNonProseKey(key: string): boolean {
  return NON_PROSE_KEY.test(key);
}

function collectStrings(node: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof node === 'string') {
    out.push([path, node]);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectStrings(v, `${path}[${i}]`, out));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (isNonProseKey(k)) continue;
      collectStrings(v, path ? `${path}.${k}` : k, out);
    }
  }
}

export function validatePlanVoice(input: VoiceValidationInput): VoiceValidationResult {
  const rules = RULES[input.brandId];
  const strings: Array<[string, string]> = [];
  collectStrings(input.plan, '', strings);

  const violations: VoiceViolation[] = [];
  for (const [path, raw] of strings) {
    let text = raw;
    for (const phrase of rules.exemptPhrases) text = text.split(phrase).join('');

    for (const { term, re, severity } of rules.banned) {
      re.lastIndex = 0;
      const matches = text.match(re);
      if (matches && matches.length > 0) {
        violations.push({ term, severity, path, count: matches.length, sample: raw.slice(0, 200) });
      }
    }
  }

  // `ok` tracks only real brand violations — a cliché is reported but must not
  // fail a generation on its own.
  return { ok: !violations.some((v) => v.severity === 'banned'), violations };
}
