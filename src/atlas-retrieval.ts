/**
 * Atlas retrieval engine.
 *
 * Each consumer site (`plan-my-party` /unhinged, `maid-of-honor-hq` /feral)
 * owns its own brand-shaped atlas data file. This module operates on a
 * brand-neutral `AtlasEntry` interface; consumers project their branded
 * type into it via per-repo adapters at `src/lib/atlas-adapter.ts`.
 *
 * Dependency direction is one-way: consumers import from shared-engine,
 * never the reverse. Brand-specific budget enums and category vocabularies
 * stay in the consumer repos. Voice/prose stays per-repo too — the prompt
 * grounding block is authored twice (once per `party-planner-prompt.ts`),
 * never centralized here.
 *
 * v1 is rule-based with a weighted-sum scorer + diversity-aware topK.
 * Embeddings are deferred to v2; flip when retrieval misses are observable
 * in production logs at >10% of plans (the canary for atlas depth).
 *
 * See ~/.claude/plans/here-is-a-prompt-concurrent-gizmo.md, Phase 2.
 */

import type { GroundingConfidence } from "./types";

/**
 * Brand-neutral normalized atlas entry. Consumers project their branded
 * UnhingedTrip / FeralTrip into this shape via per-repo adapters.
 */
export interface AtlasEntry {
  id: string;
  slug: string;
  title: string;
  destination: string;
  regionKey: string;
  /** Months when this entry is in season (1..12). Empty = year-round. */
  season: number[];
  nights: number;
  minGroup: number;
  maxGroup: number;
  /** Normalized 1..4 from each brand's budget enum. 1 = cheapest. */
  budgetBucket: 1 | 2 | 3 | 4;
  estPerPerson: [number, number];
  /**
   * Brand-specific category mapped to vibe-style tags (e.g.
   * "outdoors", "wilderness", "editorial-stay", "vineyard"). Used for
   * Jaccard similarity against wizard `vibeTags`.
   */
  categoryTags: string[];
  /** Trimmed narrative excerpt — full prose stays in the repo data file. */
  narrative: string;
  /** Optional named operator/lodge/captain hinted from the entry. */
  namedOperators?: string[];
}

/**
 * Wizard inputs projected into a retrieval query. Consumers build this
 * from WizardState in their generate-plan route, then pass `topK` results
 * to `buildUserMessage` as the `groundingHits` argument.
 */
export interface RetrievalQuery {
  destination?: string;
  regionKey?: string;
  /** Current trip month, 1..12. Optional — if absent, season scoring is skipped. */
  monthIndex?: number;
  groupSize: number;
  /** Engine tier id; mapped to a budget bucket inside `scoreAtlas`. */
  tier: "weekendWarrior" | "theLegend" | "theKing";
  /** Wizard vibe tags (brand-specific vocabulary; matched as Jaccard set overlap). */
  vibeTags: string[];
  /**
   * Personalization hints derived from non-geo wizard inputs (groomType,
   * bridePersonality, hobbies, selected activities). Adapter-projected into
   * the same vocabulary as `entry.categoryTags`. Scored as Jaccard overlap
   * but does NOT contribute to geoSignal — confidence still gates on geo.
   */
  categoryHints?: string[];
}

export interface RetrievalHit {
  entry: AtlasEntry;
  score: number;
  /** Per-rule contributions for debug/log. */
  reasons: string[];
  confidence: GroundingConfidence;
}

const TIER_TO_BUCKET_RANGE: Record<RetrievalQuery["tier"], [number, number]> = {
  weekendWarrior: [1, 2],
  theLegend: [2, 3],
  theKing: [3, 4],
};

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Score every atlas entry against the query. Returns hits sorted by
 * descending score (caller then runs `topK` for diversity-aware trim).
 *
 * Scoring (weighted sum):
 *  - regionKey exact match              +50
 *  - destination token overlap          +30 max (Jaccard scaled)
 *  - season fit (monthIndex ∈ season)   +15
 *  - groupSize within [min, max]        +10  (partial ±2: +5)
 *  - tier↔budgetBucket alignment        +10  (adjacent: +5)
 *  - vibeTags ∩ categoryTags Jaccard    +20 max
 *  - categoryHints ∩ categoryTags Jacc. +15 max (non-geo personalization)
 *
 * Confidence thresholds:
 *  - score ≥ 50 → "exact"
 *  - 25..49     → "region"
 *  - 10..24     → "nearest"
 *  - < 10       → "none"
 */
export function scoreAtlas(query: RetrievalQuery, atlas: AtlasEntry[]): RetrievalHit[] {
  const queryDestTokens = query.destination ? tokenize(query.destination) : null;
  const queryVibeSet = new Set(query.vibeTags.map((t) => t.toLowerCase()));
  const [tierBucketLo, tierBucketHi] = TIER_TO_BUCKET_RANGE[query.tier];

  const hits: RetrievalHit[] = [];
  for (const entry of atlas) {
    let score = 0;
    let geoSignal = 0;
    const reasons: string[] = [];

    if (query.regionKey && entry.regionKey === query.regionKey) {
      score += 50;
      geoSignal += 50;
      reasons.push(`regionKey=${entry.regionKey} (+50)`);
    }

    if (queryDestTokens) {
      const entryDestTokens = tokenize(entry.destination);
      const sim = jaccard(queryDestTokens, entryDestTokens);
      if (sim > 0) {
        const add = Math.round(sim * 30);
        score += add;
        geoSignal += add;
        reasons.push(`dest-overlap=${sim.toFixed(2)} (+${add})`);
      }
    }

    if (query.monthIndex && entry.season.length > 0 && entry.season.includes(query.monthIndex)) {
      score += 15;
      reasons.push(`season-fit=${query.monthIndex} (+15)`);
    }

    if (query.groupSize >= entry.minGroup && query.groupSize <= entry.maxGroup) {
      score += 10;
      reasons.push(`group-fit (+10)`);
    } else if (
      query.groupSize >= entry.minGroup - 2 &&
      query.groupSize <= entry.maxGroup + 2
    ) {
      score += 5;
      reasons.push(`group-near (+5)`);
    }

    if (entry.budgetBucket >= tierBucketLo && entry.budgetBucket <= tierBucketHi) {
      score += 10;
      reasons.push(`tier-aligned bucket=${entry.budgetBucket} (+10)`);
    } else if (
      Math.abs(entry.budgetBucket - tierBucketLo) <= 1 ||
      Math.abs(entry.budgetBucket - tierBucketHi) <= 1
    ) {
      score += 5;
      reasons.push(`tier-near bucket=${entry.budgetBucket} (+5)`);
    }

    const entryVibeSet = new Set(entry.categoryTags.map((t) => t.toLowerCase()));
    const vibeSim = jaccard(queryVibeSet, entryVibeSet);
    if (vibeSim > 0) {
      const add = Math.round(vibeSim * 20);
      score += add;
      reasons.push(`vibe-overlap=${vibeSim.toFixed(2)} (+${add})`);
    }

    // Personalization hints (groomType / bridePersonality / hobbies /
    // activities → atlas categoryTags vocabulary). Non-geo signal, so it
    // contributes to score and ordering but never to geoSignal/confidence.
    if (query.categoryHints && query.categoryHints.length > 0) {
      const hintSet = new Set(query.categoryHints.map((t) => t.toLowerCase()));
      const hintSim = jaccard(hintSet, entryVibeSet);
      if (hintSim > 0) {
        const add = Math.round(hintSim * 15);
        score += add;
        reasons.push(`category-hints=${hintSim.toFixed(2)} (+${add})`);
      }
    }

    // Confidence is gated on geographic signal, not raw score. A perfect
    // tier-and-group-fit against an entry on the other side of the country
    // should never claim "nearest" — that misleads the prompt grounder.
    // Without geo signal, confidence collapses to "none" regardless of
    // how well other signals align; the score stays informative for
    // sort/diversity but the prompt-side path uses confidence to decide
    // grounding vs tone-reference-only.
    let confidence: GroundingConfidence;
    if (geoSignal === 0) {
      confidence = "none";
    } else if (score >= 50) {
      confidence = "exact";
    } else if (score >= 25) {
      confidence = "region";
    } else if (score >= 10) {
      confidence = "nearest";
    } else {
      confidence = "none";
    }

    hits.push({ entry, score, reasons, confidence });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/**
 * Pick top K hits with two diversity guards:
 *  1. Destination-level dedup: drop a hit if its `entry.destination` exactly
 *     matches an already-picked hit. Prevents two trips to the same town
 *     with different category framings (e.g. two Marfa entries).
 *  2. Region+category overlap: drop a hit if it shares regionKey AND
 *     categoryTags overlap >= 50% with an already-picked hit. Prevents
 *     three nearly-identical Hill Country boar trips outranking a single
 *     boar + a Bonneville + an Apalachicola.
 *
 * Hits below 10 (confidence "none") are filtered out — caller handles
 * the no-match path separately via `nearestRegion` + free-generation.
 */
export function topK(hits: RetrievalHit[], k: number): RetrievalHit[] {
  const out: RetrievalHit[] = [];
  for (const hit of hits) {
    if (hit.score < 10) break; // hits is sorted desc; bail early
    const sameDestination = out.some(
      (picked) => picked.entry.destination === hit.entry.destination,
    );
    if (sameDestination) continue;
    const dup = out.some((picked) => {
      if (picked.entry.regionKey !== hit.entry.regionKey) return false;
      const a = new Set(hit.entry.categoryTags.map((t) => t.toLowerCase()));
      const b = new Set(picked.entry.categoryTags.map((t) => t.toLowerCase()));
      return jaccard(a, b) >= 0.5;
    });
    if (dup) continue;
    out.push(hit);
    if (out.length >= k) break;
  }
  return out;
}

/**
 * Find the atlas entry whose regionKey is closest to a queried (city,
 * regionKey) pair when no proper hit exists. v1: simple regionKey token
 * overlap fallback, then destination token overlap. Used for the
 * editorial-tone-reference path when retrieval returns confidence "none".
 *
 * Returns null only when the atlas is empty.
 */
export function nearestRegion(
  query: { destination?: string; regionKey?: string },
  atlas: AtlasEntry[],
): AtlasEntry | null {
  if (atlas.length === 0) return null;
  if (!query.destination && !query.regionKey) return atlas[0] ?? null;

  const queryRegionTokens = query.regionKey ? tokenize(query.regionKey) : null;
  const queryDestTokens = query.destination ? tokenize(query.destination) : null;

  let best: AtlasEntry = atlas[0]!;
  let bestScore = -1;
  for (const entry of atlas) {
    let s = 0;
    if (queryRegionTokens) s += jaccard(queryRegionTokens, tokenize(entry.regionKey)) * 2;
    if (queryDestTokens) s += jaccard(queryDestTokens, tokenize(entry.destination));
    if (s > bestScore) {
      bestScore = s;
      best = entry;
    }
  }
  return best;
}
