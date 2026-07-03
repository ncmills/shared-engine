// src/popularity.ts
//
// Ported from HHQ src/lib/kv.ts:59-149 (recordDestinationView,
// recordDestinationSelect, getAllPopularityScores) + src/data/query.ts's
// `+10` capped popularity nudge, adapted to take an injected `redis:
// RedisLike` instead of calling a module-level `getRedis()`.
//
// Two simplifications versus the HHQ source, both required by the
// infra-agnostic RedisLike interface (see redis-like.ts) — flagged in the
// task-4 report rather than silently baked in:
//   1. No pipeline/multi batching. HHQ's kv.ts issues all hincrby/expire/hget
//      calls inside `r.pipeline()...exec()`. RedisLike has no pipeline
//      primitive (not every site's client — e.g. Upstash's HTTP client —
//      exposes one the same way), so calls here are sequential awaits
//      instead. Same keys, same values written; just not batched/atomic.
//   2. No "popularity:cache" 5-minute cache layer. HHQ's
//      getAllPopularityScores reads/writes a cached JSON blob via
//      r.get/r.set to avoid a SCAN on every request. RedisLike's get/set are
//      optional (some sites' clients won't have them), so the shared
//      version always recomputes via SCAN + hget. Callers that want the
//      cache can layer it on top.
// The signal key names (`signal:views:${id}` / `signal:selects:${id}`) and
// the selects/views ratio math are byte-for-byte identical to the source.
import type { RedisLike } from "./redis-like";
export type { RedisLike } from "./redis-like";

// Learning signals are aggregate popularity/view counts — recent data
// carries the signal, and stale rows just bloat Redis. Matches HHQ's
// SIGNAL_TTL (30 days) in src/data/query.ts:8.
const SIGNAL_TTL = 60 * 60 * 24 * 30;

/**
 * Record when a destination is shown to a user (impression).
 * Ported from HHQ kv.ts:59-75, dropped the WizardState-keyed region/budget
 * sub-counters (shared-engine has no WizardState type) — only the `total`
 * counter carries over.
 */
export async function recordDestinationView(redis: RedisLike, destinationId: string): Promise<void> {
  const key = `signal:views:${destinationId}`;
  await redis.hincrby(key, "total", 1);
  await redis.expire(key, SIGNAL_TTL);
}

/**
 * Record when a user clicks into a specific destination (selection).
 * Ported from HHQ kv.ts:80-91, dropped the tier-keyed sub-counter for the
 * same reason as recordDestinationView above.
 */
export async function recordDestinationSelect(redis: RedisLike, destinationId: string): Promise<void> {
  const key = `signal:selects:${destinationId}`;
  await redis.hincrby(key, "total", 1);
  await redis.expire(key, SIGNAL_TTL);
}

/**
 * Get popularity scores (select/view ratio) and view counts for all
 * destinations that have signals. Ported from HHQ kv.ts:98-149, minus the
 * cache layer and pipeline batching described above.
 */
export async function getAllPopularityScores(
  redis: RedisLike
): Promise<{ scores: Map<string, number>; viewCounts: Map<string, number> }> {
  const scores = new Map<string, number>();
  const viewCounts = new Map<string, number>();

  const allKeys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "signal:views:*", "COUNT", 100);
    cursor = nextCursor;
    allKeys.push(...keys);
  } while (cursor !== "0");

  if (allKeys.length === 0) return { scores, viewCounts };

  for (const key of allKeys) {
    const destId = key.replace("signal:views:", "");
    const views = parseInt((await redis.hget(key, "total")) || "0");
    const selects = parseInt((await redis.hget(`signal:selects:${destId}`, "total")) || "0");
    if (views > 0) {
      const score = selects / views;
      scores.set(destId, score);
      viewCounts.set(destId, views);
    }
  }

  return { scores, viewCounts };
}

/**
 * Capped ranking nudge, matching the `+10` bonus HHQ's query.ts applies
 * during destination scoring (score += Math.min(rawScore, cap)).
 */
export function popularityBonus(scores: Map<string, number>, destinationId: string, cap = 10): number {
  const raw = scores.get(destinationId);
  if (!raw || raw <= 0) return 0;
  return Math.min(raw, cap);
}
