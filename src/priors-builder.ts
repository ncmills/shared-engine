/**
 * priors-builder.ts
 *
 * Shared tally engine for Surprise Me prior overlays. Reads wizard field
 * values from TWO sources and UNIONS their counts:
 *
 *   1. Redis plans at key pattern `plan:*` (last ~90 days, Redis TTL).
 *   2. Supabase `wp_plan_inputs` rows (permanent signal retention, filtered
 *      to the last N days and the project brand).
 *
 * Produces a `{ [field]: FieldPrior }`-shaped overlay compatible with
 * `shared-engine.registerPriorOverlay`. Ported from plan-my-party's
 * `src/lib/priors-builder.ts` (see task-5-report.md for the DI adaptations):
 * the Supabase client and the Redis handle are now injected per-call
 * (`opts.supabase` / `opts.redis`) instead of constructed internally from
 * env vars, and `brand` / `fields` come from the caller instead of being
 * hardcoded per-site constants. The tallying + minSamples/minBucket gating
 * math below is unchanged from the source.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Brand } from "./signals";
import { resolveSignalTableName } from "./signals";
import type { RedisLike } from "./redis-like";

export type Tally = Record<string, number>;
export type Overlay = Record<string, unknown>;

export interface BuildPriorsOptions {
  brand: Brand;
  fields: string[];
  supabase: SupabaseClient | null;
  redis?: RedisLike | null;
  minSamples?: number;
  minBucket?: number;
  sinceDays?: number;
}

export interface BuildPriorsResult {
  overlay: Overlay;
  sampleCount: number;
  // Extra fidelity beyond the task-5 brief's minimal interface, preserved
  // from the source's richer BuildPriorsResult (redisPlans/supabasePlans/
  // fieldStats/skipped) — see task-5-report.md "concerns". Additive only;
  // does not change the required shape `{ overlay, sampleCount }`.
  redisPlans: number;
  supabasePlans: number;
  fieldStats: Array<{ field: string; buckets: number; samples: number }>;
  skipped: Array<{ field: string; samples: number }>;
}

const DEFAULT_MIN_SAMPLES = 20;
const DEFAULT_MIN_BUCKET = 3;
const DEFAULT_SINCE_DAYS = 90;
const REDIS_PLAN_KEY_PATTERN = "plan:*";

function initTally(fields: readonly string[]): Map<string, Tally> {
  const m = new Map<string, Tally>();
  for (const f of fields) m.set(f, {});
  return m;
}

function accumulate(inputs: Record<string, unknown>, fields: readonly string[], counts: Map<string, Tally>) {
  for (const field of fields) {
    const v = inputs[field];
    const tally = counts.get(field)!;
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item == null) continue;
        const key = String(item);
        tally[key] = (tally[key] ?? 0) + 1;
      }
    } else if (typeof v === "boolean") {
      const key = String(v);
      tally[key] = (tally[key] ?? 0) + 1;
    } else if (typeof v === "number") {
      const key = String(v);
      tally[key] = (tally[key] ?? 0) + 1;
    } else if (typeof v === "string" && v.trim().length > 0) {
      const key = v.trim();
      tally[key] = (tally[key] ?? 0) + 1;
    }
  }
}

/**
 * Scan the injected redis handle for `plan:*` keys and union their field
 * values into `counts`. Adapted from the source's `scanRedisPlans`, which
 * used ioredis's `scanStream` + a client-level `keyPrefix` option (both
 * ioredis-specific, not part of the DI'd `RedisLike` surface). Here we drive
 * the cursor loop explicitly via `RedisLike.scan` and batch-read with the
 * newly added `RedisLike.mget`. Any site-specific key prefixing is expected
 * to be handled inside the caller's `RedisLike` implementation, same as
 * every other shared-engine consumer of `RedisLike`.
 */
async function scanRedisPlans(
  redis: RedisLike,
  fields: readonly string[],
  counts: Map<string, Tally>,
): Promise<number> {
  let planCount = 0;
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", REDIS_PLAN_KEY_PATTERN, "COUNT", 200);
    cursor = nextCursor;
    if (keys.length === 0) continue;
    const values = await redis.mget(...keys);
    for (const raw of values) {
      if (!raw) continue;
      let plan: { inputs?: Record<string, unknown> } | null = null;
      try {
        plan = JSON.parse(raw) as { inputs?: Record<string, unknown> };
      } catch {
        continue;
      }
      const inputs = plan?.inputs;
      if (!inputs) continue;
      planCount++;
      accumulate(inputs, fields, counts);
    }
  } while (cursor !== "0");
  return planCount;
}

/**
 * Scan the injected Supabase client for `wp_plan_inputs` rows and union
 * their field values into `counts`. Returns 0 when `supabase` is null.
 */
async function scanSupabasePlanInputs(
  supabase: SupabaseClient | null,
  brand: Brand,
  sinceDays: number,
  fields: readonly string[],
  counts: Map<string, Tally>,
): Promise<number> {
  if (!supabase) return 0;
  const sinceIso = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const table = resolveSignalTableName("plan_inputs");

  // Paginate in case there are >1000 rows.
  const pageSize = 1000;
  let from = 0;
  let total = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select("payload")
      .eq("brand", brand)
      .gte("created_at", sinceIso)
      .range(from, from + pageSize - 1);
    if (error) {
      console.warn("[priors-builder] supabase plan_inputs error:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    for (const row of data as Array<{ payload: unknown }>) {
      const payload = row.payload as { wizardState?: Record<string, unknown> } | null;
      const wizardState = payload?.wizardState;
      if (!wizardState || typeof wizardState !== "object") continue;
      total++;
      accumulate(wizardState, fields, counts);
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return total;
}

function guessKind(values: string[]): "single-enum" | "multi-enum" | "boolean" | "number" {
  if (values.length > 0 && values.every((v) => v === "true" || v === "false")) return "boolean";
  if (values.length > 0 && values.every((v) => /^-?\d+(\.\d+)?$/.test(v))) return "number";
  return "single-enum";
}

function coerce(s: string, kind: "single-enum" | "multi-enum" | "boolean" | "number"): unknown {
  if (kind === "boolean") return s === "true";
  if (kind === "number") return Number(s);
  return s;
}

/**
 * Build the overlay by UNIONing Redis plan inputs + Supabase plan_inputs
 * tallies. Either source can be missing (null `redis` / `supabase`) — we
 * soft-fail and skip that source rather than throwing.
 */
export async function buildPriorsOverlay(opts: BuildPriorsOptions): Promise<BuildPriorsResult> {
  const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
  const minBucket = opts.minBucket ?? DEFAULT_MIN_BUCKET;
  const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
  const fields = opts.fields;

  const counts = initTally(fields);

  let redisPlans = 0;
  if (opts.redis) {
    try {
      redisPlans = await scanRedisPlans(opts.redis, fields, counts);
    } catch (err) {
      console.warn("[priors-builder] redis scan failed:", err);
    }
  }

  let supabasePlans = 0;
  if (opts.supabase) {
    try {
      supabasePlans = await scanSupabasePlanInputs(opts.supabase, opts.brand, sinceDays, fields, counts);
    } catch (err) {
      console.warn("[priors-builder] supabase scan failed:", err);
    }
  }

  const overlay: Overlay = {};
  const fieldStats: BuildPriorsResult["fieldStats"] = [];
  const skipped: BuildPriorsResult["skipped"] = [];

  for (const [field, tally] of counts) {
    const total = Object.values(tally).reduce((s, n) => s + n, 0);
    if (total < minSamples) {
      skipped.push({ field, samples: total });
      continue;
    }
    const entries = Object.entries(tally)
      .filter(([, n]) => n >= minBucket)
      .sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) continue;

    const kind = guessKind(entries.map(([v]) => v));
    const choices = entries.map(([value, weight]) => ({ value: coerce(value, kind), weight }));
    const prior =
      kind === "multi-enum"
        ? { kind: "multi-enum", pickCount: [1, 3], choices }
        : kind === "boolean"
        ? { kind: "boolean", choices }
        : kind === "number"
        ? { kind: "number", choices }
        : { kind: "single-enum", choices };
    overlay[field] = prior;
    fieldStats.push({ field, buckets: entries.length, samples: total });
  }

  return {
    overlay,
    sampleCount: redisPlans + supabasePlans,
    redisPlans,
    supabasePlans,
    fieldStats,
    skipped,
  };
}

/**
 * Canonical redis key where each brand's build-priors cron stashes the
 * freshest overlay. Brand-namespaced (was a single hardcoded `pmp:` prefix
 * in plan-my-party) so all 5 sites can share one Redis without collisions.
 */
export function overlayRedisKey(brand: Brand): string {
  return `${brand}:priors-overlay:latest`;
}
