export * from './types';
export * from './hero-moment-validator';
export * from './atlas-retrieval';
export * from './brand-config';
export * from './pricing';
export * from './stats';
export * from './trip-terms-validator';
export * from './analytics';
export * from './priors';
export * from './surprise-me';
export * from './json-repair';
export * from './hobbies';
export * from './signals';
export * from './vid';
export * from './derive';
export * from './lead-profile';
export * from './room';
// NOTE: `./room` (src/room/slug.ts) already exports its own `RedisLike`
// (a different, narrower get/set-only shape for slug lookups). Re-exporting
// this module's `RedisLike` under the same bare name via `export *` would
// collide, so it's re-exported under an alias here; import it directly from
// `shared-engine/redis-like` (or `shared-engine/popularity`, which re-exports
// it) if you want the bare `RedisLike` name. See task-4-report.md.
export type { RedisLike as PopularityRedisLike } from './redis-like';
export {
  recordDestinationView,
  recordDestinationSelect,
  getAllPopularityScores,
  popularityBonus,
} from './popularity';
