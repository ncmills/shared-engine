/**
 * Trip Room V1 (2026-04-16) — slug generation + validation (shared).
 *
 * Extracted from MOH + BESTMAN src/lib/slug.ts during the 2026-04-22
 * Phase-3 extraction. Redis client is passed in as an argument so this
 * lib stays dep-free.
 *
 * Slugs live in Redis as a secondary index:
 *   slug:{brand}:{slug} → plan_id
 * The KEY_PREFIX on each repo's redis client ("moh:" or "pmp:") is applied
 * automatically so the actual key is `{prefix}:slug:{brand}:{slug}`. The
 * brand is also embedded in the slug key for future cross-brand lookups.
 *
 * Old-slug redirects are kept forever (no TTL) so previously-shared
 * /trip/{old} URLs continue to resolve even after the owner edits the slug.
 */

import type { BrandId } from "../types";

/** Minimal Redis-client shape we need — matches ioredis + @upstash/redis. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
}

const RESERVED = new Set([
  "shop", "admin", "api", "auth", "plan", "trip", "showcase", "about",
  "privacy", "terms", "help", "blog", "faq", "contact", "login", "signup",
  "logout", "compare", "vibe", "region", "state", "city", "activities",
  "venues", "best-for", "looking-back", "my-trips", "sites", "sitemap-html",
  "robots", "sitemap", "opengraph-image", "icon", "apple-icon", "magic-link",
  "claim", "trips",
]);

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIN_LEN = 4;
const MAX_LEN = 40;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 5).padEnd(3, "x");
}

export function generateSlug(honoreeName: string, vibeTag?: string): string {
  const nameBit = normalize(honoreeName).slice(0, 16) || "trip";
  const vibeBit = vibeTag ? normalize(vibeTag).slice(0, 16) : "";
  let base = vibeBit ? `${nameBit}-${vibeBit}` : nameBit;
  if (base.length < MIN_LEN) base = `${base}-plan`;
  if (base.length > MAX_LEN) base = base.slice(0, MAX_LEN).replace(/-$/, "");
  return base;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  normalized?: string;
}

export function validateSlug(raw: string): ValidationResult {
  const s = (raw || "").toLowerCase().trim();
  if (!s) return { valid: false, reason: "Slug is required." };
  if (s.length < MIN_LEN) return { valid: false, reason: `Must be at least ${MIN_LEN} characters.` };
  if (s.length > MAX_LEN) return { valid: false, reason: `Must be ${MAX_LEN} characters or fewer.` };
  if (!SLUG_RE.test(s)) return { valid: false, reason: "Use lowercase letters, numbers, and single hyphens only." };
  if (RESERVED.has(s)) return { valid: false, reason: "That word is reserved. Try another." };
  return { valid: true, normalized: s };
}

function slugKey(brand: string, slug: string): string {
  return `slug:${brand}:${slug}`;
}

export async function reserveSlug(
  brand: BrandId,
  slugCandidate: string,
  planId: string,
  redis: RedisLike
): Promise<string> {
  let candidate = slugCandidate;
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = slugKey(brand, candidate);
    const existing = await redis.get(key);
    if (!existing) {
      await redis.set(key, planId); // no TTL — slug lives as long as plan
      return candidate;
    }
    if (existing === planId) return candidate; // idempotent
    const suffix = randomSuffix();
    const base = slugCandidate.length + 4 > MAX_LEN
      ? slugCandidate.slice(0, MAX_LEN - 4).replace(/-$/, "")
      : slugCandidate;
    candidate = `${base}-${suffix}`;
  }
  const fallback = `${slugCandidate.slice(0, 30)}-${Date.now().toString(36).slice(-4)}`;
  await redis.set(slugKey(brand, fallback), planId);
  return fallback;
}

export async function resolveSlug(
  brand: BrandId,
  slug: string,
  redis: RedisLike
): Promise<string | null> {
  const s = slug.toLowerCase().trim();
  if (!s) return null;
  return await redis.get(slugKey(brand, s));
}

export async function updateSlug(
  brand: BrandId,
  oldSlug: string | undefined,
  newSlug: string,
  planId: string,
  redis: RedisLike
): Promise<string> {
  const validation = validateSlug(newSlug);
  if (!validation.valid || !validation.normalized) {
    throw new Error(validation.reason ?? "Invalid slug");
  }
  const finalSlug = await reserveSlug(brand, validation.normalized, planId, redis);
  // Old slug intentionally NOT deleted — kept as permanent redirect.
  if (oldSlug && oldSlug !== finalSlug) {
    // leave `slug:{brand}:{oldSlug}` → planId intact
  }
  return finalSlug;
}
