# Planner Concierge Engine — Phase 2a (Commit Engine Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the Phase 1 atomic saga into a real **staged-commit engine**: hold ALL holdable items → assemble a priced trip → validate spend caps → commit non-refundables **shortest-hold-TTL-first** → on any failure, compensate booked items AND release still-uncommitted holds (no orphans, no stuck holds). All deterministic, against `MockRail`, no money, no infra, on-branch only.

**Architecture:** Extends `src/concierge/`. Adds a `release(holdRef)` step to the `BookingRail` contract (so an uncommitted hold can be dropped without a booking), a `checkSpendCaps` guardrail (`caps.ts`), a generic `resolveManifest` (mixed-category), and `Orchestrator.executeStaged()` — a trip state machine (DRAFT→RESOLVING→HELD→PENDING_CONFIRM→COMMITTING→CONFIRMED / FAILED) that separates hold from commit and orders commits by soonest expiry. The money-critical compensation loop from Phase 1 is extracted to a shared private helper so `executeSaga` and `executeStaged` share one audited, isolation-safe implementation.

**Tech Stack:** TypeScript, vitest (`npx vitest run`), `tsc --noEmit`. No new runtime dependencies (global `fetch`).

## Global Constraints

- **Tenants are `'moh' | 'bestman' | 'handicaphq'` only.** OO/`'tdf'` remain unrepresentable.
- **The LLM / any `ProposalSource` may only propose.** Only the `Orchestrator` calls `hold`/`book`/`cancel`/`release`.
- **Determinism:** no `Math.random()` / `Date.now()` / argless `new Date()`. `now` is an explicit `string`; all time comparisons parse to epoch (`Date.parse`); audit `ts = ctx.now`. Commit ordering derives from hold `expiresAt`, not wall-clock.
- **All money amounts are integer cents.** No real money moves — MockRail only, no deploy, no site mount.
- **No-orphan + no-stuck-hold invariant:** after `executeStaged` returns, there is (a) never a live booking for a trip that ended `FAILED`, and (b) never a live hold that was neither committed nor released (modulo `failedCompensations`/failed releases, which are surfaced, never swallowed).
- **Shortest-hold-TTL-first:** in the COMMITTING phase, items are committed in ascending `Date.parse(expiresAt)` order so the soonest-to-expire hold is secured first.
- **Append-only audit** (`AuditLog`): actions extended with `release` and `release_failed`.
- **Scope guard (deferred to later 2x sub-phases):** NO LiteAPI/lodging adapter yet (2b), NO Supabase persistence / transactional outbox (2c — in-memory only), NO change/cancel subsystem (2d), NO card-auth UX (site-side). Spend caps are enforced here; the card-authorization *handoff* is not.
- **Follow repo conventions:** tests in `src/__tests__/concierge-*.test.ts`; `import` from `../concierge/<file>`; `describe/it/expect/vi` from `vitest`; export new public surface through `src/concierge/index.ts`. `noUncheckedIndexedAccess` is on.
- **Commit trailer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

- `src/concierge/rail.ts` — **MODIFY.** Add `release(holdRef: string): Promise<void>` to `BookingRail`.
- `src/concierge/mock-rail.ts` — **MODIFY.** Implement `release`; add `holdExpiresBySlot?` (per-slot TTL for ordering tests) and `failReleaseFor?` opts. Back-compatible.
- `src/concierge/opentable-adapter.ts` — **MODIFY.** Implement `release` (DELETE slot_lock).
- `src/concierge/getyourguide-adapter.ts` — **MODIFY.** Implement `release` (DELETE reservation).
- `src/concierge/rail-contract.ts` — **MODIFY.** Add a `hold -> release` contract test.
- `src/concierge/caps.ts` — **NEW.** `SpendCaps`, `checkSpendCaps`.
- `src/concierge/resolver.ts` — **MODIFY.** Add generic `resolveManifest`; refactor `resolveForCategory` to delegate to it.
- `src/concierge/audit.ts` — **MODIFY.** Extend `AuditEntry.action` with `"release" | "release_failed"`.
- `src/concierge/orchestrator.ts` — **MODIFY.** Extract `compensateBooked` + add `releaseHolds` private helpers; refactor `executeSaga` to use `compensateBooked`; add `executeStaged` + `TripState`/`StagedCtx`/`HeldItem`/`StagedResult`.
- `src/concierge/dry-run.ts` — **MODIFY.** Add `runConciergeStagedDryRun()`.
- `src/concierge/index.ts` — **MODIFY.** Add `export * from "./caps"`.
- Tests: `src/__tests__/concierge-{caps,resolve-manifest,staged,staged-dry-run}.test.ts` + additions to `rail-contract` via the adapter suites.

---

## Task 1: `release` on the BookingRail contract + all adapters

**Files:**
- Modify: `src/concierge/rail.ts`, `src/concierge/mock-rail.ts`, `src/concierge/opentable-adapter.ts`, `src/concierge/getyourguide-adapter.ts`, `src/concierge/rail-contract.ts`
- Test: exercised via existing `concierge-rail-contract.test.ts`, `concierge-opentable.test.ts`, `concierge-getyourguide.test.ts` (they all call `runBookingRailContract`).

**Interfaces:**
- Produces: `BookingRail.release(holdRef: string): Promise<void>` on every rail. `MockRail` gains `holdExpiresBySlot?: Record<string, string>` and `failReleaseFor?: string[]` opts.

- [ ] **Step 1: Add the contract test (will fail to compile until every rail implements it)**

Add to `src/concierge/rail-contract.ts`, inside the `describe`, after the existing `hold -> book` test:

```ts
    it("hold -> release (an uncommitted hold can be dropped)", async () => {
      const rail = makeRail();
      const slot = (await rail.search(q))[0]!;
      const held = await rail.hold(slot.railSlotId, { partySize: 4, dateTime: slot.startsAt });
      await expect(rail.release(held.holdRef)).resolves.toBeUndefined();
    });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/concierge-rail-contract.test.ts`
Expected: FAIL — `rail.release` is not a function (and `tsc` would flag the missing method).

- [ ] **Step 3: Add `release` to the interface**

In `src/concierge/rail.ts`, add to `BookingRail` (after `cancel`):

```ts
  /** Drop an uncommitted hold (no booking was made). Idempotent-friendly: releasing an
   *  unknown/expired hold should resolve, not throw, where the rail allows. */
  release(holdRef: string): Promise<void>;
```

- [ ] **Step 4: Implement on `MockRail`** — add the two opts and the method.

In `src/concierge/mock-rail.ts`, extend `MockRailOpts`:

```ts
export interface MockRailOpts {
  failBookFor?: string[];
  /** Slot ids whose cancel should throw — simulates a rail that fails to compensate. */
  failCancelFor?: string[];
  /** Slot ids whose release should throw — simulates a rail that fails to drop a hold. */
  failReleaseFor?: string[];
  /** >0 makes this a paid (activity-style) rail with a refundable policy. */
  priceCents?: number;
  /** Override the hold expiry; a past ISO simulates an already-expired hold. */
  holdExpiresAt?: string;
  /** Per-slot hold expiry override (wins over holdExpiresAt) — lets tests set distinct TTLs. */
  holdExpiresBySlot?: Record<string, string>;
  /** What cancel refunds; defaults to priceCents. */
  refundAmountCents?: number;
}
```

Change the `hold` expiry line to consult the per-slot map first:

```ts
      expiresAt: this.opts.holdExpiresBySlot?.[railSlotId] ?? this.opts.holdExpiresAt ?? FAR_FUTURE,
```

Add the `release` method (after `cancel`):

```ts
  async release(holdRef: string): Promise<void> {
    const slotId = this.holdToSlot.get(holdRef) ?? holdRef.replace(/^hold-/, "");
    if (this.opts.failReleaseFor?.includes(slotId)) {
      throw new Error(`MockRail: release refused for ${holdRef}`);
    }
    this.holdToSlot.delete(holdRef);
  }
```

- [ ] **Step 5: Implement `release` on `OpenTableAdapter`** (after `cancel`):

```ts
  async release(holdRef: string): Promise<void> {
    await this.req(`/v2/slot_locks/${holdRef}`, { method: "DELETE" });
  }
```

- [ ] **Step 6: Implement `release` on `GetYourGuideAdapter`** (after `cancel`):

```ts
  async release(holdRef: string): Promise<void> {
    await this.req(`/1/reservations/${holdRef}`, { method: "DELETE" });
  }
```

- [ ] **Step 7: Run the rail suites to verify pass**

Run: `npx vitest run src/__tests__/concierge-rail-contract.test.ts src/__tests__/concierge-opentable.test.ts src/__tests__/concierge-getyourguide.test.ts`
Expected: PASS — the `hold -> release` contract test is green for MockRail, OpenTable, and GYG (their fake fetches return 200 on the DELETE paths).

- [ ] **Step 8: Commit**

```bash
git add src/concierge/rail.ts src/concierge/mock-rail.ts src/concierge/opentable-adapter.ts src/concierge/getyourguide-adapter.ts src/concierge/rail-contract.ts
git commit -m "feat(concierge): add release() to BookingRail contract + all adapters

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Spend-caps guardrail

**Files:**
- Create: `src/concierge/caps.ts`
- Test: `src/__tests__/concierge-caps.test.ts`

**Interfaces:**
- Produces: `interface SpendCaps { totalCapCents?: number; categoryCapsCents?: Partial<Record<BookingCategory, number>> }`; `function checkSpendCaps(items: { category: BookingCategory; priceCents: number }[], caps?: SpendCaps): string | null` (null = within caps).

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/concierge-caps.test.ts
import { describe, it, expect } from "vitest";
import { checkSpendCaps } from "../concierge/caps";
import type { BookingCategory } from "../concierge/types";

const items = (rows: [BookingCategory, number][]) => rows.map(([category, priceCents]) => ({ category, priceCents }));

describe("checkSpendCaps", () => {
  it("returns null when no caps are provided", () => {
    expect(checkSpendCaps(items([["lodging", 50000]]), undefined)).toBeNull();
  });

  it("passes when total is at or under the total cap", () => {
    expect(checkSpendCaps(items([["lodging", 30000], ["activity", 20000]]), { totalCapCents: 50000 })).toBeNull();
  });

  it("rejects when total exceeds the total cap", () => {
    const err = checkSpendCaps(items([["lodging", 30000], ["activity", 25000]]), { totalCapCents: 50000 });
    expect(err).toMatch(/total/i);
  });

  it("rejects when a single category exceeds its category cap", () => {
    const err = checkSpendCaps(items([["lodging", 60000], ["activity", 5000]]), { categoryCapsCents: { lodging: 50000 } });
    expect(err).toMatch(/lodging/i);
  });

  it("passes when each category is within its cap", () => {
    expect(checkSpendCaps(items([["lodging", 40000], ["activity", 8000]]), { categoryCapsCents: { lodging: 50000, activity: 10000 } })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/concierge-caps.test.ts`
Expected: FAIL — cannot find module `../concierge/caps`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/concierge/caps.ts
import type { BookingCategory } from "./types";

export interface SpendCaps {
  totalCapCents?: number;
  categoryCapsCents?: Partial<Record<BookingCategory, number>>;
}

/** Deterministic guardrail over the assembled trip. Returns an error string if any cap is
 *  exceeded, else null. Caps are inclusive maxima (total === cap is allowed). */
export function checkSpendCaps(
  items: { category: BookingCategory; priceCents: number }[],
  caps?: SpendCaps,
): string | null {
  if (!caps) return null;
  const total = items.reduce((s, i) => s + i.priceCents, 0);
  if (caps.totalCapCents != null && total > caps.totalCapCents) {
    return `trip total ${total} exceeds cap ${caps.totalCapCents}`;
  }
  if (caps.categoryCapsCents) {
    for (const [cat, cap] of Object.entries(caps.categoryCapsCents) as [BookingCategory, number][]) {
      if (cap == null) continue;
      const catTotal = items.filter((i) => i.category === cat).reduce((s, i) => s + i.priceCents, 0);
      if (catTotal > cap) return `${cat} total ${catTotal} exceeds cap ${cap}`;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/concierge-caps.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/concierge/caps.ts src/__tests__/concierge-caps.test.ts
git commit -m "feat(concierge): spend-caps guardrail (total + per-category)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Generic `resolveManifest` (mixed-category)

**Files:**
- Modify: `src/concierge/resolver.ts`
- Test: `src/__tests__/concierge-resolve-manifest.test.ts`

**Interfaces:**
- Produces: `async function resolveManifest(args: ResolveArgs): Promise<BookingManifest>` — resolves intents of ANY category against one rail (used by the staged engine for mixed lodging+activity trips). `resolveDining`/`resolveActivities` keep their category-guard behavior (they now delegate to `resolveManifest`).

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/concierge-resolve-manifest.test.ts
import { describe, it, expect } from "vitest";
import { resolveManifest, DeterministicProposalSource } from "../concierge/resolver";
import { MockRail } from "../concierge/mock-rail";
import type { BookingIntent } from "../concierge/types";

const mixed: BookingIntent[] = [
  { itemId: "stay-1", category: "lodging", query: { area: "Nashville", dateTime: "2026-08-01T15:00:00Z", partySize: 6, maxPriceCents: 100000 } },
  { itemId: "tour-1", category: "activity", query: { area: "Nashville", dateTime: "2026-08-02T14:00:00Z", partySize: 6, maxPriceCents: 20000 } },
];

describe("resolveManifest", () => {
  it("resolves intents of mixed categories against one rail", async () => {
    const manifest = await resolveManifest({
      tripId: "trip-1",
      tenant: "moh",
      intents: mixed,
      rail: new MockRail({ priceCents: 8500 }),
      proposals: new DeterministicProposalSource(),
    });
    expect(manifest.items.map((i) => i.intent.category)).toEqual(["lodging", "activity"]);
    expect(manifest.items.every((i) => i.chosen !== null)).toBe(true);
  });

  it("still applies the budget-cap guardrail per intent", async () => {
    const manifest = await resolveManifest({
      tripId: "trip-2",
      tenant: "moh",
      intents: [{ itemId: "x", category: "lodging", query: { area: "Z", dateTime: "2026-08-01T15:00:00Z", partySize: 6, maxPriceCents: 100 } }],
      rail: new MockRail({ priceCents: 8500 }),
      proposals: new DeterministicProposalSource(),
    });
    expect(manifest.items[0]!.chosen).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/concierge-resolve-manifest.test.ts`
Expected: FAIL — `resolveManifest` is not exported.

- [ ] **Step 3: Refactor `resolver.ts`** — extract the category-agnostic core, delegate.

Replace the `resolveForCategory` function and the two public wrappers with:

```ts
/** Category-agnostic resolver: turns intents (any category) into a manifest against one rail,
 *  applying the provenance guard + validateChoice per intent. */
export async function resolveManifest(args: ResolveArgs): Promise<BookingManifest> {
  const items: ManifestItem[] = [];
  for (const intent of args.intents) {
    const candidates = await args.rail.search(intent.query);
    // Provenance guard: a chosen slot MUST be one the rail actually returned.
    const byId = new Map(candidates.map((c) => [c.railSlotId, c]));
    const ranked = await args.proposals.rank(intent, candidates);
    const chosen =
      ranked
        .map((c) => byId.get(c.railSlotId))
        .find((c): c is RailSlot => c != null && validateChoice(intent, c) === null) ?? null;
    items.push({ intent, candidates, chosen, rail: args.rail.railId });
  }
  return { tripId: args.tripId, tenant: args.tenant, items };
}

async function resolveForCategory(category: BookingCategory, args: ResolveArgs): Promise<BookingManifest> {
  for (const intent of args.intents) {
    // Fail loud if a mismatched category reaches a single-category resolver.
    if (intent.category !== category) {
      throw new Error(`resolve for ${category} received non-${category} intent ${intent.itemId} (${intent.category})`);
    }
  }
  return resolveManifest(args);
}

export async function resolveDining(args: ResolveArgs): Promise<BookingManifest> {
  return resolveForCategory("dining", args);
}

export async function resolveActivities(args: ResolveArgs): Promise<BookingManifest> {
  return resolveForCategory("activity", args);
}
```

(Leave the imports, `ProposalSource`, `DeterministicProposalSource`, `validateChoice`, `ResolveArgs`/`ResolveDiningArgs` above unchanged.)

- [ ] **Step 4: Run resolver suites to verify pass**

Run: `npx vitest run src/__tests__/concierge-resolve-manifest.test.ts src/__tests__/concierge-resolver.test.ts src/__tests__/concierge-resolver-activity.test.ts`
Expected: PASS — new suite green AND both Phase 0/1 resolver suites still green (the `/non-dining/` and `/non-activity/` throws are preserved by `resolveForCategory`).

- [ ] **Step 5: Commit**

```bash
git add src/concierge/resolver.ts src/__tests__/concierge-resolve-manifest.test.ts
git commit -m "feat(concierge): generic resolveManifest (mixed-category); single-category resolvers delegate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Staged-commit orchestrator (state machine + shortest-TTL-first + compensate/release)

**Files:**
- Modify: `src/concierge/audit.ts`, `src/concierge/orchestrator.ts`
- Test: `src/__tests__/concierge-staged.test.ts`

**Interfaces:**
- Consumes: `checkSpendCaps`, `SpendCaps` (Task 2); `AuditLog` with new actions (this task).
- Produces: `type TripState = "DRAFT" | "RESOLVING" | "HELD" | "PENDING_CONFIRM" | "COMMITTING" | "CONFIRMED" | "FAILED"`; `interface StagedCtx { lead: { leadName: string; leadEmail: string }; now: string; caps?: SpendCaps; actor?: string }`; `interface HeldItem { itemId: string; category: BookingCategory; railSlotId: string; holdRef: string; expiresAt: string; priceCents: number }`; `interface StagedResult { tripId: string; state: TripState; results: BookingResult[]; committedOrder: string[]; compensations: CompensationRecord[]; failedCompensations: CompensationFailure[]; releasedHolds: string[]; error: string | null }`; `Orchestrator.executeStaged(manifest, ctx): Promise<StagedResult>`. Private helpers `compensateBooked` + `releaseHolds` (also used to DRY `executeSaga`).

- [ ] **Step 1: Extend the audit action union**

In `src/concierge/audit.ts`, change the `action` field:

```ts
  action: "hold" | "book" | "book_failed" | "compensate" | "compensate_failed" | "release" | "release_failed";
```

- [ ] **Step 2: Write the failing test**

```ts
// src/__tests__/concierge-staged.test.ts
import { describe, it, expect } from "vitest";
import { Orchestrator, InMemoryBookingStore } from "../concierge/orchestrator";
import { InMemoryAuditLog } from "../concierge/audit";
import { resolveManifest, DeterministicProposalSource } from "../concierge/resolver";
import { MockRail } from "../concierge/mock-rail";
import type { BookingIntent } from "../concierge/types";

const lead = { leadName: "Ada", leadEmail: "ada@example.com" };
const now = "2026-07-20T12:00:00.000Z";

const intents: BookingIntent[] = [
  { itemId: "stay-1", category: "lodging", query: { area: "Nashville", dateTime: "2026-08-01T15:00:00Z", partySize: 6, maxPriceCents: 100000 } },
  { itemId: "tour-1", category: "activity", query: { area: "Austin", dateTime: "2026-08-02T14:00:00Z", partySize: 6, maxPriceCents: 100000 } },
];

const manifestFor = (rail: MockRail) =>
  resolveManifest({ tripId: "trip-1", tenant: "moh", intents, rail, proposals: new DeterministicProposalSource() });

describe("Orchestrator.executeStaged", () => {
  it("holds all then commits all → CONFIRMED, with hold+book audit per item", async () => {
    const rail = new MockRail({ priceCents: 8500 });
    const audit = new InMemoryAuditLog();
    const staged = await new Orchestrator(rail, new InMemoryBookingStore(), audit).executeStaged(await manifestFor(rail), { lead, now });
    expect(staged.state).toBe("CONFIRMED");
    expect(staged.results.every((r) => r.status === "confirmed")).toBe(true);
    const actions = (await audit.entries("trip-1")).map((e) => e.action);
    expect(actions.filter((a) => a === "hold")).toHaveLength(2);
    expect(actions.filter((a) => a === "book")).toHaveLength(2);
  });

  it("commits shortest-hold-TTL-first regardless of manifest order", async () => {
    const probe = new MockRail({ priceCents: 8500 });
    const manifest = await manifestFor(probe);
    const staySlot = manifest.items[0]!.chosen!.railSlotId; // manifest order: stay-1 first
    const tourSlot = manifest.items[1]!.chosen!.railSlotId;
    // Give the SECOND manifest item (tour-1) the sooner expiry ⇒ it must commit first.
    const rail = new MockRail({
      priceCents: 8500,
      holdExpiresBySlot: { [staySlot]: "2026-08-01T00:00:00.000Z", [tourSlot]: "2026-07-25T00:00:00.000Z" },
    });
    const staged = await new Orchestrator(rail, new InMemoryBookingStore()).executeStaged(manifest, { lead, now });
    expect(staged.state).toBe("CONFIRMED");
    expect(staged.committedOrder).toEqual(["tour-1", "stay-1"]);
  });

  it("aborts at PENDING_CONFIRM when spend caps are exceeded, releasing every hold (nothing booked)", async () => {
    const rail = new MockRail({ priceCents: 8500 }); // 2 items × 8500 = 17000 total
    const audit = new InMemoryAuditLog();
    const staged = await new Orchestrator(rail, new InMemoryBookingStore(), audit).executeStaged(await manifestFor(rail), { lead, now, caps: { totalCapCents: 10000 } });
    expect(staged.state).toBe("FAILED");
    expect(staged.error).toMatch(/total/i);
    expect(staged.results.some((r) => r.status === "confirmed")).toBe(false);
    expect(staged.releasedHolds).toHaveLength(2); // both holds released
    expect((await audit.entries("trip-1")).filter((e) => e.action === "release")).toHaveLength(2);
  });

  it("on a commit failure, compensates committed items AND releases still-uncommitted holds", async () => {
    const probe = new MockRail({ priceCents: 8500 });
    const manifest = await manifestFor(probe);
    const staySlot = manifest.items[0]!.chosen!.railSlotId;
    const tourSlot = manifest.items[1]!.chosen!.railSlotId;
    // tour-1 commits first (sooner expiry) and succeeds; stay-1 fails to book ⇒ tour-1 compensated.
    const rail = new MockRail({
      priceCents: 8500,
      holdExpiresBySlot: { [staySlot]: "2026-08-01T00:00:00.000Z", [tourSlot]: "2026-07-25T00:00:00.000Z" },
      failBookFor: [staySlot],
    });
    const staged = await new Orchestrator(rail, new InMemoryBookingStore()).executeStaged(manifest, { lead, now });
    expect(staged.state).toBe("FAILED");
    expect(staged.committedOrder).toEqual(["tour-1"]); // only tour-1 committed before the failure
    expect(staged.compensations.map((c) => c.itemId)).toEqual(["tour-1"]); // then compensated
    expect(await rail.status("ref-" + tourSlot)).toBe("cancelled"); // no orphan
  });

  it("treats an expired hold at commit time as a failure and unwinds", async () => {
    const probe = new MockRail({ priceCents: 8500 });
    const manifest = await manifestFor(probe);
    const rail = new MockRail({ priceCents: 8500, holdExpiresAt: "2000-01-01T00:00:00.000Z" });
    const staged = await new Orchestrator(rail, new InMemoryBookingStore()).executeStaged(manifest, { lead, now });
    expect(staged.state).toBe("FAILED");
    expect(staged.error).toMatch(/expired/i);
    expect(staged.results.some((r) => r.status === "confirmed")).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/__tests__/concierge-staged.test.ts`
Expected: FAIL — `executeStaged` is not a function.

- [ ] **Step 4: Implement in `orchestrator.ts`**

Add imports at the top (extend the existing type imports):

```ts
import type { BookingManifest, BookingRecord, BookingResult, BookingCategory } from "./types";
import { checkSpendCaps, type SpendCaps } from "./caps";
```

Add the new public types (after `SagaResult`):

```ts
export type TripState = "DRAFT" | "RESOLVING" | "HELD" | "PENDING_CONFIRM" | "COMMITTING" | "CONFIRMED" | "FAILED";

export interface StagedCtx {
  lead: { leadName: string; leadEmail: string };
  now: string; // ISO8601
  caps?: SpendCaps;
  actor?: string;
}

export interface HeldItem {
  itemId: string;
  category: BookingCategory;
  railSlotId: string;
  holdRef: string;
  expiresAt: string;
  priceCents: number;
}

export interface StagedResult {
  tripId: string;
  state: TripState;
  results: BookingResult[];
  /** itemIds in the order they were committed (shortest-hold-TTL-first) — provable. */
  committedOrder: string[];
  compensations: CompensationRecord[];
  failedCompensations: CompensationFailure[];
  /** holdRefs released without booking (uncommitted holds dropped on abort/unwind). */
  releasedHolds: string[];
  error: string | null;
}
```

Add two private helpers inside the `Orchestrator` class (after the constructor, before `execute`):

```ts
  /** Cancel every booked item, isolated per-item + audited. Shared by saga + staged paths. */
  private async compensateBooked(
    tripId: string,
    booked: { itemId: string; railRef: string }[],
    now: string,
    actor: string,
  ): Promise<{ compensations: CompensationRecord[]; failedCompensations: CompensationFailure[] }> {
    const compensations: CompensationRecord[] = [];
    const failedCompensations: CompensationFailure[] = [];
    for (const b of booked) {
      const id = bookingRecordId(tripId, b.itemId, this.rail.railId);
      try {
        const { refundAmountCents } = await this.rail.cancel(b.railRef);
        const rec = await this.store.get(id);
        if (rec) await this.store.put({ ...rec, status: "cancelled" });
        await this.audit.append({ ts: now, tripId, itemId: b.itemId, actor, action: "compensate", rail: this.rail.railId, externalRef: b.railRef, amountCents: refundAmountCents });
        compensations.push({ itemId: b.itemId, railRef: b.railRef, refundAmountCents });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.audit.append({ ts: now, tripId, itemId: b.itemId, actor, action: "compensate_failed", rail: this.rail.railId, externalRef: b.railRef, amountCents: 0, detail: msg });
        failedCompensations.push({ itemId: b.itemId, railRef: b.railRef, error: msg });
      }
    }
    return { compensations, failedCompensations };
  }

  /** Release every uncommitted hold, isolated per-item + audited. A failed release is a stuck
   *  hold (it will expire on its own) — recorded, never swallowed. */
  private async releaseHolds(
    tripId: string,
    holds: { itemId: string; holdRef: string }[],
    now: string,
    actor: string,
  ): Promise<string[]> {
    const released: string[] = [];
    for (const h of holds) {
      try {
        await this.rail.release(h.holdRef);
        await this.audit.append({ ts: now, tripId, itemId: h.itemId, actor, action: "release", rail: this.rail.railId, externalRef: h.holdRef, amountCents: 0 });
        released.push(h.holdRef);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.audit.append({ ts: now, tripId, itemId: h.itemId, actor, action: "release_failed", rail: this.rail.railId, externalRef: h.holdRef, amountCents: 0, detail: msg });
      }
    }
    return released;
  }
```

Refactor the `compensate` closure inside `executeSaga` to use the shared helper (replace its body):

```ts
    const compensate = async (error: string): Promise<SagaResult> => {
      const { compensations, failedCompensations } = await this.compensateBooked(manifest.tripId, booked, ctx.now, actor);
      return { tripId: manifest.tripId, status: "compensated", results, compensations, failedCompensations, error };
    };
```

Add `executeStaged` (after `executeSaga`):

```ts
  /** Phase 2a path: STAGED commit. Hold everything (no commitment), assemble + validate spend
   *  caps, then commit shortest-hold-TTL-first. Any failure unwinds: compensate booked items +
   *  release still-uncommitted holds. Ends CONFIRMED or FAILED; deterministic + audit-logged. */
  async executeStaged(manifest: BookingManifest, ctx: StagedCtx): Promise<StagedResult> {
    const actor = ctx.actor ?? "orchestrator";
    const results: BookingResult[] = [];
    const held: HeldItem[] = [];

    const unwind = async (
      error: string,
      booked: { itemId: string; railRef: string }[],
      remainingHolds: { itemId: string; holdRef: string }[],
    ): Promise<StagedResult> => {
      const { compensations, failedCompensations } = await this.compensateBooked(manifest.tripId, booked, ctx.now, actor);
      const releasedHolds = await this.releaseHolds(manifest.tripId, remainingHolds, ctx.now, actor);
      return { tripId: manifest.tripId, state: "FAILED", results, committedOrder: booked.map((b) => b.itemId), compensations, failedCompensations, releasedHolds, error };
    };

    // --- HELD: reserve every item, no commitment yet ---
    for (const item of manifest.items) {
      const { itemId, category } = item.intent;
      if (!item.chosen) {
        results.push({ itemId, status: "failed", confirmationCode: null, error: "no candidate chosen" });
        return unwind(`item ${itemId}: no candidate chosen`, [], held.map((h) => ({ itemId: h.itemId, holdRef: h.holdRef })));
      }
      const hold = await this.rail.hold(item.chosen.railSlotId, { partySize: item.intent.query.partySize, dateTime: item.chosen.startsAt });
      await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId, actor, action: "hold", rail: this.rail.railId, externalRef: hold.holdRef, amountCents: item.chosen.priceCents });
      held.push({ itemId, category, railSlotId: item.chosen.railSlotId, holdRef: hold.holdRef, expiresAt: hold.expiresAt, priceCents: item.chosen.priceCents });
    }

    // --- PENDING_CONFIRM: assemble priced trip + spend caps ---
    const capError = checkSpendCaps(held.map((h) => ({ category: h.category, priceCents: h.priceCents })), ctx.caps);
    if (capError) {
      return unwind(capError, [], held.map((h) => ({ itemId: h.itemId, holdRef: h.holdRef })));
    }

    // --- COMMITTING: commit non-refundables shortest-hold-TTL-first ---
    const order = [...held].sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
    const booked: { itemId: string; railRef: string }[] = [];
    const committedOrder: string[] = [];
    for (let i = 0; i < order.length; i++) {
      const h = order[i]!;
      const remaining = order.slice(i + 1).map((x) => ({ itemId: x.itemId, holdRef: x.holdRef }));
      const id = bookingRecordId(manifest.tripId, h.itemId, this.rail.railId);

      const nowMs = Date.parse(ctx.now);
      const expMs = Date.parse(h.expiresAt);
      if (Number.isNaN(expMs) || Number.isNaN(nowMs) || nowMs >= expMs) {
        results.push({ itemId: h.itemId, status: "failed", confirmationCode: null, error: "hold expired" });
        return unwind(`hold ${h.holdRef} expired at ${h.expiresAt}`, booked, remaining);
      }

      try {
        const bookedRes = await this.rail.book(h.holdRef, ctx.lead);
        booked.push({ itemId: h.itemId, railRef: bookedRes.railRef });
        committedOrder.push(h.itemId);
        const rec: BookingRecord = { id, tripId: manifest.tripId, itemId: h.itemId, rail: this.rail.railId, status: "confirmed", railRef: bookedRes.railRef, confirmationCode: bookedRes.confirmationCode, amountCents: bookedRes.amountCents, error: null };
        await this.store.put(rec);
        await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId: h.itemId, actor, action: "book", rail: this.rail.railId, externalRef: bookedRes.railRef, amountCents: bookedRes.amountCents });
        results.push({ itemId: h.itemId, status: "confirmed", confirmationCode: bookedRes.confirmationCode, error: null });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const rec: BookingRecord = { id, tripId: manifest.tripId, itemId: h.itemId, rail: this.rail.railId, status: "failed", railRef: null, confirmationCode: null, amountCents: 0, error: msg };
        await this.store.put(rec);
        await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId: h.itemId, actor, action: "book_failed", rail: this.rail.railId, externalRef: null, amountCents: 0, detail: msg });
        results.push({ itemId: h.itemId, status: "failed", confirmationCode: null, error: msg });
        return unwind(msg, booked, remaining);
      }
    }

    return { tripId: manifest.tripId, state: "CONFIRMED", results, committedOrder, compensations: [], failedCompensations: [], releasedHolds: [], error: null };
  }
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/__tests__/concierge-staged.test.ts src/__tests__/concierge-saga.test.ts src/__tests__/concierge-saga-resilience.test.ts`
Expected: PASS — staged suite (5 tests) green AND both Phase 1 saga suites still green (the `compensateBooked` extraction did not change saga behavior).

- [ ] **Step 6: Commit**

```bash
git add src/concierge/audit.ts src/concierge/orchestrator.ts src/__tests__/concierge-staged.test.ts
git commit -m "feat(concierge): staged-commit orchestrator — state machine, shortest-TTL-first, compensate+release

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Staged dry-run wiring + barrel + full gate

**Files:**
- Modify: `src/concierge/dry-run.ts`, `src/concierge/index.ts`
- Test: `src/__tests__/concierge-staged-dry-run.test.ts`

**Interfaces:**
- Produces: `interface StagedDryRunArgs { tripId: string; tenant: ConciergeTenant; intents: BookingIntent[]; now: string; priceCents?: number; caps?: SpendCaps }`; `async function runConciergeStagedDryRun(args): Promise<{ manifest: BookingManifest; staged: StagedResult; audit: AuditEntry[] }>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/concierge-staged-dry-run.test.ts
import { describe, it, expect } from "vitest";
import { runConciergeStagedDryRun } from "../concierge/dry-run";
import type { BookingIntent } from "../concierge/types";

const intents: BookingIntent[] = [
  { itemId: "stay-1", category: "lodging", query: { area: "Nashville", dateTime: "2026-08-01T15:00:00Z", partySize: 6, maxPriceCents: 100000 } },
  { itemId: "tour-1", category: "activity", query: { area: "Austin", dateTime: "2026-08-02T14:00:00Z", partySize: 6, maxPriceCents: 100000 } },
];

describe("runConciergeStagedDryRun", () => {
  it("turns a mixed itinerary into a CONFIRMED staged trip within caps", async () => {
    const { manifest, staged } = await runConciergeStagedDryRun({
      tripId: "trip-dry-2",
      tenant: "moh",
      intents,
      now: "2026-07-20T12:00:00.000Z",
      priceCents: 8500,
      caps: { totalCapCents: 100000 },
    });
    expect(manifest.items).toHaveLength(2);
    expect(staged.state).toBe("CONFIRMED");
    expect(staged.committedOrder).toHaveLength(2);
  });

  it("FAILS and books nothing when the trip breaches the total cap", async () => {
    const { staged } = await runConciergeStagedDryRun({
      tripId: "trip-dry-3",
      tenant: "moh",
      intents,
      now: "2026-07-20T12:00:00.000Z",
      priceCents: 8500,
      caps: { totalCapCents: 10000 },
    });
    expect(staged.state).toBe("FAILED");
    expect(staged.results.some((r) => r.status === "confirmed")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/concierge-staged-dry-run.test.ts`
Expected: FAIL — `runConciergeStagedDryRun` is not exported.

- [ ] **Step 3: Implement in `dry-run.ts`**

Extend the imports (merge into existing lines):

```ts
import { resolveDining, resolveActivities, resolveManifest, DeterministicProposalSource } from "./resolver";
import type { SagaResult, StagedResult } from "./orchestrator";
import type { SpendCaps } from "./caps";
```

Append:

```ts
export interface StagedDryRunArgs {
  tripId: string;
  tenant: ConciergeTenant;
  intents: BookingIntent[];
  now: string; // ISO8601
  priceCents?: number;
  caps?: SpendCaps;
}

/** Wires resolveManifest + staged Orchestrator + paid MockRail + in-memory store + audit —
 *  zero external calls. The CI-provable Phase 2a "hold-all → cap-check → commit-shortest-TTL-first
 *  → unwind-on-failure" loop for a mixed lodging+activity itinerary. */
export async function runConciergeStagedDryRun(
  args: StagedDryRunArgs,
): Promise<{ manifest: BookingManifest; staged: StagedResult; audit: AuditEntry[] }> {
  const rail = new MockRail({ priceCents: args.priceCents ?? 8500 });
  const manifest = await resolveManifest({
    tripId: args.tripId,
    tenant: args.tenant,
    intents: args.intents,
    rail,
    proposals: new DeterministicProposalSource(),
  });
  const audit = new InMemoryAuditLog();
  const staged = await new Orchestrator(rail, new InMemoryBookingStore(), audit).executeStaged(manifest, {
    lead: { leadName: "Trip Lead", leadEmail: "lead@example.com" },
    now: args.now,
    caps: args.caps,
  });
  return { manifest, staged, audit: await audit.entries(args.tripId) };
}
```

- [ ] **Step 4: Add barrel export**

In `src/concierge/index.ts`, add:

```ts
export * from "./caps";
```

- [ ] **Step 5: Run the full gate**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx vitest run`
Expected: PASS — all suites (Phase 0/1's 44 + rail-contract release additions + caps 5 + resolve-manifest 2 + staged 5 + staged-dry-run 2).

- [ ] **Step 6: Commit**

```bash
git add src/concierge/dry-run.ts src/concierge/index.ts src/__tests__/concierge-staged-dry-run.test.ts
git commit -m "feat(concierge): staged dry-run wiring + caps barrel export (mixed-itinerary loop proven)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review (against master spec §3.3 state machine, §4 correctness spine, §9 Phase 2 "commit engine" row)

- **§3.3 state machine (HELD→PENDING_CONFIRM→COMMITTING→CONFIRMED/FAILED):** `executeStaged` walks these phases explicitly; `StagedResult.state` reports the terminal state. ✅
- **§3.3 "commit non-refundables shortest-hold-TTL-first":** commit loop sorts by `Date.parse(expiresAt)`; `committedOrder` proves it (Task 4 test). ✅
- **§4.5 hold-expiry is a first-class event:** epoch-compared at commit time; expiry unwinds (compensate + release). ✅
- **§4.3 saga + compensating actions / no-orphan:** commit failure compensates booked items; abort/over-budget/expiry releases uncommitted holds. Both isolated + audited (`compensateBooked`/`releaseHolds`). ✅
- **Spend caps (§3.2 authorization gate — the caps portion):** `checkSpendCaps` enforces total + per-category at PENDING_CONFIRM. ✅ (Card-authorization handoff itself is deferred to 2b/site.)
- **§4.4 append-only audit:** hold/book/compensate/release + their `_failed` variants all logged; `AuditLog` still append-only. ✅
- **Determinism:** `now` injected; all comparisons via `Date.parse`; ordering from `expiresAt`; no `Date.now`/`Math.random`. ✅
- **DRY:** compensation logic shared by saga + staged via `compensateBooked`; single-category resolvers delegate to `resolveManifest`. ✅
- **Placeholder scan:** every code step is complete; no TODO/TBD. ✅
- **Type consistency:** `TripState`/`StagedCtx`/`HeldItem`/`StagedResult`/`SpendCaps`/`checkSpendCaps`/`resolveManifest` used identically across tasks; `release` signature matches interface + all impls. ✅

**Deferred (later 2x sub-phases, per master spec §9):** LiteAPI lodging adapter + villa deeplink (2b); Supabase-backed store/audit + transactional outbox (2c); change/cancel subsystem (2d); card-authorization UX + LiteAPI Payment SDK 3DS handoff (2b/site). The **§4.2 transactional outbox** is explicitly NOT in 2a — `executeStaged` is in-memory; the outbox lands with persistence in 2c. Flagged so the "exactly-once external call" guarantee isn't assumed present yet.

**Counsel note:** still no real money, no deploy, no site mount — MockRail only. Consistent with the build-on-branch-until-hardened-then-counsel-then-live directive.
