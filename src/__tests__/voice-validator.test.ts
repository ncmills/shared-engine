import { describe, it, expect } from 'vitest';
import { validatePlanVoice } from '../voice-validator';

// The production regression this exists to catch (2026-07-31 editorial audit):
// MOH generated `welcomeKit.optional[0] = "Monogrammed tote bags with
// 'Marisa's Crew' or an inside joke"`. `crew` is banned in MOH's BRAND.md and
// banned twice in MOH's own prompt — the model ignored it, and nothing on the
// output side could catch it.
describe('validatePlanVoice — the leak it was built for', () => {
  it('flags a BestMan-coded term in an MOH plan', () => {
    const plan = {
      welcomeKit: { optional: ["Monogrammed tote bags with 'Marisa's Crew' or an inside joke"] },
    };
    const result = validatePlanVoice({ plan, brandId: 'moh' });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.term).toBe('crew');
    expect(result.violations[0]!.path).toBe('welcomeKit.optional[0]');
  });

  it('reports the offending sentence so the violation is actionable', () => {
    const plan = { a: { b: ["Marisa's Crew rolls out at 8"] } };
    const result = validatePlanVoice({ plan, brandId: 'moh' });
    expect(result.violations[0]!.sample).toContain("Marisa's Crew");
  });
});

describe('validatePlanVoice — false positives that would make it useless', () => {
  // Cost a real cycle during the audit: /\bsend[- ]it\b/ matches the ordinary
  // verb phrase, not the BestMan slang interjection.
  it('does not flag "send it to X" as the banned "send-it"', () => {
    const plan = { postTripChecklist: ['Create a shared album and send it to Jess as a keepsake'] };
    const result = validatePlanVoice({ plan, brandId: 'moh' });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // Documented trap: a `stag` substring match hits "staggered arrivals".
  it('does not flag "staggered" as the banned "stag"', () => {
    const plan = { logistics: ['Staggered arrivals across Friday afternoon'] };
    const result = validatePlanVoice({ plan, brandId: 'moh' });
    expect(result.violations).toEqual([]);
  });

  // party-planner-prompt.ts:1316 — fixed product labels, not honorifics.
  it('does not flag BestMan tier labels as banned honorifics', () => {
    const plan = { tierName: 'The Legend', tripName: "Derek's Nashville Takeover" };
    const result = validatePlanVoice({ plan, brandId: 'bestman' });
    expect(result.violations).toEqual([]);
  });

  // Real false positive from a live BM Memphis plan (2026-07-31): "Derek gets
  // to see where the King lived" — Elvis's actual epithet, correct prose. The
  // ban is on calling PEOPLE king/goat/legend, not on the noun existing.
  it('does not flag "the King" used as a factual epithet', () => {
    const plan = {
      schedule: [{ items: [{ detail: 'Derek gets to see where the King lived, and the crew gets a shared experience.' }] }],
    };
    const result = validatePlanVoice({ plan, brandId: 'bestman' });
    expect(result.violations).toEqual([]);
  });

  it('still flags king/goat/legend aimed at a person', () => {
    for (const line of ['Derek is an absolute king', "he's the GOAT of the group", 'the groom is a legend']) {
      const result = validatePlanVoice({ plan: { s: line }, brandId: 'bestman' });
      expect(result.ok, line).toBe(false);
    }
  });

  it('does not scan urls, ids or slugs', () => {
    const plan = {
      sourceUrl: 'https://example.com/crew-house',
      destinationId: 'crew-city-tn',
      slug: 'the-crew-tour',
    };
    const result = validatePlanVoice({ plan, brandId: 'moh' });
    expect(result.violations).toEqual([]);
  });
});

describe('validatePlanVoice — brands ban different things', () => {
  it('allows "crew" on BestMan, where it is the house audience term', () => {
    const plan = { tagline: 'Three days with the crew' };
    const result = validatePlanVoice({ plan, brandId: 'bestman' });
    expect(result.ok).toBe(true);
  });

  it('flags bachelorette-coded terms leaking into a BestMan plan', () => {
    const plan = { tagline: 'A weekend the bridesmaids will remember' };
    const result = validatePlanVoice({ plan, brandId: 'bestman' });
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.term).toBe('bridesmaid');
  });

  it('flags research-red-flag adjectives on both brands', () => {
    for (const brandId of ['bestman', 'moh'] as const) {
      const result = validatePlanVoice({ plan: { s: 'A world-class steakhouse' }, brandId });
      expect(result.ok, brandId).toBe(false);
      expect(result.violations[0]!.term, brandId).toBe('world-class');
    }
  });
});

// A caller needs to tell "this brand explicitly forbids this word" from "this
// is generic AI slop" — the first justifies a retry, the second a log line.
describe('validatePlanVoice — severity', () => {
  it('marks a BRAND.md-banned term as "banned"', () => {
    const result = validatePlanVoice({ plan: { s: "Marisa's Crew" }, brandId: 'moh' });
    expect(result.violations[0]!.severity).toBe('banned');
  });

  it('marks a house-style cliché as "cliche"', () => {
    const result = validatePlanVoice({ plan: { s: 'something for everyone' }, brandId: 'moh' });
    expect(result.violations[0]!.severity).toBe('cliche');
  });

  it('ok reflects only banned terms, not clichés', () => {
    const cliche = validatePlanVoice({ plan: { s: 'something for everyone' }, brandId: 'moh' });
    expect(cliche.ok).toBe(true);
    expect(cliche.violations).toHaveLength(1);

    const banned = validatePlanVoice({ plan: { s: 'the squad' }, brandId: 'moh' });
    expect(banned.ok).toBe(false);
  });
});

describe('validatePlanVoice — shape', () => {
  it('is clean on an empty plan', () => {
    expect(validatePlanVoice({ plan: {}, brandId: 'moh' })).toEqual({ ok: true, violations: [] });
  });

  it('walks nested arrays and objects', () => {
    const plan = { schedule: [{ items: [{ detail: 'Meet the squad at noon' }] }] };
    const result = validatePlanVoice({ plan, brandId: 'moh' });
    expect(result.violations[0]!.path).toBe('schedule[0].items[0].detail');
    expect(result.violations[0]!.term).toBe('squad');
  });

  it('counts each distinct occurrence once per string', () => {
    const plan = { a: 'The crew and the crew again' };
    const result = validatePlanVoice({ plan, brandId: 'moh' });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.count).toBe(2);
  });

  it('does not throw on null, numbers or undefined fields', () => {
    const plan = { a: null, b: 42, c: undefined, d: 'clean text' };
    expect(() => validatePlanVoice({ plan, brandId: 'moh' })).not.toThrow();
  });
});
