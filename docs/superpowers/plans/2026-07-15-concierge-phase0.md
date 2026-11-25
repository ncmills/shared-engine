# Planner Concierge Engine — Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the core loop — a *deterministic* engine turns a planner-site itinerary into confirmed bookings on a pluggable rail, tenant-agnostically, with the LLM confined to proposing — using dining (no money) and `MockRail`, provable end-to-end in CI.

**Architecture:** A new `src/concierge/` module in `shared-engine`. A `BookingRail` interface abstracts every rail; `MockRail` (and a fetch-based `OpenTableAdapter`) implement it. A `Resolver` turns itinerary dining items into a `BookingManifest` by asking a `ProposalSource` to rank rail candidates and a deterministic guardrail to validate the choice. An `Orchestrator` executes the manifest idempotently against an injected `BookingStore`. No money, no persistence to Supabase yet (in-memory store), no LLM yet (deterministic `ProposalSource`) — every seam is in place for later phases to drop those in.

**Tech Stack:** TypeScript, vitest (`npx vitest run`), `tsc --noEmit`. No new runtime dependencies (use global `fetch`).

## Global Constraints

- **Tenants are `'moh' | 'bestman' | 'handicaphq'` only.** Offsite Outpost (`'offsite'`) and `'tdf'` are NOT valid concierge tenants and must be unrepresentable at the type level.
- **The LLM (and any `ProposalSource`) may only *propose*; it may never call `hold`/`book`/`cancel`.** Only the `Orchestrator` calls booking methods. Enforced by module boundaries.
- **Determinism:** no `Math.random()` / `Date.now()` / argless `new Date()` in engine code — derive ids/ordering from inputs; take any "now" as an explicit parameter. (Matches repo's existing pure-module style and keeps tests deterministic.)
- **All money amounts are integer cents.** Phase 0 dining is always `priceCents: 0`.
- **Follow repo conventions:** tests in `src/__tests__/concierge-*.test.ts`, `import` from `../concierge/<file>`, `describe/it/expect` from `vitest`. Export new public surface through `src/index.ts`.
- **Commit trailer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

- `src/concierge/tenant.ts` — `ConciergeTenant`, `ConciergeTenantConfig`, the three tenant configs, `getConciergeTenantConfig()`.
- `src/concierge/types.ts` — domain types (`BookingCategory`, `BookingIntent`, `RailSlot`, `CancellationPolicy`, `BookingManifest`, `ManifestItem`, `BookingRecord`, `BookingResult`, `BookingStatus`).
- `src/concierge/rail.ts` — `BookingRail` interface + `RailSearchQuery`, `HoldResult`, `BookResult`.
- `src/concierge/mock-rail.ts` — `MockRail` (deterministic in-memory rail).
- `src/concierge/resolver.ts` — `ProposalSource`, `DeterministicProposalSource`, `validateChoice` guardrail, `resolveDining()`.
- `src/concierge/orchestrator.ts` — `BookingStore`, `InMemoryBookingStore`, `Orchestrator`.
- `src/concierge/opentable-adapter.ts` — `OpenTableAdapter` (fetch-based `BookingRail`).
- `src/concierge/dry-run.ts` — `runConciergeDryRun()` wiring the whole loop.
- `src/concierge/index.ts` — module barrel.
- `src/index.ts` — add `export * from './concierge'`.
- Tests: `src/__tests__/concierge-{tenant,rail-contract,resolver,orchestrator,dry-run,opentable}.test.ts`.

---

## Task 1: Concierge tenant config

**Files:**
- Create: `src/concierge/tenant.ts`
- Test: `src/__tests__/concierge-tenant.test.ts`

**Interfaces:**
- Produces: `type ConciergeTenant = 'moh' | 'bestman' | 'handicaphq'`; `interface ConciergeTenantConfig`; `function getConciergeTenantConfig(t: ConciergeTenant): ConciergeTenantConfig`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/concierge-tenant.test.ts
import { describe, it, expect } from "vitest";
import { getConciergeTenantConfig, type ConciergeTenant } from "../concierge/tenant";

describe("concierge tenant config", () => {
  it("returns config for the three valid tenants", () => {
    const tenants: ConciergeTenant[] = ["moh", "bestman", "handicaphq"];
    for (const t of tenants) {
      const cfg = getConciergeTenantConfig(t);
      expect(cfg.tenant).toBe(t);
      expect(cfg.categories).toContain("dining");
      expect(cfg.feeAmountCents).toBeGreaterThan(0);
      expect(cfg.currency).toBe("USD");
    }
  });

  it("gives handicaphq a golf category, moh/bestman do not", () => {
    expect(getConciergeTenantConfig("handicaphq").categories).toContain("golf");
    expect(getConciergeTenantConfig("moh").categories).not.toContain("golf");
  });

  it("throws for an unknown tenant", () => {
    // @ts-expect-error offsite is not a concierge tenant
    expect(() => getConciergeTenantConfig("offsite")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/concierge-tenant.test.ts`
Expected: FAIL — cannot find module `../concierge/tenant`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/concierge/tenant.ts
import type { BookingCategory, CurrencyCode } from "./types";

// OO ('offsite') and 'tdf' are intentionally NOT concierge tenants.
export type ConciergeTenant = "moh" | "bestman" | "handicaphq";

export interface ConciergeTenantConfig {
  tenant: ConciergeTenant;
  tripNoun: string;
  categories: BookingCategory[];
  /** category -> rail id used for this tenant */
  railConfig: Partial<Record<BookingCategory, string>>;
  feeAmountCents: number;
  currency: CurrencyCode;
  tosRef: string;
}

const CONFIGS: Record<ConciergeTenant, ConciergeTenantConfig> = {
  moh: {
    tenant: "moh",
    tripNoun: "bachelorette trip",
    categories: ["lodging", "activity", "dining"],
    railConfig: { lodging: "liteapi", activity: "getyourguide", dining: "opentable" },
    feeAmountCents: 7900,
    currency: "USD",
    tosRef: "moh-concierge-tos-v1",
  },
  bestman: {
    tenant: "bestman",
    tripNoun: "bachelor party",
    categories: ["lodging", "activity", "dining"],
    railConfig: { lodging: "liteapi", activity: "getyourguide", dining: "opentable" },
    feeAmountCents: 7900,
    currency: "USD",
    tosRef: "bestman-concierge-tos-v1",
  },
  handicaphq: {
    tenant: "handicaphq",
    tripNoun: "golf trip",
    categories: ["lodging", "activity", "dining", "golf"],
    railConfig: { lodging: "liteapi", activity: "getyourguide", dining: "opentable" },
    feeAmountCents: 9900,
    currency: "USD",
    tosRef: "handicaphq-concierge-tos-v1",
  },
};

export function getConciergeTenantConfig(tenant: ConciergeTenant): ConciergeTenantConfig {
  const cfg = CONFIGS[tenant];
  if (!cfg) throw new Error(`Unknown concierge tenant: ${tenant}`);
  return cfg;
}
```

- [ ] **Step 4: Create the types module stub so this compiles**

Create `src/concierge/types.ts` with just the two types this task references (Task 2 fills in the rest):

```ts
// src/concierge/types.ts
export type CurrencyCode = "USD";
export type BookingCategory = "lodging" | "activity" | "dining" | "golf";
```

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run src/__tests__/concierge-tenant.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/concierge/tenant.ts src/concierge/types.ts src/__tests__/concierge-tenant.test.ts
git commit -m "feat(concierge): tenant config (moh/bestman/handicaphq; OO excluded)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Core domain types

**Files:**
- Modify: `src/concierge/types.ts` (append to the stub from Task 1)
- Test: `src/__tests__/concierge-types.test.ts`

**Interfaces:**
- Produces: `CancellationPolicy`, `RailSlot`, `BookingIntent`, `ManifestItem`, `BookingManifest`, `BookingStatus`, `BookingRecord`, `BookingResult`, and `bookingRecordId()`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/concierge-types.test.ts
import { describe, it, expect } from "vitest";
import { bookingRecordId } from "../concierge/types";

describe("bookingRecordId", () => {
  it("is deterministic and unique per (trip,item,rail)", () => {
    expect(bookingRecordId("t1", "i1", "mock")).toBe("t1:i1:mock");
    expect(bookingRecordId("t1", "i1", "mock")).toBe(bookingRecordId("t1", "i1", "mock"));
    expect(bookingRecordId("t1", "i2", "mock")).not.toBe(bookingRecordId("t1", "i1", "mock"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/concierge-types.test.ts`
Expected: FAIL — `bookingRecordId` not exported.

- [ ] **Step 3: Append implementation to `src/concierge/types.ts`**

```ts
// --- append below the Task 1 stub in src/concierge/types.ts ---

export interface CancellationPolicy {
  refundable: boolean;
  /** ISO8601 UTC deadline for a free cancel, or null if non-refundable / N/A */
  freeCancelUntil: string | null;
  refundAmountCents: number | null;
}

export interface RailSlot {
  railSlotId: string;
  label: string;
  priceCents: number; // 0 for dining
  startsAt: string; // ISO8601
  cancellation: CancellationPolicy;
}

export interface BookingIntent {
  itemId: string;
  category: BookingCategory;
  query: {
    area: string;
    dateTime: string; // ISO8601
    partySize: number;
    keywords?: string[];
    maxPriceCents?: number;
  };
}

export interface ManifestItem {
  intent: BookingIntent;
  candidates: RailSlot[];
  chosen: RailSlot | null;
  rail: string;
}

export interface BookingManifest {
  tripId: string;
  tenant: string;
  items: ManifestItem[];
}

export type BookingStatus = "pending" | "held" | "confirmed" | "failed" | "cancelled";

export interface BookingRecord {
  id: string; // bookingRecordId(tripId,itemId,rail)
  tripId: string;
  itemId: string;
  rail: string;
  status: BookingStatus;
  railRef: string | null;
  confirmationCode: string | null;
  amountCents: number;
  error: string | null;
}

export interface BookingResult {
  itemId: string;
  status: BookingStatus;
  confirmationCode: string | null;
  error: string | null;
}

export function bookingRecordId(tripId: string, itemId: string, rail: string): string {
  return `${tripId}:${itemId}:${rail}`;
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/__tests__/concierge-types.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/concierge/types.ts src/__tests__/concierge-types.test.ts
git commit -m "feat(concierge): core domain types + deterministic bookingRecordId

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: BookingRail interface

**Files:**
- Create: `src/concierge/rail.ts`
- Test: covered by the contract suite in Task 5 (interface-only task; no standalone test).

**Interfaces:**
- Produces: `RailSearchQuery`, `HoldResult`, `BookResult`, `BookingRail`.

- [ ] **Step 1: Write the interface**

```ts
// src/concierge/rail.ts
import type { RailSlot, CancellationPolicy, BookingStatus } from "./types";

export interface RailSearchQuery {
  area: string;
  dateTime: string;
  partySize: number;
  keywords?: string[];
  maxPriceCents?: number;
}

export interface HoldResult {
  holdRef: string;
  expiresAt: string; // ISO8601
  slot: RailSlot;
}

export interface BookResult {
  railRef: string;
  confirmationCode: string;
  amountCents: number;
}

/** Every rail (mock, OpenTable, LiteAPI, GetYourGuide) implements this. */
export interface BookingRail {
  readonly railId: string;
  search(q: RailSearchQuery): Promise<RailSlot[]>;
  getCancellationPolicy(railSlotId: string): Promise<CancellationPolicy>;
  hold(railSlotId: string, ctx: { partySize: number; dateTime: string }): Promise<HoldResult>;
  book(holdRef: string, ctx: { leadName: string; leadEmail: string }): Promise<BookResult>;
  cancel(railRef: string): Promise<{ refundAmountCents: number }>;
  status(railRef: string): Promise<BookingStatus>;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/concierge/rail.ts
git commit -m "feat(concierge): BookingRail interface

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: MockRail

**Files:**
- Create: `src/concierge/mock-rail.ts`
- Test: `src/__tests__/concierge-mock-rail.test.ts`

**Interfaces:**
- Consumes: `BookingRail`, `RailSearchQuery`, `HoldResult`, `BookResult` (Task 3); `RailSlot` (Task 2).
- Produces: `class MockRail implements BookingRail` with constructor `new MockRail(opts?: { failBookFor?: string[] })`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/concierge-mock-rail.test.ts
import { describe, it, expect } from "vitest";
import { MockRail } from "../concierge/mock-rail";

const lead = { leadName: "Ada", leadEmail: "ada@example.com" };

describe("MockRail", () => {
  it("search is deterministic for identical queries", async () => {
    const rail = new MockRail();
    const q = { area: "Nashville", dateTime: "2026-08-01T19:00:00Z", partySize: 8 };
    const a = await rail.search(q);
    const b = await rail.search(q);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
    expect(a[0].priceCents).toBe(0);
  });

  it("hold then book yields a confirmation", async () => {
    const rail = new MockRail();
    const [slot] = await rail.search({ area: "Austin", dateTime: "2026-08-01T19:00:00Z", partySize: 6 });
    const held = await rail.hold(slot.railSlotId, { partySize: 6, dateTime: slot.startsAt });
    const booked = await rail.book(held.holdRef, lead);
    expect(booked.confirmationCode).toMatch(/^MOCK-/);
    expect(await rail.status(booked.railRef)).toBe("confirmed");
  });

  it("book fails for slots flagged to fail", async () => {
    const rail = new MockRail({ failBookFor: ["FAILME"] });
    const held = await rail.hold("FAILME", { partySize: 2, dateTime: "2026-08-01T19:00:00Z" });
    await expect(rail.book(held.holdRef, lead)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/concierge-mock-rail.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/concierge/mock-rail.ts
import type { BookingRail, RailSearchQuery, HoldResult, BookResult } from "./rail";
import type { RailSlot, CancellationPolicy, BookingStatus } from "./types";

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const FREE_CANCEL: CancellationPolicy = {
  refundable: true,
  freeCancelUntil: null,
  refundAmountCents: 0,
};

export class MockRail implements BookingRail {
  readonly railId = "mock";
  private booked = new Set<string>();
  private holdToSlot = new Map<string, string>();
  constructor(private opts: { failBookFor?: string[] } = {}) {}

  async search(q: RailSearchQuery): Promise<RailSlot[]> {
    const seed = hashStr(`${q.area}|${q.dateTime}|${q.partySize}`);
    const n = 3;
    return Array.from({ length: n }, (_, i) => ({
      railSlotId: `${q.area}-${(seed + i) % 1000}`,
      label: `${q.area} dining option ${i + 1}`,
      priceCents: 0,
      startsAt: q.dateTime,
      cancellation: FREE_CANCEL,
    }));
  }

  async getCancellationPolicy(): Promise<CancellationPolicy> {
    return FREE_CANCEL;
  }

  async hold(railSlotId: string, ctx: { partySize: number; dateTime: string }): Promise<HoldResult> {
    const holdRef = `hold-${railSlotId}`;
    this.holdToSlot.set(holdRef, railSlotId);
    return {
      holdRef,
      expiresAt: ctx.dateTime,
      slot: {
        railSlotId,
        label: railSlotId,
        priceCents: 0,
        startsAt: ctx.dateTime,
        cancellation: FREE_CANCEL,
      },
    };
  }

  async book(holdRef: string): Promise<BookResult> {
    const slotId = this.holdToSlot.get(holdRef) ?? holdRef.replace(/^hold-/, "");
    if (this.opts.failBookFor?.includes(slotId)) {
      throw new Error(`MockRail: booking refused for ${slotId}`);
    }
    const railRef = `ref-${slotId}`;
    this.booked.add(railRef);
    return { railRef, confirmationCode: `MOCK-${slotId}`, amountCents: 0 };
  }

  async cancel(railRef: string): Promise<{ refundAmountCents: number }> {
    this.booked.delete(railRef);
    return { refundAmountCents: 0 };
  }

  async status(railRef: string): Promise<BookingStatus> {
    return this.booked.has(railRef) ? "confirmed" : "cancelled";
  }
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/__tests__/concierge-mock-rail.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/concierge/mock-rail.ts src/__tests__/concierge-mock-rail.test.ts
git commit -m "feat(concierge): deterministic MockRail

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: BookingRail contract suite

**Files:**
- Create: `src/concierge/rail-contract.ts` (reusable contract test helper)
- Test: `src/__tests__/concierge-rail-contract.test.ts`

**Interfaces:**
- Produces: `function runBookingRailContract(name: string, makeRail: () => BookingRail): void` — later adapters (OpenTable, LiteAPI, GetYourGuide) call this to prove they satisfy the interface.

- [ ] **Step 1: Write the contract helper**

```ts
// src/concierge/rail-contract.ts
import { describe, it, expect } from "vitest";
import type { BookingRail } from "./rail";

export function runBookingRailContract(name: string, makeRail: () => BookingRail): void {
  describe(`BookingRail contract: ${name}`, () => {
    const q = { area: "Testville", dateTime: "2026-08-01T19:00:00Z", partySize: 4 };

    it("search returns slots with required fields", async () => {
      const slots = await makeRail().search(q);
      expect(slots.length).toBeGreaterThan(0);
      for (const s of slots) {
        expect(typeof s.railSlotId).toBe("string");
        expect(typeof s.priceCents).toBe("number");
        expect(s.cancellation).toBeDefined();
      }
    });

    it("hold -> book -> status(confirmed) -> cancel", async () => {
      const rail = makeRail();
      const [slot] = await rail.search(q);
      const held = await rail.hold(slot.railSlotId, { partySize: 4, dateTime: slot.startsAt });
      expect(held.holdRef).toBeTruthy();
      const booked = await rail.book(held.holdRef, { leadName: "T", leadEmail: "t@e.com" });
      expect(booked.confirmationCode).toBeTruthy();
      expect(await rail.status(booked.railRef)).toBe("confirmed");
      const refund = await rail.cancel(booked.railRef);
      expect(typeof refund.refundAmountCents).toBe("number");
    });
  });
}
```

- [ ] **Step 2: Wire the contract to MockRail**

```ts
// src/__tests__/concierge-rail-contract.test.ts
import { runBookingRailContract } from "../concierge/rail-contract";
import { MockRail } from "../concierge/mock-rail";

runBookingRailContract("MockRail", () => new MockRail());
```

- [ ] **Step 3: Run test + typecheck**

Run: `npx vitest run src/__tests__/concierge-rail-contract.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/concierge/rail-contract.ts src/__tests__/concierge-rail-contract.test.ts
git commit -m "test(concierge): reusable BookingRail contract suite (MockRail passes)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Resolver (proposal + guardrail + resolveDining)

**Files:**
- Create: `src/concierge/resolver.ts`
- Test: `src/__tests__/concierge-resolver.test.ts`

**Interfaces:**
- Consumes: `BookingRail` (Task 3); `BookingIntent`, `RailSlot`, `ManifestItem`, `BookingManifest` (Task 2).
- Produces: `interface ProposalSource { rank(intent, candidates): Promise<RailSlot[]> }`; `class DeterministicProposalSource implements ProposalSource`; `function validateChoice(intent, chosen): string | null` (returns error or null); `function resolveDining(args): Promise<BookingManifest>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/concierge-resolver.test.ts
import { describe, it, expect } from "vitest";
import { resolveDining, DeterministicProposalSource, validateChoice } from "../concierge/resolver";
import { MockRail } from "../concierge/mock-rail";
import type { BookingIntent } from "../concierge/types";

const intents: BookingIntent[] = [
  { itemId: "dinner-1", category: "dining", query: { area: "Nashville", dateTime: "2026-08-01T19:00:00Z", partySize: 8 } },
];

describe("resolveDining", () => {
  it("produces a manifest with a chosen slot per intent", async () => {
    const manifest = await resolveDining({
      tripId: "trip-1",
      tenant: "moh",
      intents,
      rail: new MockRail(),
      proposals: new DeterministicProposalSource(),
    });
    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0].chosen).not.toBeNull();
    expect(manifest.items[0].rail).toBe("mock");
  });

  it("guardrail rejects a chosen slot over the max price", () => {
    const err = validateChoice(
      { itemId: "x", category: "dining", query: { area: "A", dateTime: "2026-08-01T19:00:00Z", partySize: 2, maxPriceCents: 100 } },
      { railSlotId: "s", label: "s", priceCents: 500, startsAt: "2026-08-01T19:00:00Z", cancellation: { refundable: true, freeCancelUntil: null, refundAmountCents: 0 } }
    );
    expect(err).toMatch(/exceeds/i);
  });

  it("leaves chosen null when no candidate passes the guardrail", async () => {
    const manifest = await resolveDining({
      tripId: "trip-2",
      tenant: "moh",
      intents: [{ itemId: "d", category: "dining", query: { area: "Z", dateTime: "2026-08-01T19:00:00Z", partySize: 2, maxPriceCents: -1 } }],
      rail: new MockRail(),
      proposals: new DeterministicProposalSource(),
    });
    expect(manifest.items[0].chosen).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/concierge-resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/concierge/resolver.ts
import type { BookingRail } from "./rail";
import type { BookingIntent, RailSlot, ManifestItem, BookingManifest } from "./types";

/** Ranks candidate slots for an intent. The LLM implementation slots in here later;
 *  it may ONLY rank/propose — it never books. */
export interface ProposalSource {
  rank(intent: BookingIntent, candidates: RailSlot[]): Promise<RailSlot[]>;
}

export class DeterministicProposalSource implements ProposalSource {
  async rank(intent: BookingIntent, candidates: RailSlot[]): Promise<RailSlot[]> {
    return [...candidates].sort(
      (a, b) => a.priceCents - b.priceCents || a.startsAt.localeCompare(b.startsAt),
    );
  }
}

/** Deterministic guardrail. Returns an error string if the choice is invalid, else null. */
export function validateChoice(intent: BookingIntent, chosen: RailSlot): string | null {
  const max = intent.query.maxPriceCents;
  if (max != null && chosen.priceCents > max) {
    return `price ${chosen.priceCents} exceeds max ${max}`;
  }
  if (!chosen.cancellation) return "missing cancellation policy";
  return null;
}

export interface ResolveDiningArgs {
  tripId: string;
  tenant: string;
  intents: BookingIntent[];
  rail: BookingRail;
  proposals: ProposalSource;
}

export async function resolveDining(args: ResolveDiningArgs): Promise<BookingManifest> {
  const items: ManifestItem[] = [];
  for (const intent of args.intents) {
    const candidates = await args.rail.search(intent.query);
    const ranked = await args.proposals.rank(intent, candidates);
    const chosen = ranked.find((c) => validateChoice(intent, c) === null) ?? null;
    items.push({ intent, candidates, chosen, rail: args.rail.railId });
  }
  return { tripId: args.tripId, tenant: args.tenant, items };
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/__tests__/concierge-resolver.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/concierge/resolver.ts src/__tests__/concierge-resolver.test.ts
git commit -m "feat(concierge): resolver with proposal seam + deterministic guardrail

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Orchestrator + BookingStore

**Files:**
- Create: `src/concierge/orchestrator.ts`
- Test: `src/__tests__/concierge-orchestrator.test.ts`

**Interfaces:**
- Consumes: `BookingRail` (Task 3); `BookingManifest`, `BookingRecord`, `BookingResult`, `bookingRecordId` (Task 2).
- Produces: `interface BookingStore { get(id): Promise<BookingRecord | null>; put(rec): Promise<void>; all(tripId): Promise<BookingRecord[]> }`; `class InMemoryBookingStore implements BookingStore`; `class Orchestrator` with `execute(manifest, ctx): Promise<BookingResult[]>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/concierge-orchestrator.test.ts
import { describe, it, expect } from "vitest";
import { Orchestrator, InMemoryBookingStore } from "../concierge/orchestrator";
import { resolveDining, DeterministicProposalSource } from "../concierge/resolver";
import { MockRail } from "../concierge/mock-rail";
import type { BookingIntent } from "../concierge/types";

const lead = { leadName: "Ada", leadEmail: "ada@example.com" };
const intents: BookingIntent[] = [
  { itemId: "dinner-1", category: "dining", query: { area: "Nashville", dateTime: "2026-08-01T19:00:00Z", partySize: 8 } },
  { itemId: "dinner-2", category: "dining", query: { area: "Austin", dateTime: "2026-08-02T19:00:00Z", partySize: 8 } },
];

async function manifestFor(rail: MockRail) {
  return resolveDining({ tripId: "trip-1", tenant: "moh", intents, rail, proposals: new DeterministicProposalSource() });
}

describe("Orchestrator", () => {
  it("books every chosen item and records confirmations", async () => {
    const rail = new MockRail();
    const store = new InMemoryBookingStore();
    const results = await new Orchestrator(rail, store).execute(await manifestFor(rail), { lead });
    expect(results.every((r) => r.status === "confirmed")).toBe(true);
    expect((await store.all("trip-1")).length).toBe(2);
  });

  it("is idempotent — re-running does not double-book", async () => {
    const rail = new MockRail();
    const store = new InMemoryBookingStore();
    const orch = new Orchestrator(rail, store);
    const manifest = await manifestFor(rail);
    await orch.execute(manifest, { lead });
    await orch.execute(manifest, { lead });
    expect((await store.all("trip-1")).length).toBe(2); // not 4
  });

  it("isolates a single failure without aborting the run", async () => {
    // Force dinner-1's chosen slot to fail booking.
    const rail = new MockRail();
    const manifest = await manifestFor(rail);
    const failingSlot = manifest.items[0].chosen!.railSlotId;
    const failingRail = new MockRail({ failBookFor: [failingSlot] });
    const store = new InMemoryBookingStore();
    const results = await new Orchestrator(failingRail, store).execute(manifest, { lead });
    const byId = Object.fromEntries(results.map((r) => [r.itemId, r.status]));
    expect(byId["dinner-1"]).toBe("failed");
    expect(byId["dinner-2"]).toBe("confirmed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/concierge-orchestrator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/concierge/orchestrator.ts
import type { BookingRail } from "./rail";
import type { BookingManifest, BookingRecord, BookingResult } from "./types";
import { bookingRecordId } from "./types";

export interface BookingStore {
  get(id: string): Promise<BookingRecord | null>;
  put(rec: BookingRecord): Promise<void>;
  all(tripId: string): Promise<BookingRecord[]>;
}

export class InMemoryBookingStore implements BookingStore {
  private map = new Map<string, BookingRecord>();
  async get(id: string): Promise<BookingRecord | null> {
    return this.map.get(id) ?? null;
  }
  async put(rec: BookingRecord): Promise<void> {
    this.map.set(rec.id, rec);
  }
  async all(tripId: string): Promise<BookingRecord[]> {
    return [...this.map.values()].filter((r) => r.tripId === tripId);
  }
}

export interface ExecuteCtx {
  lead: { leadName: string; leadEmail: string };
}

export class Orchestrator {
  constructor(private rail: BookingRail, private store: BookingStore) {}

  async execute(manifest: BookingManifest, ctx: ExecuteCtx): Promise<BookingResult[]> {
    const results: BookingResult[] = [];
    for (const item of manifest.items) {
      const { itemId } = item.intent;
      const id = bookingRecordId(manifest.tripId, itemId, this.rail.railId);

      // Idempotency: if already confirmed, return the existing record.
      const existing = await this.store.get(id);
      if (existing && existing.status === "confirmed") {
        results.push({ itemId, status: "confirmed", confirmationCode: existing.confirmationCode, error: null });
        continue;
      }

      if (!item.chosen) {
        const rec: BookingRecord = { id, tripId: manifest.tripId, itemId, rail: this.rail.railId, status: "failed", railRef: null, confirmationCode: null, amountCents: 0, error: "no candidate chosen" };
        await this.store.put(rec);
        results.push({ itemId, status: "failed", confirmationCode: null, error: rec.error });
        continue;
      }

      try {
        const held = await this.rail.hold(item.chosen.railSlotId, { partySize: item.intent.query.partySize, dateTime: item.chosen.startsAt });
        const booked = await this.rail.book(held.holdRef, ctx.lead);
        const rec: BookingRecord = { id, tripId: manifest.tripId, itemId, rail: this.rail.railId, status: "confirmed", railRef: booked.railRef, confirmationCode: booked.confirmationCode, amountCents: booked.amountCents, error: null };
        await this.store.put(rec);
        results.push({ itemId, status: "confirmed", confirmationCode: booked.confirmationCode, error: null });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const rec: BookingRecord = { id, tripId: manifest.tripId, itemId, rail: this.rail.railId, status: "failed", railRef: null, confirmationCode: null, amountCents: 0, error: msg };
        await this.store.put(rec);
        results.push({ itemId, status: "failed", confirmationCode: null, error: msg });
      }
    }
    return results;
  }
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/__tests__/concierge-orchestrator.test.ts && npx tsc --noEmit`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add src/concierge/orchestrator.ts src/__tests__/concierge-orchestrator.test.ts
git commit -m "feat(concierge): idempotent orchestrator + in-memory booking store

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Dry-run wiring + barrel export (the wedge proof)

**Files:**
- Create: `src/concierge/dry-run.ts`
- Create: `src/concierge/index.ts`
- Modify: `src/index.ts` (add one line)
- Test: `src/__tests__/concierge-dry-run.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `function runConciergeDryRun(args): Promise<{ manifest: BookingManifest; results: BookingResult[] }>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/concierge-dry-run.test.ts
import { describe, it, expect } from "vitest";
import { runConciergeDryRun } from "../concierge/dry-run";
import type { BookingIntent } from "../concierge/types";

const intents: BookingIntent[] = [
  { itemId: "welcome-dinner", category: "dining", query: { area: "Nashville", dateTime: "2026-08-01T19:00:00Z", partySize: 10 } },
  { itemId: "brunch", category: "dining", query: { area: "Nashville", dateTime: "2026-08-02T11:00:00Z", partySize: 10 } },
];

describe("runConciergeDryRun (wedge proof)", () => {
  it("turns dining intents into confirmed bookings end-to-end, no external calls", async () => {
    const { manifest, results } = await runConciergeDryRun({ tripId: "moh-demo", tenant: "moh", intents });
    expect(manifest.items).toHaveLength(2);
    expect(results.map((r) => r.status)).toEqual(["confirmed", "confirmed"]);
    expect(results.every((r) => r.confirmationCode?.startsWith("MOCK-"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/concierge-dry-run.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the wiring**

```ts
// src/concierge/dry-run.ts
import { MockRail } from "./mock-rail";
import { resolveDining, DeterministicProposalSource } from "./resolver";
import { Orchestrator, InMemoryBookingStore } from "./orchestrator";
import type { BookingIntent, BookingManifest, BookingResult } from "./types";

export interface DryRunArgs {
  tripId: string;
  tenant: string;
  intents: BookingIntent[];
}

/** Wires Resolver + Orchestrator + MockRail + in-memory store — zero external calls.
 *  This is the CI-provable "itinerary -> real bookings" loop for Phase 0. */
export async function runConciergeDryRun(
  args: DryRunArgs,
): Promise<{ manifest: BookingManifest; results: BookingResult[] }> {
  const rail = new MockRail();
  const manifest = await resolveDining({
    tripId: args.tripId,
    tenant: args.tenant,
    intents: args.intents,
    rail,
    proposals: new DeterministicProposalSource(),
  });
  const results = await new Orchestrator(rail, new InMemoryBookingStore()).execute(manifest, {
    lead: { leadName: "Trip Lead", leadEmail: "lead@example.com" },
  });
  return { manifest, results };
}
```

```ts
// src/concierge/index.ts
export * from "./types";
export * from "./tenant";
export * from "./rail";
export * from "./mock-rail";
export * from "./resolver";
export * from "./orchestrator";
export * from "./dry-run";
export * from "./opentable-adapter";
```

- [ ] **Step 4: Add the barrel export to `src/index.ts`**

Add this line to `src/index.ts` (alongside the other `export *` lines):

```ts
export * from './concierge';
```

- [ ] **Step 5: Run full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. (Note: `src/concierge/index.ts` references `./opentable-adapter`, created in Task 9. If running Task 8 before Task 9, temporarily omit that one line, then restore it in Task 9.)

- [ ] **Step 6: Commit**

```bash
git add src/concierge/dry-run.ts src/concierge/index.ts src/index.ts src/__tests__/concierge-dry-run.test.ts
git commit -m "feat(concierge): dry-run wiring + barrel export (itinerary->bookings loop proven)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: OpenTableAdapter (fetch-based, contract-tested with mocked fetch)

**Files:**
- Create: `src/concierge/opentable-adapter.ts`
- Test: `src/__tests__/concierge-opentable.test.ts`

**Interfaces:**
- Consumes: `BookingRail` (Task 3), `runBookingRailContract` (Task 5).
- Produces: `class OpenTableAdapter implements BookingRail` with constructor `new OpenTableAdapter(opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch })`.

**Note:** OpenTable partner/sandbox access is approval-gated; this task implements the adapter to the contract and tests it against a mocked `fetch`. A live sandbox smoke test is added later when credentials land. Endpoints mirror the OpenTable Partner API shape (`slot_locks` -> `reservations`); adjust exact paths to the granted API version at integration time.

- [ ] **Step 1: Write the failing test (mocked fetch + contract suite)**

```ts
// src/__tests__/concierge-opentable.test.ts
import { describe, it, expect, vi } from "vitest";
import { OpenTableAdapter } from "../concierge/opentable-adapter";
import { runBookingRailContract } from "../concierge/rail-contract";

function fakeFetch(): typeof fetch {
  return vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("/search")) {
      return json({ slots: [{ id: "rest-1", name: "Testville Grill", time: "2026-08-01T19:00:00Z" }] });
    }
    if (u.includes("/slot_locks")) return json({ lock_id: "lock-1", expires_at: "2026-08-01T19:15:00Z" });
    if (u.includes("/reservations") && init?.method === "POST") return json({ reservation_id: "res-1", confirmation: "OT-123" });
    if (u.includes("/reservations/") && init?.method === "DELETE") return json({ status: "cancelled" });
    if (u.includes("/reservations/")) return json({ status: "confirmed" });
    return json({});
  }) as unknown as typeof fetch;
}

const make = () => new OpenTableAdapter({ baseUrl: "https://sandbox.opentable.test", token: "t", fetchImpl: fakeFetch() });

describe("OpenTableAdapter (mocked)", () => {
  it("maps search response to RailSlot[]", async () => {
    const slots = await make().search({ area: "Testville", dateTime: "2026-08-01T19:00:00Z", partySize: 4 });
    expect(slots[0].railSlotId).toBe("rest-1");
    expect(slots[0].priceCents).toBe(0);
  });
});

runBookingRailContract("OpenTableAdapter(mock fetch)", make);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/concierge-opentable.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/concierge/opentable-adapter.ts
import type { BookingRail, RailSearchQuery, HoldResult, BookResult } from "./rail";
import type { RailSlot, CancellationPolicy, BookingStatus } from "./types";

const DINING_POLICY: CancellationPolicy = { refundable: true, freeCancelUntil: null, refundAmountCents: 0 };

export interface OpenTableAdapterOpts {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class OpenTableAdapter implements BookingRail {
  readonly railId = "opentable";
  private fetchImpl: typeof fetch;
  constructor(private opts: OpenTableAdapterOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async req(path: string, init?: RequestInit): Promise<any> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`OpenTable ${path} -> ${res.status}`);
    return res.json();
  }

  async search(q: RailSearchQuery): Promise<RailSlot[]> {
    const data = await this.req(`/v2/search?area=${encodeURIComponent(q.area)}&party=${q.partySize}&time=${encodeURIComponent(q.dateTime)}`);
    return (data.slots ?? []).map((s: any): RailSlot => ({
      railSlotId: s.id,
      label: s.name,
      priceCents: 0,
      startsAt: s.time,
      cancellation: DINING_POLICY,
    }));
  }

  async getCancellationPolicy(): Promise<CancellationPolicy> {
    return DINING_POLICY;
  }

  async hold(railSlotId: string, ctx: { partySize: number; dateTime: string }): Promise<HoldResult> {
    const data = await this.req(`/v2/booking/${railSlotId}/slot_locks`, { method: "POST", body: JSON.stringify({ party: ctx.partySize, time: ctx.dateTime }) });
    return {
      holdRef: data.lock_id,
      expiresAt: data.expires_at,
      slot: { railSlotId, label: railSlotId, priceCents: 0, startsAt: ctx.dateTime, cancellation: DINING_POLICY },
    };
  }

  async book(holdRef: string, ctx: { leadName: string; leadEmail: string }): Promise<BookResult> {
    const data = await this.req(`/v2/reservations`, { method: "POST", body: JSON.stringify({ lock_id: holdRef, name: ctx.leadName, email: ctx.leadEmail }) });
    return { railRef: data.reservation_id, confirmationCode: data.confirmation, amountCents: 0 };
  }

  async cancel(railRef: string): Promise<{ refundAmountCents: number }> {
    await this.req(`/v2/reservations/${railRef}`, { method: "DELETE" });
    return { refundAmountCents: 0 };
  }

  async status(railRef: string): Promise<BookingStatus> {
    const data = await this.req(`/v2/reservations/${railRef}`);
    return data.status === "confirmed" ? "confirmed" : data.status === "cancelled" ? "cancelled" : "pending";
  }
}
```

- [ ] **Step 4: Run test + full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS (all concierge tests, including both contract runs).

- [ ] **Step 5: Commit**

```bash
git add src/concierge/opentable-adapter.ts src/__tests__/concierge-opentable.test.ts
git commit -m "feat(concierge): OpenTableAdapter (fetch-based, contract-tested via mocked fetch)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 0 Done — Definition of Done

- `npx vitest run` green; `npx tsc --noEmit` clean.
- `runConciergeDryRun` turns dining intents into confirmed (mock) bookings — the wedge is proven.
- `MockRail` and `OpenTableAdapter` both pass the same `BookingRail` contract.
- Tenant type admits only `moh | bestman | handicaphq` (OO unrepresentable).
- Seams ready for later phases: `ProposalSource` (LLM drops in), `BookingStore` (Supabase impl drops in), `BookingRail` (LiteAPI/GetYourGuide adapters drop in), `Orchestrator` (staged-commit/saga extends).

## Next (not this plan)
- Phase 1: GetYourGuide activities + hold/reserve + saga compensation; begin counsel sign-off.
- OpenTable + GetYourGuide partner-approval applications (start now — weeks of lead time).
- Supabase `BookingStore` implementation + audit-log/outbox tables.
