import type { BrandId } from './types';
import {
  priorsForBrand,
  type FieldPrior,
  type WeightedChoice,
} from './priors';

export interface SurpriseResult {
  value: unknown;
  confidence: number;
  source: 'prior' | 'default';
}

export interface SurpriseContext {
  brand: BrandId;
  currentState?: Record<string, unknown>;
}

function pickWeighted<T>(choices: WeightedChoice<T>[]): {
  value: T;
  weight: number;
  total: number;
} {
  const total = choices.reduce((s, c) => s + c.weight, 0);
  if (total <= 0 || choices.length === 0) {
    return { value: choices[0]!.value, weight: 0, total: 0 };
  }
  let roll = Math.random() * total;
  for (const c of choices) {
    roll -= c.weight;
    if (roll <= 0) return { value: c.value, weight: c.weight, total };
  }
  const last = choices[choices.length - 1]!;
  return { value: last.value, weight: last.weight, total };
}

function pickMulti<T>(
  choices: WeightedChoice<T>[],
  minPick: number,
  maxPick: number
): { values: T[]; avgWeightShare: number; total: number } {
  // If fewer choices available than the minimum, pick all remaining.
  const effectiveMin = Math.min(minPick, choices.length);
  const effectiveMax = Math.min(maxPick, choices.length);
  const count = Math.max(effectiveMin, Math.min(effectiveMax, Math.floor(effectiveMin + Math.random() * (effectiveMax - effectiveMin + 1))));
  const remaining = [...choices];
  const total = choices.reduce((s, c) => s + c.weight, 0);
  const picked: T[] = [];
  const pickedWeights: number[] = [];
  for (let i = 0; i < count && remaining.length > 0; i++) {
    const sub = pickWeighted(remaining);
    picked.push(sub.value);
    pickedWeights.push(sub.weight);
    const idx = remaining.findIndex((c) => c.value === sub.value);
    if (idx >= 0) remaining.splice(idx, 1);
  }
  const avg = pickedWeights.length
    ? pickedWeights.reduce((s, w) => s + w, 0) / pickedWeights.length
    : 0;
  return { values: picked, avgWeightShare: total > 0 ? avg / total : 0, total };
}

export function surpriseField(
  field: string,
  ctx: SurpriseContext
): SurpriseResult {
  const priors = priorsForBrand(ctx.brand);
  const prior: FieldPrior | undefined = priors[field];
  if (!prior) {
    return { value: null, confidence: 0, source: 'default' };
  }

  switch (prior.kind) {
    case 'single-enum': {
      const pick = pickWeighted(prior.choices);
      return {
        value: pick.value,
        confidence: pick.total > 0 ? pick.weight / pick.total : 0,
        source: 'prior',
      };
    }
    case 'multi-enum': {
      const r = pickMulti(prior.choices, prior.pickCount[0], prior.pickCount[1]);
      return { value: r.values, confidence: r.avgWeightShare, source: 'prior' };
    }
    case 'boolean': {
      const pick = pickWeighted(prior.choices);
      return {
        value: pick.value,
        confidence: pick.total > 0 ? pick.weight / pick.total : 0,
        source: 'prior',
      };
    }
    case 'number': {
      const pick = pickWeighted(prior.choices);
      return {
        value: pick.value,
        confidence: pick.total > 0 ? pick.weight / pick.total : 0,
        source: 'prior',
      };
    }
    case 'string-suggestions': {
      const pick = pickWeighted(prior.choices);
      return {
        value: pick.value,
        confidence: pick.total > 0 ? pick.weight / pick.total : 0,
        source: 'prior',
      };
    }
    default: {
      const _never: never = prior;
      return { value: null, confidence: 0, source: 'default' };
    }
  }
}

export function surpriseAllFields(
  fields: string[],
  ctx: SurpriseContext
): Record<string, SurpriseResult> {
  const out: Record<string, SurpriseResult> = {};
  for (const f of fields) out[f] = surpriseField(f, ctx);
  return out;
}

export function listSurpriseableFields(brand: BrandId): string[] {
  return Object.keys(priorsForBrand(brand));
}
