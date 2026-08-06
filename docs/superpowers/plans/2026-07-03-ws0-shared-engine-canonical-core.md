# WS0 — shared-engine Canonical Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `shared-engine` into the single source of truth for the portfolio data-collection regime — extend brands, canonicalize PII scrubbing, and lift the popularity + priors-builder + email-scheduler + acquisition-beacon modules in as dependency-injected, brand-parameterized exports — so OO, HHQ, BM, and MOH can all import one engine in later workstreams.

**Architecture:** `shared-engine` is source-imported (no build; `main: src/index.ts`) and consumed by sites via `github:ncmills/shared-engine`. WS0 adds new pure/DI modules and widens existing types without changing any consumer yet. Redis/Supabase are injected as typed client interfaces (shared-engine stays infra-agnostic). All work lands on branch `spec/portfolio-data-collection-unification`; no consumer repnpm-installs the new version until its own workstream (WS1–WS3).

**Tech Stack:** TypeScript (ESM, `type: module`), Vitest, React 19 (peer), `@supabase/supabase-js` (peer), injected Redis-like client.

## Global Constraints

- shared-engine is source-imported: `main`/`types` = `src/index.ts`; every new module MUST be re-exported from `src/index.ts`. (verbatim: `"main": "src/index.ts"`)
- No new hard dependencies in shared-engine — Redis and Supabase clients are **injected** as typed params; only `@supabase/supabase-js`, `next`, `react` remain as peers.
- Signal logging stays strictly fire-and-forget; `stripPII` stays a **pure** function.
- `vid` is NOT PII — it must survive `stripPII` (never add it to the banned set).
- Brand tags across the regime: `moh | bestman | tdf | offsite | handicaphq`. `tdf` is retained in the type for historical rows only; no site emits it after WS2.
- Rollout is lossless + staged: WS0 changes are consumed by one site at a time in later workstreams. Do NOT bump any consumer's `shared-engine` pin in this plan.
- Multi-repo hygiene (`feedback_parallel_session_commits`): stage only shared-engine files; no bare `git commit -a`.
- End every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Vitest test runner + baseline

**Files:**
- Modify: `~/shared-engine/package.json`
- Create: `~/shared-engine/src/__tests__/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm test` (`npx vitest run`) that later tasks use.

- [ ] **Step 1: Add vitest devDep + test script**

In `package.json`, add to `scripts`: `"test": "npx vitest run"`, and to `devDependencies`: `"vitest": "^3.2.4"`. Then run `cd ~/shared-engine && npm install`.

- [ ] **Step 2: Write the smoke test**

```ts
// src/__tests__/smoke.test.ts
import { describe, it, expect } from "vitest";
import { stripPII } from "../signals";

describe("shared-engine test harness", () => {
  it("imports and runs", () => {
    expect(stripPII({ keep: "yes" })).toEqual({ keep: "yes" });
  });
});
```

- [ ] **Step 3: Run it**

Run: `cd ~/shared-engine && npm test`
Expected: PASS, 1 test.

- [ ] **Step 4: Commit**

```bash
cd ~/shared-engine && git add package.json package-lock.json src/__tests__/smoke.test.ts
git commit -m "chore: add vitest runner to shared-engine

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Extend the signal Brand tag

**Scope note (narrowed 2026-07-03, Nick):** `BrandConfig`/`BrandId`/`configForBrand` are wedding-wizard plan-generation concepts (`scoreField: 'bachelorScore' | 'bacheloretteScore'`, `honoreeTerm`, etc.) — they have no honest `offsite`/`handicaphq` member and the data-collection regime does not use them. This task ONLY widens the signal `Brand` tag. Do NOT touch `types.ts`, `brand-config.ts`, or `configForBrand`. If a later workstream converges plan-generation and genuinely needs brand configs, it adds them then with real content.

**Files:**
- Modify: `~/shared-engine/src/signals.ts:32` (`Brand` type)
- Test: `~/shared-engine/src/__tests__/brands.test.ts`

**Interfaces:**
- Consumes: existing `SignalPayload` interface (`signals.ts:54`), which is typed on `Brand`.
- Produces: `Brand` widened to `"moh" | "bestman" | "tdf" | "offsite" | "handicaphq"`. Everything already generic over `Brand` (`logSelection`, `logBookmark`, `logAcquisition`, `SignalPayload`) now accepts the two new brands with no other change.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/brands.test.ts
import { describe, it, expect } from "vitest";
import { logSelection, type Brand, type SignalPayload } from "../signals";

describe("Brand tag extension", () => {
  it("accepts all five brand tags at the type level", () => {
    const brands: Brand[] = ["moh", "bestman", "tdf", "offsite", "handicaphq"];
    expect(brands).toHaveLength(5);
  });
  it("accepts a SignalPayload branded offsite/handicaphq", () => {
    const a: SignalPayload = { brand: "offsite" };
    const b: SignalPayload = { brand: "handicaphq" };
    expect([a.brand, b.brand]).toEqual(["offsite", "handicaphq"]);
  });
  it("logSelection is callable with the new brands (no throw, fire-and-forget)", () => {
    expect(() => logSelection("offsite", { slot: "vibe", action: "add" })).not.toThrow();
    expect(() => logSelection("handicaphq", { slot: "course", action: "add" })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/shared-engine && npx vitest run src/__tests__/brands.test.ts`
Expected: FAIL — TypeScript rejects `"offsite"`/`"handicaphq"` as `Brand` (type error at the `SignalPayload` literals / `logSelection` args).

- [ ] **Step 3: Widen the Brand type**

In `src/signals.ts:32`, replace:
```ts
export type Brand = "moh" | "bestman" | "tdf" | "offsite" | "handicaphq";
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ~/shared-engine && npx vitest run src/__tests__/brands.test.ts && npm run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd ~/shared-engine && git add src/signals.ts src/__tests__/brands.test.ts
git commit -m "feat: add offsite + handicaphq signal brand tags to shared-engine

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Canonicalize stripPII on the HHQ superset + array recursion

**Files:**
- Modify: `~/shared-engine/src/signals.ts:141-160` (`stripPII`)
- Reference (canonical source): `~/handicap-hq/src/lib/signals.ts:42` (`PII_KEYS`, array-recursing scrub)
- Test: `~/shared-engine/src/__tests__/strip-pii.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `stripPII<T>(payload: T): T` — same signature, superset banned keys, recurses into arrays AND plain objects, preserves `vid`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/strip-pii.test.ts
import { describe, it, expect } from "vitest";
import { stripPII } from "../signals";

describe("stripPII canonical superset", () => {
  it("strips new banned keys", () => {
    const out = stripPII({ ip: "1.2.3.4", ssn: "x", attendeeNames: ["a"], vid: "v1", city: "Austin" });
    expect(out).toEqual({ vid: "v1", city: "Austin" });
  });
  it("recurses into array elements", () => {
    const out = stripPII({ attendees: [{ email: "a@b.com", name: "A", role: "gm" }] } as Record<string, unknown>);
    // `attendees` itself is banned → dropped entirely
    expect(out).toEqual({});
  });
  it("scrubs PII nested inside a non-banned array", () => {
    const out = stripPII({ picks: [{ ip: "1.2.3.4", label: "keep" }] } as Record<string, unknown>);
    expect(out).toEqual({ picks: [{ label: "keep" }] });
  });
  it("preserves vid always", () => {
    expect(stripPII({ vid: "v" })).toEqual({ vid: "v" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/shared-engine && npx vitest run src/__tests__/strip-pii.test.ts`
Expected: FAIL — current banned set lacks `ip`/`ssn`/`attendeeNames`; no array recursion.

- [ ] **Step 3: Replace stripPII**

Replace `src/signals.ts:141-160` with the canonical implementation (superset from HHQ `PII_KEYS` + existing banned set, minus `vid`):
```ts
export function stripPII<T extends Record<string, unknown>>(payload: T): T {
  const banned = new Set([
    // existing shared-engine banned set
    "email", "organizerEmail", "organizerName", "authPassword", "password", "specialRequests",
    // HHQ superset
    "attendeeEmail", "attendeeEmails", "ip", "ipAddress", "ssn",
    "address", "streetAddress", "attendees", "attendeeNames", "phone",
  ]);
  const scrub = (val: unknown): unknown => {
    if (Array.isArray(val)) return val.map(scrub);
    if (val && typeof val === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (banned.has(k)) continue;
        o[k] = scrub(v);
      }
      return o;
    }
    return val;
  };
  return scrub(payload) as T;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ~/shared-engine && npx vitest run src/__tests__/strip-pii.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/shared-engine && git add src/signals.ts src/__tests__/strip-pii.test.ts
git commit -m "feat: canonicalize stripPII on HHQ superset + array recursion

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: RedisLike interface + lift the popularity module

**Files:**
- Create: `~/shared-engine/src/redis-like.ts`
- Create: `~/shared-engine/src/popularity.ts`
- Reference (canonical source): `~/handicap-hq/src/lib/kv.ts:59-140` (`recordDestinationView`, `recordDestinationSelect`, `getAllPopularityScores`) + `~/handicap-hq/src/data/query.ts:22` (`setPopularityScores` consumer, ranking bonus)
- Modify: `~/shared-engine/src/index.ts` (export both)
- Test: `~/shared-engine/src/__tests__/popularity.test.ts`

**Fidelity note (revised 2026-07-03 after reading HHQ kv.ts):** the shared module must be a **lossless superset** of HHQ's implementation — preserve the `region:`/`budget:`/`tier:` sub-counters (as optional, brand-generic breakdown params — NOT HHQ's `WizardState`) and the 5-min `popularity:cache` layer. Deliberate simplification vs HHQ: use sequential `hget` in the cache-rebuild loop instead of HHQ's `pipeline()` — identical data, and the cache means the rebuild runs at most once per 5 min, so `RedisLike` stays small (no pipeline builder to fake in tests).

**Interfaces:**
- Consumes: `RedisLike` (defined here).
- Produces:
  - `interface RedisLike { hincrby(key: string, field: string, n: number): Promise<unknown>; hget(key: string, field: string): Promise<string | null>; scan(cursor: string, ...args: (string|number)[]): Promise<[string, string[]]>; expire(key: string, s: number): Promise<unknown>; get(key: string): Promise<string | null>; set(key: string, value: string, ...args: (string|number)[]): Promise<unknown>; }` — `get`/`set` are required (the cache uses them); name the barrel export to avoid colliding with the pre-existing `RedisLike` in `src/room/slug.ts` (e.g. keep `RedisLike` inside `popularity.ts`/`redis-like.ts` and alias at the barrel).
  - `recordDestinationView(redis: RedisLike, destinationId: string, breakdown?: { region?: string; budget?: string }): Promise<void>` — always `hincrby(total)`; adds `region:${region}` / `budget:${budget}` when provided. Keys `signal:views:${id}`; `expire(key, SIGNAL_TTL)`.
  - `recordDestinationSelect(redis: RedisLike, destinationId: string, breakdown?: { tier?: string }): Promise<void>` — always `hincrby(total)`; adds `tier:${tier}` when provided. Keys `signal:selects:${id}`.
  - `getAllPopularityScores(redis: RedisLike): Promise<{ scores: Map<string, number>; viewCounts: Map<string, number> }>` — reads `popularity:cache` (5-min TTL) first; on miss, SCAN `signal:views:*` + sequential `hget` of `total` on views+selects, `score = selects/views` when `views > 0`, then writes the cache (non-blocking). Matches HHQ math byte-for-byte.
  - `popularityBonus(scores: Map<string, number>, destinationId: string, cap?: number): number` (capped ranking nudge; default cap 10, matching HHQ `query.ts` `+10`)

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/popularity.test.ts
import { describe, it, expect } from "vitest";
import { getAllPopularityScores, popularityBonus, type RedisLike } from "../popularity";

function fakeRedis(views: Record<string, number>, selects: Record<string, number>): RedisLike {
  return {
    async hincrby() { return 1; },
    async hget(key) {
      const id = key.replace(/^signal:(views|selects):/, "");
      const src = key.startsWith("signal:selects:") ? selects : views;
      return src[id] != null ? String(src[id]) : null;
    },
    async scan(_c, ..._a) { return ["0", Object.keys(views).map((id) => `signal:views:${id}`)]; },
    async expire() { return 1; },
  };
}

describe("popularity", () => {
  it("computes select/view ratio scores", async () => {
    const r = fakeRedis({ austin: 100 }, { austin: 25 });
    const { scores } = await getAllPopularityScores(r);
    expect(scores.get("austin")).toBeGreaterThan(0);
  });
  it("caps the ranking bonus", () => {
    const scores = new Map([["austin", 999]]);
    expect(popularityBonus(scores, "austin", 10)).toBeLessThanOrEqual(10);
    expect(popularityBonus(scores, "unknown", 10)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/shared-engine && npx vitest run src/__tests__/popularity.test.ts`
Expected: FAIL — module `../popularity` does not exist.

- [ ] **Step 3: Create `redis-like.ts`**

```ts
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
```

- [ ] **Step 4: Create `popularity.ts`**

Port the bodies of `recordDestinationView`/`recordDestinationSelect`/`getAllPopularityScores` verbatim from `~/handicap-hq/src/lib/kv.ts:59-140`, with two adaptations: (a) take `redis: RedisLike` as the first param instead of calling a module-level `getRedis()`; (b) re-export `RedisLike` from `./redis-like`. Add `popularityBonus` matching the capped `+10` nudge HHQ applies in `query.ts` (`score += Math.min(rawScore, cap)`; return `0` when the id is absent). Keys stay `signal:views:${id}` / `signal:selects:${id}`.

```ts
// src/popularity.ts (signatures — port bodies from HHQ kv.ts:59-140)
import type { RedisLike } from "./redis-like";
export type { RedisLike } from "./redis-like";

export async function recordDestinationView(redis: RedisLike, destinationId: string): Promise<void> { /* port kv.ts:59-78 */ }
export async function recordDestinationSelect(redis: RedisLike, destinationId: string): Promise<void> { /* port kv.ts:80-96 */ }
export async function getAllPopularityScores(redis: RedisLike): Promise<{ scores: Map<string, number>; viewCounts: Map<string, number> }> { /* port kv.ts:98-140 */ }

export function popularityBonus(scores: Map<string, number>, destinationId: string, cap = 10): number {
  const raw = scores.get(destinationId);
  if (!raw || raw <= 0) return 0;
  return Math.min(raw, cap);
}
```

- [ ] **Step 5: Export from the barrel**

In `src/index.ts` add: `export * from './redis-like';` and `export * from './popularity';`

- [ ] **Step 6: Run to verify it passes**

Run: `cd ~/shared-engine && npx vitest run src/__tests__/popularity.test.ts && npm run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 7: Commit**

```bash
cd ~/shared-engine && git add src/redis-like.ts src/popularity.ts src/index.ts src/__tests__/popularity.test.ts
git commit -m "feat: lift HHQ popularity loop into shared-engine (DI redis)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Lift the priors-builder into shared-engine

**Files:**
- Create: `~/shared-engine/src/priors-builder.ts`
- Reference (canonical source): `~/plan-my-party/src/lib/priors-builder.ts` (whole file) + cron `~/plan-my-party/src/app/api/cron/build-priors/route.ts`
- Modify: `~/shared-engine/src/index.ts`
- Test: `~/shared-engine/src/__tests__/priors-builder.test.ts`

**Interfaces:**
- Consumes: `RedisLike` (Task 4); a Supabase client (injected, typed as the `@supabase/supabase-js` `SupabaseClient`); `registerPriorOverlay` (already exported from `priors.ts`).
- Produces:
  - `type Overlay = Record<string, unknown>`
  - `interface BuildPriorsOptions { brand: Brand; fields: string[]; supabase: SupabaseClient | null; redis?: RedisLike | null; minSamples?: number; minBucket?: number; sinceDays?: number; }`
  - `interface BuildPriorsResult { overlay: Overlay; sampleCount: number; }`
  - `buildPriorsOverlay(opts: BuildPriorsOptions): Promise<BuildPriorsResult>`
  - `overlayRedisKey(brand: Brand): string` (namespaced per brand, e.g. `${brand}:priors-overlay:latest`)

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/priors-builder.test.ts
import { describe, it, expect } from "vitest";
import { buildPriorsOverlay, overlayRedisKey } from "../priors-builder";

describe("priors-builder", () => {
  it("namespaces the overlay key per brand", () => {
    expect(overlayRedisKey("offsite")).toContain("offsite");
    expect(overlayRedisKey("handicaphq")).toContain("handicaphq");
  });
  it("gates fields below minSamples out of the overlay", async () => {
    // supabase null + redis null → zero samples → empty overlay
    const res = await buildPriorsOverlay({ brand: "offsite", fields: ["vibeTags"], supabase: null, redis: null, minSamples: 20 });
    expect(res.sampleCount).toBe(0);
    expect(res.overlay).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/shared-engine && npx vitest run src/__tests__/priors-builder.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `priors-builder.ts`**

Port `~/plan-my-party/src/lib/priors-builder.ts` with these adaptations: (a) `scanSupabasePlanInputs` takes the injected `supabase` client (param), returns `[]` when it is null; (b) the Redis union (`plan:*` tallies) takes the injected `redis` (param), skipped when null; (c) `brand` and `fields` come from `opts` (was hardcoded `SURPRISE_FIELDS`/`BRAND` in the cron); (d) `overlayRedisKey(brand)` becomes brand-namespaced (was `pmp:` constant). Keep the aggregation + `minSamples`/`minBucket` gating logic byte-for-byte. Filter Supabase rows by `.eq("brand", brand)` and `.gte("created_at", <sinceDays ago>)` exactly as the source does.

- [ ] **Step 4: Export from the barrel**

In `src/index.ts` add: `export * from './priors-builder';`

- [ ] **Step 5: Run to verify it passes**

Run: `cd ~/shared-engine && npx vitest run src/__tests__/priors-builder.test.ts && npm run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd ~/shared-engine && git add src/priors-builder.ts src/index.ts src/__tests__/priors-builder.test.ts
git commit -m "feat: lift priors-builder into shared-engine (DI supabase+redis, brand-param)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Promote the email-scheduler contract

**Files:**
- Create: `~/shared-engine/src/email-scheduler.ts`
- Reference (canonical source): `~/handicap-hq/src/lib/email-scheduler.ts` + `~/plan-my-party/supabase/migrations/20260423T2_email_schedule.sql`
- Modify: `~/shared-engine/src/index.ts`
- Test: `~/shared-engine/src/__tests__/email-scheduler.test.ts`

**Interfaces:**
**Fidelity + safety notes (revised 2026-07-03 after review of the real schema):**
- Real `wp_email_schedule` columns are `email, brand, sequence_step, send_at` (+ `sent_at/skipped_at/...`). There is NO `template` or `vid` column — template is resolved from `sequence_step` by the cron; `vid` is not stored here. Keep `template`/`vid` on the TS interfaces (caller ergonomics) but do NOT persist them. Map `step → sequence_step`.
- **`step` is 1-based** — the DB enforces `CHECK (sequence_step BETWEEN 1 AND 10)`, and all three real producers use 1-based steps (HHQ/MOH `idx+1`, BMHQ explicit `1..5`). The `WelcomeEmail.step` contract, the pure builder's echoed `step`, and the test fixtures are all 1-based. `scheduleWelcomeSequence` MUST reject/throw on a `step` outside `1..10` before hitting the DB (a Postgres CHECK violation rejects the WHOLE upsert batch).
- **No silent failure** (Nick hard rule): `scheduleWelcomeSequence` returns `Promise<{ scheduled: number }>` and MUST surface an insert error (throw, or return an `error`) — do NOT swallow the Supabase error into a bare `console.warn`. Preserve HHQ's idempotent upsert (`onConflict "email,brand,sequence_step"`, `ignoreDuplicates`) + email validation.
- **WS4 dependency (document in the module):** the live `wp_email_schedule`/`wp_leads` brand `CHECK` currently allows only `('moh','bestman','tdf')`. `offsite`/`handicaphq` inserts will be rejected until WS4 widens the constraint. Add a doc-comment noting this so the WS1/WS2 wiring knows the ordering.

- Consumes: injected `SupabaseClient`, `Brand`.
- Produces:
  - `interface WelcomeEmail { step: number; /* 1-based, 1..10 */ sendAtOffsetHours: number; template: string; }`
  - `buildWelcomeSchedule(sequence: WelcomeEmail[], startIso: string): { send_at: string; step: number; template: string }[]` (pure — computes send_at from offsets; echoes 1-based `step`)
  - `scheduleWelcomeSequence(supabase: SupabaseClient, args: { brand: Brand; email: string; vid?: string; sequence: WelcomeEmail[]; nowIso: string }): Promise<{ scheduled: number }>` (upserts into `wp_email_schedule`, `step→sequence_step`; throws on out-of-range step or Supabase error)

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/email-scheduler.test.ts
import { describe, it, expect } from "vitest";
import { buildWelcomeSchedule } from "../email-scheduler";

describe("email-scheduler", () => {
  it("computes send_at from hour offsets and echoes 1-based step", () => {
    const rows = buildWelcomeSchedule(
      [{ step: 1, sendAtOffsetHours: 0, template: "welcome" }, { step: 2, sendAtOffsetHours: 24, template: "tips" }],
      "2026-07-03T00:00:00.000Z"
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.send_at).toBe("2026-07-03T00:00:00.000Z");
    expect(rows[0]!.step).toBe(1);
    expect(rows[1]!.send_at).toBe("2026-07-04T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/shared-engine && npx vitest run src/__tests__/email-scheduler.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `email-scheduler.ts`**

Port `scheduleWelcomeSequence` from `~/handicap-hq/src/lib/email-scheduler.ts` with the supabase client injected as a param and `brand` from args. Extract the pure send_at computation into `buildWelcomeSchedule(sequence, startIso)` (add `offsetHours*3600_000` ms to `Date.parse(startIso)`, emit ISO). Table name is `wp_email_schedule`; columns match `20260423T2_email_schedule.sql`.

- [ ] **Step 4: Export from the barrel**

In `src/index.ts` add: `export * from './email-scheduler';`

- [ ] **Step 5: Run to verify it passes**

Run: `cd ~/shared-engine && npx vitest run src/__tests__/email-scheduler.test.ts && npm run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd ~/shared-engine && git add src/email-scheduler.ts src/index.ts src/__tests__/email-scheduler.test.ts
git commit -m "feat: promote email-scheduler contract into shared-engine

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Promote the AcquisitionBeacon component

**Files:**
- Create: `~/shared-engine/src/acquisition-beacon.tsx`
- Modify: `~/shared-engine/tsconfig.json` (add `"jsx": "react-jsx"` + DOM lib — this is shared-engine's first `.tsx`)
- Reference (canonical source): `~/handicap-hq/src/components/AcquisitionBeacon.tsx`
- Modify: `~/shared-engine/src/index.ts`
- Test: `~/shared-engine/src/__tests__/acquisition-beacon.test.ts`

**tsconfig enablement (do first):** shared-engine's tsconfig has no `jsx`/DOM lib (it was pure `.ts`). Add `"jsx": "react-jsx"` and a `"lib"` including `"DOM"`/`"DOM.Iterable"` (e.g. `["ES2022","DOM","DOM.Iterable"]`) to `compilerOptions`. Consumers (Next apps) already have these; this is only for shared-engine's own `npm run typecheck`/vitest. **Regression gate:** after the tsconfig change, `npm test` (all existing tests) + `npm run typecheck` MUST still pass. If adding DOM lib cascades type errors across existing modules, STOP, revert the component, ship ONLY the pure `parseAcquisition` helper (a plain `.ts` file, no jsx needed), and report DONE_WITH_CONCERNS — the site-local wrapper stays site-side in WS1.

**Interfaces:**
- Consumes: `logAcquisition(brand, data)` from `signals.ts`; `Brand`.
- Produces:
  - `parseAcquisition(searchParams: URLSearchParams, referrer: string, ua: string): { source: string; medium?: string; campaign?: string; device: "mobile" | "desktop" }` — the PURE extraction helper (this is the real shared logic; utm_* wins over referrer host; `device = /Mobi|Android|iPhone|iPad|iPod/i.test(ua) ? "mobile" : "desktop"` (HHQ's canonical regex — catches iPad/iPod/generic Mobi; do NOT narrow it)).
  - `AcquisitionBeacon({ brand }: { brand: Brand }): null` — a `"use client"` component that fires `logAcquisition` **once per browser session** (guarded by a `sessionStorage` flag, matching HHQ's `ACQ_SENT_KEY`) inside a `useEffect`, and renders `null`. Keep the `logAcquisition` payload shape identical to HHQ's (`{ ref, utm, device, ... }`) — port it faithfully; if HHQ logs fields `parseAcquisition` doesn't return, extend `parseAcquisition` rather than dropping them.

- [ ] **Step 1: Write the failing test (pure helper only)**

```ts
// src/__tests__/acquisition-beacon.test.ts
import { describe, it, expect } from "vitest";
import { parseAcquisition } from "../acquisition-beacon";

describe("parseAcquisition", () => {
  it("extracts utm + coarse device", () => {
    const sp = new URLSearchParams("utm_source=reddit&utm_medium=social&utm_campaign=launch");
    const out = parseAcquisition(sp, "https://reddit.com/", "Mozilla/5.0 (iPhone)");
    expect(out.source).toBe("reddit");
    expect(out.medium).toBe("social");
    expect(out.device).toBe("mobile");
  });
  it("falls back to referrer host when no utm", () => {
    const out = parseAcquisition(new URLSearchParams(""), "https://news.ycombinator.com/", "Mozilla/5.0 (Macintosh)");
    expect(out.source).toContain("ycombinator");
    expect(out.device).toBe("desktop");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/shared-engine && npx vitest run src/__tests__/acquisition-beacon.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `acquisition-beacon.tsx`**

Port the component from `~/handicap-hq/src/components/AcquisitionBeacon.tsx`, taking `brand` as a prop (was hardcoded). Extract the UTM/referrer/device parsing into the pure `parseAcquisition(...)` (utm_* wins over referrer host; device = `/iphone|android|mobile/i.test(ua) ? "mobile" : "desktop"`). The component runs `parseAcquisition` in a `useEffect`, calls `logAcquisition(brand, parsed)` once (ref guard), returns `null`.

- [ ] **Step 4: Export from the barrel**

In `src/index.ts` add: `export * from './acquisition-beacon';`

- [ ] **Step 5: Run to verify it passes**

Run: `cd ~/shared-engine && npx vitest run src/__tests__/acquisition-beacon.test.ts && npm run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd ~/shared-engine && git add src/acquisition-beacon.tsx src/index.ts src/__tests__/acquisition-beacon.test.ts
git commit -m "feat: promote AcquisitionBeacon into shared-engine (brand prop)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Version bump + full green gate

**Files:**
- Modify: `~/shared-engine/package.json:2` (version)
- Verify: `~/shared-engine/src/index.ts` exports all new modules.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: `shared-engine@0.4.0` on branch `spec/portfolio-data-collection-unification`, ready for WS1–WS3 to pin.

- [ ] **Step 1: Bump version**

In `package.json`, change `"version": "0.3.0"` → `"version": "0.4.0"`.

- [ ] **Step 2: Confirm barrel exports**

Run: `grep -E "popularity|redis-like|priors-builder|email-scheduler|acquisition-beacon" ~/shared-engine/src/index.ts`
Expected: all five present.

- [ ] **Step 3: Full test + typecheck gate**

Run: `cd ~/shared-engine && npm test && npm run typecheck`
Expected: ALL tests PASS; typecheck clean.

- [ ] **Step 4: Commit + push the branch**

```bash
cd ~/shared-engine && git add package.json
git commit -m "chore: shared-engine 0.4.0 — canonical data-collection core

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push -u origin spec/portfolio-data-collection-unification
```
(Push makes the branch pin-able via `github:ncmills/shared-engine#spec/portfolio-data-collection-unification` in WS1–WS3. Do NOT merge to main until all site workstreams pass — that's the lossless staged-rollout gate.)

---

## Self-Review

**Spec coverage (WS0 items from §6):** promote 6 modules ✓ (signals/stripPII T3, priors + priors-builder T5, popularity T4, lead-capture — *note: `lead-profile.ts` already lives in shared-engine per `index.ts`; no lift needed, WS1/WS2 import it directly*, email-scheduler T6, acquisition T7); extend Brand ✓ (T2, signal tag only); canonicalize stripPII ✓ (T3); parameterize brand-specific behavior ✓ (via DI `brand`/`fields`/`sequence` params in T4–T6 — *not* via `BrandConfig`, which stays wedding-wizard-only per the Task 2 scope note); lift HHQ popularity + BM priors-builder ✓ (T4/T5); version bump ✓ (T8); typecheck+test gate ✓ (T8). Analytics canonical PostHog (`analytics.ts`) already in shared-engine — consumers import in later WS; no WS0 task needed.

**Placeholder scan:** Port tasks (T4/T5/T6/T7) reference an exact canonical source path + line range and enumerate the specific adaptations (DI client param, brand param, key namespacing); the transformation is fully specified and the target signatures are given in the Interfaces block. Full code is inline for all new pure logic and every test. No "TBD/handle-edge-cases" placeholders.

**Type consistency:** `RedisLike` defined in T4, consumed by name in T5. `Brand` widened in T2, used in T4–T7. `Overlay`/`BuildPriorsOptions`/`BuildPriorsResult` defined in T5 Interfaces. `overlayRedisKey` takes `brand` in T5 (namespaced) — consumers in WS1–WS3 must pass brand. `BrandId`/`configForBrand` are intentionally untouched (see Task 2 scope note).

**Open follow-ups handed to later workstreams (not WS0):** the `github:` dep-pin cutover (WS1–WS3 pin to the branch, then a final merge-to-main task in the last workstream); the `tdf`→`handicaphq` DB backfill (WS2/WS4); consumer rewiring + emit instrumentation (WS1/WS2).
