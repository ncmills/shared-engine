// src/popularity.ts
//
// Ported from HHQ src/lib/kv.ts:59-155 (recordDestinationView,
// recordDestinationSelect, getAllPopularityScores) + src/data/query.ts's
// `+10` capped popularity nudge, adapted to take an injected `redis:
// RedisLike` instead of calling a module-level `getRedis()`.
//
// This is a LOSSLESS superset of the HHQ source: same signal keys
// (`signal:views:${id}` / `signal:selects:${id}`), same sub-counters
// (`total`, `region:*`, `budget:*`, `tier:*`), same 5-minute
// `popularity:cache` read-through, and byte-for-byte identical
// selects/views ratio math. Two adaptations, both required by the
// infra-agnostic RedisLike interface (see redis-like.ts) and neither of
// which drops data or changes the values written/read:
//   1. No pipeline/multi batching. HHQ's kv.ts issues all hincrby/expire/hget
//      calls inside `r.pipeline()...exec()`. RedisLike has no pipeline
//      primitive (not every site's client — e.g. Upstash's HTTP client —
//      exposes one the same way), so calls here are sequential awaits
//      instead. Same keys, same values written; just not batched/atomic.
//   2. Breakdown inputs are a plain `{ region?, budget?, tier? }` object
//      instead of HHQ's `WizardState` — shared-engine has no WizardState
//      type and stays brand-generic. Optional, so callers with no
//      breakdown data still get the lossless `total` counter.
import type { RedisLike } from "./redis-like";
export type { RedisLike } from "./redis-like";

// Learning signals are aggregate popularity/view counts — recent data
// carries the signal, and stale rows just bloat Redis. Matches HHQ's
// SIGNAL_TTL (kv.ts:8): 60 * 60 * 24 * 30 = 30 days.
const SIGNAL_TTL = 60 * 60 * 24 * 30; // 30 days for learning signals

/** Optional per-view breakdown dimensions, brand-generic (no WizardState). */
export interface ViewBreakdown {
  region?: string;
  budget?: string;
}

/** Optional per-select breakdown dimension, brand-generic (no WizardState). */
export interface SelectBreakdown {
  tier?: string;
}

/**
 * Record when a destination is shown to a user (impression).
 * Ported from HHQ kv.ts:59-75. Always increments `total`; increments
 * `region:*` / `budget:*` sub-counters when the corresponding breakdown
 * field is supplied.
 */
export async function recordDestinationView(
  redis: RedisLike,
  destinationId: string,
  breakdown?: ViewBreakdown
): Promise<void> {
  const key = `signal:views:${destinationId}`;
  await redis.hincrby(key, "total", 1);
  if (breakdown?.region) {
    await redis.hincrby(key, `region:${breakdown.region}`, 1);
  }
  if (breakdown?.budget) {
    await redis.hincrby(key, `budget:${breakdown.budget}`, 1);
  }
  await redis.expire(key, SIGNAL_TTL);
}

/**
 * Record when a user clicks into a specific destination (selection).
 * Ported from HHQ kv.ts:80-91. Always increments `total`; increments
 * `tier:*` sub-counter when the breakdown field is supplied.
 */
export async function recordDestinationSelect(
  redis: RedisLike,
  destinationId: string,
  breakdown?: SelectBreakdown
): Promise<void> {
  const key = `signal:selects:${destinationId}`;
  await redis.hincrby(key, "total", 1);
  if (breakdown?.tier) {
    await redis.hincrby(key, `tier:${breakdown.tier}`, 1);
  }
  await redis.expire(key, SIGNAL_TTL);
}

const CACHE_KEY = "popularity:cache";
const CACHE_TTL = 300; // 5 min, matches HHQ kv.ts:104

/**
 * Get popularity scores (select/view ratio) and view counts for all
 * destinations that have signals. Ported from HHQ kv.ts:98-155, including
 * the 5-minute `popularity:cache` read-through (cache hit skips SCAN
 * entirely; cache miss rebuilds via SCAN + sequential hget, then writes the
 * cache back non-blocking).
 */
export async function getAllPopularityScores(
  redis: RedisLike
): Promise<{ scores: Map<string, number>; viewCounts: Map<string, number> }> {
  const scores = new Map<string, number>();
  const viewCounts = new Map<string, number>();

  // Try cached version first.
  const cached = await redis.get(CACHE_KEY);
  if (cached) {
    const parsed: { destId: string; score: number; views: number }[] = JSON.parse(cached);
    for (const entry of parsed) {
      scores.set(entry.destId, entry.score);
      viewCounts.set(entry.destId, entry.views);
    }
    return { scores, viewCounts };
  }

  // Cache miss — rebuild from SCAN (runs at most once every 5 min).
  const allKeys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "signal:views:*", "COUNT", 100);
    cursor = nextCursor;
    allKeys.push(...keys);
  } while (cursor !== "0");

  if (allKeys.length === 0) return { scores, viewCounts };

  // Sequential hget calls (no pipeline — see file-header note).
  const cacheEntries: { destId: string; score: number; views: number }[] = [];
  for (const key of allKeys) {
    const destId = key.replace("signal:views:", "");
    const views = parseInt((await redis.hget(key, "total")) || "0");
    const selects = parseInt((await redis.hget(`signal:selects:${destId}`, "total")) || "0");
    if (views > 0) {
      const score = selects / views;
      scores.set(destId, score);
      viewCounts.set(destId, views);
      cacheEntries.push({ destId, score, views });
    }
  }

  // Cache the results (non-blocking).
  redis.set(CACHE_KEY, JSON.stringify(cacheEntries), "EX", CACHE_TTL).catch(() => {});

  return { scores, viewCounts };
}

/**
 * Capped ranking nudge. NOTE: this is a simplified nudge, NOT HHQ's actual
 * ranking bonus. HHQ's real formula (handicap-hq/src/data/query.ts) is
 * `viewCount >= 10 ? Math.min(Math.round(popularity * 10), 10) : 0` — it gates
 * on a 10-impression minimum and scales the 0..1 ratio by 10. This helper omits
 * both. Reconcile this formula against query.ts when wiring popularity into
 * ranking in WS2/WS3 before relying on the magnitude.
 */
export function popularityBonus(scores: Map<string, number>, destinationId: string, cap = 10): number {
  const raw = scores.get(destinationId);
  if (!raw || raw <= 0) return 0;
  return Math.min(raw, cap);
}
