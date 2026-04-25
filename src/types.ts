export type BrandId = 'bestman' | 'moh';

export type BudgetTier =
  | 'under-500'
  | '500-1000'
  | '1000-1500'
  | '1500-2000'
  | '2000-plus'
  | 'no-limit';

export type ActivityIntensityBestman = 'chill' | 'moderate' | 'send-it';
export type ActivityIntensityMoh = 'chill' | 'balanced' | 'unhinged';
export type ActivityIntensity = ActivityIntensityBestman | ActivityIntensityMoh;

export type ConsultedLevel = 'yes' | 'sort-of' | 'not-yet';

export interface PriceTargets {
  weekendWarrior: string;
  theLegend: string;
  theKing: string;
}

export interface PricingLodging {
  pricePerNight: readonly [number, number];
  perRoom?: boolean;
}

export interface PricingPriceBand {
  priceRange: string;
}

export interface PricingActivity {
  pricePerPerson: readonly [number, number];
}

export interface PricingTransport {
  type: string;
  priceRange: string;
}

export interface PricingDestination {
  lodging: readonly PricingLodging[];
  nightlife: readonly PricingPriceBand[];
  dining: readonly PricingPriceBand[];
  activities: readonly PricingActivity[];
  transport: readonly PricingTransport[];
}

export interface BrandEventProps {
  brand: BrandId;
  city?: string;
  budgetBand?: string;
  groupSizeBand?: string;
  source?: string;
  planId?: string;
  step?: string;
  [key: string]: unknown;
}

// ── Hero Moment + Atlas Grounding (atlas-first rebrand 2026-04-25) ──
// Every plan tier produced by the wizard now carries a `heroMoment` — a
// single named, specific, non-generic beat that encodes the editorial DNA
// of the curated atlases (`/unhinged` on BMHQ, `/feral` on MOHHQ). Replaces
// the old "INSANE MODE / Feral Mode" tier as a separate concept; the
// quality bar is now baseline across every tier.
//
// Phase 0 ships the type only. Phase 1 wires the validator. Phase 2 wires
// retrieval that may set `sourceAtlasId`.
export interface HeroMoment {
  /** <= 80 chars, named, specific. "Capt. Nick at midnight, 1500ft, broadbills". */
  title: string;
  /** 1-3 sentences of color. */
  description: string;
  /** Named operator when present (e.g. "Garrison Brothers", "Stanczyk Charters"). */
  namedOperator?: string;
  /** Specific season window (e.g. "September rut", "midnight broadbill window"). */
  season?: string;
  /** Set by retrieval when this tier was adapted from an atlas entry. */
  sourceAtlasId?: string;
}

/**
 * Confidence in the atlas grounding for a generated plan tier.
 *  - "exact"   — atlas entry hit on regionKey + budget + season
 *  - "region"  — same region but softer match on budget/season/group
 *  - "nearest" — adjacent region used as inspiration
 *  - "none"    — no atlas hit; tier was free-generated with hero-moment enforced
 */
export type GroundingConfidence = "exact" | "region" | "nearest" | "none";
