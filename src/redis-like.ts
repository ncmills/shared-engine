// src/redis-like.ts
/** Minimal Redis surface shared-engine needs. Satisfied by each site's
 *  ioredis/upstash wrapper — injected so shared-engine adds no redis dep. */
export interface RedisLike {
  hincrby(key: string, field: string, n: number): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
  expire(key: string, seconds: number): Promise<unknown>;
  get?(key: string): Promise<string | null>;
  set?(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
}
