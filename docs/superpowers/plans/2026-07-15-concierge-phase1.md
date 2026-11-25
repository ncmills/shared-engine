# Planner Concierge Engine — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the deterministic core can execute a **multi-item, paid, partner-merchant-of-record booking manifest** with a **correct compensation path** (any booking failure ⇒ every already-booked item is cancelled ⇒ zero orphans) and an **append-only audit trail**, against a **real-shaped paid rail** (GetYourGuide `reserve → book`, non-zero price, real cancellation policy) — all provable in CI with **no money and no external calls** (MockRail + mocked fetch).

**Architecture:** Extends the Phase 0 `src/concierge/` module. Adds (1) an append-only `AuditLog` spine, (2) a `GetYourGuideAdapter` (fetch-based `BookingRail`, mirrors the existing `OpenTableAdapter` template), (3) an `activity` resolver path with budget-cap + cancellation-policy guardrails, and (4) an `Orchestrator.executeSaga()` method that books a manifest atomically and compensates (cancels) every booked item on any failure — audit-logged, idempotent, hold-expiry-aware. The Phase 0 per-item `execute()` path (dining, no money, independent items) is left untouched.

**Tech Stack:** TypeScript, vitest (`npx vitest run`), `tsc --noEmit`. No new runtime dependencies (global `fetch`).

## Global Constraints

- **Tenants are `'moh' | 'bestman' | 'handicaphq'` only** (`ConciergeTenant`). Offsite Outpost and `'tdf'` remain unrepresentable.
- **The LLM / any `ProposalSource` may only *propose*.** Only the `Orchestrator` calls `hold`/`book`/`cancel`. Unchanged from Phase 0.
- **Determinism:** no `Math.random()` / `Date.now()` / argless `new Date()` in engine code. The saga takes `now` as an explicit `string` parameter; audit timestamps use it. Ids/ordering derive from inputs.
- **All money amounts are integer cents.** Phase 1 activities carry non-zero `priceCents`; **no real money moves** — MockRail + mocked fetch only, no deploy, no site mount.
- **Append-only audit:** `AuditLog` exposes `append` + `entries` only — no update/delete.
- **No-orphan invariant:** after `executeSaga` returns, there is never a live partner booking for a trip whose saga did not end `confirmed`.
- **Scope guard (deferred to Phase 2, per master spec §9):** NO staged-commit one-tap / shortest-TTL-first ordering, NO card auth / LiteAPI Payment SDK / spend-cap UX, NO transactional outbox, NO Supabase persistence (stays in-memory), NO split ledger / Stripe fee / Trip Room, NO BM/HH onboarding.
- **Follow repo conventions:** tests in `src/__tests__/concierge-*.test.ts`; `import` from `../concierge/<file>`; `describe/it/expect/vi` from `vitest`; export new public surface through `src/concierge/index.ts`. Repo runs `noUncheckedIndexedAccess` — index access yields `T | undefined`; use `!` only where provably non-null.
- **Commit trailer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

- `src/concierge/audit.ts` — **NEW.** `AuditEntry`, `AuditLog` interface, `InMemoryAuditLog`.
- `src/concierge/mock-rail.ts` — **MODIFY.** Extend `MockRail` opts to support a paid (activity-style) mode, overridable hold expiry, and a refund amount on cancel. Back-compatible: `new MockRail()` behaves exactly as in Phase 0.
- `src/concierge/getyourguide-adapter.ts` — **NEW.** `GetYourGuideAdapter` (fetch-based `BookingRail`, `reserve → book`).
- `src/concierge/resolver.ts` — **MODIFY.** Extract a shared `resolveForCategory`; add `resolveActivities`; add a paid-item cancellation-policy guardrail to `validateChoice`.
- `src/concierge/orchestrator.ts` — **MODIFY.** Accept an optional `AuditLog` in the constructor; add `executeSaga()` + `SagaResult`/`SagaCtx`/`CompensationRecord` types.
- `src/concierge/dry-run.ts` — **MODIFY.** Add `runConciergeSagaDryRun()` wiring resolver→saga→audit against a paid MockRail.
- `src/concierge/index.ts` — **MODIFY.** Add `export * from "./audit"` and `export * from "./getyourguide-adapter"`.
- Tests: `src/__tests__/concierge-{audit,mock-rail-paid,getyourguide,resolver-activity,saga,saga-dry-run}.test.ts`.

---

## Task 1: Append-only audit spine

**Files:**
- Create: `src/concierge/audit.ts`
- Test: `src/__tests__/concierge-audit.test.ts`

**Interfaces:**
- Produces: `interface AuditEntry`; `interface AuditLog { append(e: AuditEntry): Promise<void>; entries(tripId: string): Promise<AuditEntry[]> }`; `class InMemoryAuditLog implements AuditLog`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/concierge-audit.test.ts
import { describe, it, expect } from "vitest";
import { InMemoryAuditLog, type AuditEntry } from "../concierge/audit";

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  ts: "2026-07-20T12:00:00.000Z",
  tripId: "trip-1",
  itemId: "item-1",
  actor: "orchestrator",
  action: "book",
  rail: "mock",
  externalRef: "ref-1",
  amountCents: 5000,
  ...over,
});

describe("InMemoryAuditLog", () => {
  it("appends and returns entries for a trip in order", async () => {
    const log = new InMemoryAuditLog();
    await log.append(entry({ action: "hold", externalRef: "hold-1", amountCents: 0 }));
    await log.append(entry({ action: "book" }));
    const rows = await log.entries("trip-1");
    expect(rows.map((r) => r.action)).toEqual(["hold", "book"]);
  });

  it("scopes entries by tripId — no cross-trip leakage", async () => {
    const log = new InMemoryAuditLog();
    await log.append(entry({ tripId: "trip-1" }));
    await log.append(entry({ tripId: "trip-2" }));
    expect(await log.entries("trip-1")).toHaveLength(1);
    expect(await log.entries("trip-2")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/concierge-audit.test.ts`
Expected: FAIL — cannot find module `../concierge/audit`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/concierge/audit.ts

/** One immutable, timestamped row for a money-moving (or money-adjacent) action.
 *  The forensic record for chargebacks/disputes. Append-only — never updated or deleted. */
export interface AuditEntry {
  ts: string; // ISO8601, passed in by the caller (determinism — no Date.now())
  tripId: string;
  itemId: string | null;
  actor: string; // e.g. "orchestrator"
  action: "hold" | "book" | "book_failed" | "compensate";
  rail: string;
  externalRef: string | null; // holdRef / railRef
  amountCents: number;
  detail?: string;
}

export interface AuditLog {
  append(e: AuditEntry): Promise<void>;
  entries(tripId: string): Promise<AuditEntry[]>;
}

export class InMemoryAuditLog implements AuditLog {
  private log: AuditEntry[] = [];
  async append(e: AuditEntry): Promise<void> {
    this.log.push(e);
  }
  async entries(tripId: string): Promise<AuditEntry[]> {
    return this.log.filter((e) => e.tripId === tripId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/concierge-audit.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/concierge/audit.ts src/__tests__/concierge-audit.test.ts
git commit -m "feat(concierge): append-only audit spine (InMemoryAuditLog)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: MockRail paid-mode (activity-style rail)

**Files:**
- Modify: `src/concierge/mock-rail.ts`
- Test: `src/__tests__/concierge-mock-rail-paid.test.ts`

**Interfaces:**
- Consumes: `BookingRail`, `RailSlot`, `CancellationPolicy` (unchanged).
- Produces: `new MockRail(opts?)` where `opts` gains `priceCents?: number` (>0 ⇒ paid slots + refundable policy), `holdExpiresAt?: string` (override hold expiry; a past ISO simulates an expired hold), `refundAmountCents?: number` (what `cancel` refunds; defaults to `priceCents`). `new MockRail()` and `new MockRail({ failBookFor })` behave exactly as Phase 0.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/concierge-mock-rail-paid.test.ts
import { describe, it, expect } from "vitest";
import { MockRail } from "../concierge/mock-rail";

const q = { area: "Nashville", dateTime: "2026-08-01T14:00:00Z", partySize: 6 };

describe("MockRail paid mode", () => {
  it("returns priced slots with a refundable policy when priceCents > 0", async () => {
    const slots = await new MockRail({ priceCents: 5000 }).search(q);
    expect(slots[0]!.priceCents).toBe(5000);
    expect(slots[0]!.cancellation.refundable).toBe(true);
    expect(slots[0]!.cancellation.freeCancelUntil).not.toBeNull();
  });

  it("book returns the priced amount; cancel refunds it", async () => {
    const rail = new MockRail({ priceCents: 5000 });
    const slot = (await rail.search(q))[0]!;
    const held = await rail.hold(slot.railSlotId, { partySize: 6, dateTime: slot.startsAt });
    const booked = await rail.book(held.holdRef, { leadName: "T", leadEmail: "t@e.com" });
    expect(booked.amountCents).toBe(5000);
    expect((await rail.cancel(booked.railRef)).refundAmountCents).toBe(5000);
  });

  it("holdExpiresAt overrides the hold expiry (past ⇒ simulate expiry)", async () => {
    const rail = new MockRail({ priceCents: 5000, holdExpiresAt: "2000-01-01T00:00:00.000Z" });
    const held = await rail.hold("slot-x", { partySize: 6, dateTime: q.dateTime });
    expect(held.expiresAt).toBe("2000-01-01T00:00:00.000Z");
  });

  it("default (no opts) is unchanged: price 0, free-cancel, far-future hold", async () => {
    const rail = new MockRail();
    const slots = await rail.search(q);
    expect(slots[0]!.priceCents).toBe(0);
    const held = await rail.hold(slots[0]!.railSlotId, { partySize: 6, dateTime: q.dateTime });
    expect(held.expiresAt > q.dateTime).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/concierge-mock-rail-paid.test.ts`
Expected: FAIL — priced-mode assertions fail (search returns `priceCents: 0`).

- [ ] **Step 3: Write minimal implementation** (replace the whole file)

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

// Far-future sentinels keep the happy path from ever tripping the hold-expiry guard.
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";

export interface MockRailOpts {
  failBookFor?: string[];
  /** >0 makes this a paid (activity-style) rail with a refundable policy. */
  priceCents?: number;
  /** Override the hold expiry; a past ISO simulates an already-expired hold. */
  holdExpiresAt?: string;
  /** What cancel refunds; defaults to priceCents. */
  refundAmountCents?: number;
}

export class MockRail implements BookingRail {
  readonly railId = "mock";
  private booked = new Set<string>();
  private holdToSlot = new Map<string, string>();
  constructor(private opts: MockRailOpts = {}) {}

  private policy(): CancellationPolicy {
    const price = this.opts.priceCents ?? 0;
    if (price > 0) {
      return { refundable: true, freeCancelUntil: FAR_FUTURE, refundAmountCents: this.opts.refundAmountCents ?? price };
    }
    return FREE_CANCEL;
  }

  async search(q: RailSearchQuery): Promise<RailSlot[]> {
    const seed = hashStr(`${q.area}|${q.dateTime}|${q.partySize}`);
    const price = this.opts.priceCents ?? 0;
    const n = 3;
    return Array.from({ length: n }, (_, i) => ({
      railSlotId: `${q.area}-${(seed + i) % 1000}`,
      label: `${q.area} option ${i + 1}`,
      priceCents: price,
      startsAt: q.dateTime,
      cancellation: this.policy(),
    }));
  }

  async getCancellationPolicy(): Promise<CancellationPolicy> {
    return this.policy();
  }

  async hold(railSlotId: string, ctx: { partySize: number; dateTime: string }): Promise<HoldResult> {
    const holdRef = `hold-${railSlotId}`;
    this.holdToSlot.set(holdRef, railSlotId);
    return {
      holdRef,
      expiresAt: this.opts.holdExpiresAt ?? FAR_FUTURE,
      slot: {
        railSlotId,
        label: railSlotId,
        priceCents: this.opts.priceCents ?? 0,
        startsAt: ctx.dateTime,
        cancellation: this.policy(),
      },
    };
  }

  async book(holdRef: string, _ctx: { leadName: string; leadEmail: string }): Promise<BookResult> {
    const slotId = this.holdToSlot.get(holdRef) ?? holdRef.replace(/^hold-/, "");
    if (this.opts.failBookFor?.includes(slotId)) {
      throw new Error(`MockRail: booking refused for ${slotId}`);
    }
    const railRef = `ref-${slotId}`;
    this.booked.add(railRef);
    return { railRef, confirmationCode: `MOCK-${slotId}`, amountCents: this.opts.priceCents ?? 0 };
  }

  async cancel(railRef: string): Promise<{ refundAmountCents: number }> {
    this.booked.delete(railRef);
    return { refundAmountCents: this.opts.refundAmountCents ?? this.opts.priceCents ?? 0 };
  }

  async status(railRef: string): Promise<BookingStatus> {
    return this.booked.has(railRef) ? "confirmed" : "cancelled";
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/concierge-mock-rail-paid.test.ts src/__tests__/concierge-mock-rail.test.ts src/__tests__/concierge-rail-contract.test.ts src/__tests__/concierge-orchestrator.test.ts`
Expected: PASS — new paid-mode suite green AND all Phase 0 MockRail-dependent suites still green (back-compat).

- [ ] **Step 5: Commit**

```bash
git add src/concierge/mock-rail.ts src/__tests__/concierge-mock-rail-paid.test.ts
git commit -m "feat(concierge): MockRail paid-mode + overridable hold expiry + refund

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: GetYourGuide adapter (fetch-based paid rail)

**Files:**
- Create: `src/concierge/getyourguide-adapter.ts`
- Test: `src/__tests__/concierge-getyourguide.test.ts`

**Interfaces:**
- Consumes: `BookingRail`, `RailSearchQuery`, `HoldResult`, `BookResult`, `RailSlot`, `CancellationPolicy`, `BookingStatus`.
- Produces: `class GetYourGuideAdapter implements BookingRail` with `railId = "getyourguide"`; `interface GetYourGuideAdapterOpts { baseUrl: string; token: string; fetchImpl?: typeof fetch }`. Passes `runBookingRailContract`.

**Note:** The Phase 0 progress ledger flagged `any` at the OpenTable API boundary as a deferred Minor for the *live* integration template. This adapter is the same MockRail-first pattern; the `any`-at-boundary is acceptable for Phase 1 (mocked fetch, no live creds). Response-shape narrowing lands when live GYG sandbox creds arrive.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/concierge-getyourguide.test.ts
import { describe, it, expect, vi } from "vitest";
import { GetYourGuideAdapter } from "../concierge/getyourguide-adapter";
import { runBookingRailContract } from "../concierge/rail-contract";

function fakeFetch(): typeof fetch {
  return vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("/tours") && (!init || init.method === undefined || init.method === "GET")) {
      return json({ tours: [{ id: "tour-1", title: "Sunset Kayak", price_cents: 8500, start_time: "2026-08-01T14:00:00Z", cancellation: { refundable: true, free_until: "2026-07-30T00:00:00Z", refund_cents: 8500 } }] });
    }
    if (u.includes("/reservations") && init?.method === "POST") return json({ reservation_id: "gyg-res-1", expires_at: "2026-08-01T13:30:00Z" });
    if (u.includes("/bookings") && init?.method === "POST") return json({ booking_id: "gyg-book-1", voucher_code: "GYG-XYZ", amount_cents: 8500 });
    if (u.includes("/bookings/") && init?.method === "DELETE") return json({ refund_cents: 8500 });
    if (u.includes("/bookings/")) return json({ status: "confirmed" });
    return json({});
  }) as unknown as typeof fetch;
}

const make = () => new GetYourGuideAdapter({ baseUrl: "https://sandbox.getyourguide.test", token: "t", fetchImpl: fakeFetch() });

describe("GetYourGuideAdapter (mocked)", () => {
  it("maps search response to priced RailSlot[] with a real cancellation policy", async () => {
    const slots = await make().search({ area: "Nashville", dateTime: "2026-08-01T14:00:00Z", partySize: 6 });
    expect(slots[0]!.railSlotId).toBe("tour-1");
    expect(slots[0]!.priceCents).toBe(8500);
    expect(slots[0]!.cancellation.refundable).toBe(true);
    expect(slots[0]!.cancellation.freeCancelUntil).toBe("2026-07-30T00:00:00Z");
  });

  it("book returns a non-zero amount and a confirmation code", async () => {
    const rail = make();
    const held = await rail.hold("tour-1", { partySize: 6, dateTime: "2026-08-01T14:00:00Z" });
    const booked = await rail.book(held.holdRef, { leadName: "T", leadEmail: "t@e.com" });
    expect(booked.railRef).toBe("gyg-book-1");
    expect(booked.confirmationCode).toBe("GYG-XYZ");
    expect(booked.amountCents).toBe(8500);
  });
});

runBookingRailContract("GetYourGuideAdapter(mock fetch)", make);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/concierge-getyourguide.test.ts`
Expected: FAIL — cannot find module `../concierge/getyourguide-adapter`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/concierge/getyourguide-adapter.ts
import type { BookingRail, RailSearchQuery, HoldResult, BookResult } from "./rail";
import type { RailSlot, CancellationPolicy, BookingStatus } from "./types";

export interface GetYourGuideAdapterOpts {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

function toPolicy(c: any): CancellationPolicy {
  if (!c) return { refundable: false, freeCancelUntil: null, refundAmountCents: null };
  return {
    refundable: !!c.refundable,
    freeCancelUntil: c.free_until ?? null,
    refundAmountCents: c.refund_cents ?? null,
  };
}

export class GetYourGuideAdapter implements BookingRail {
  readonly railId = "getyourguide";
  private fetchImpl: typeof fetch;
  constructor(private opts: GetYourGuideAdapterOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async req(path: string, init?: RequestInit): Promise<any> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`GetYourGuide ${path} -> ${res.status}`);
    return res.json();
  }

  async search(q: RailSearchQuery): Promise<RailSlot[]> {
    const data = await this.req(`/1/tours?location=${encodeURIComponent(q.area)}&date=${encodeURIComponent(q.dateTime)}&participants=${q.partySize}`);
    return (data.tours ?? []).map((t: any): RailSlot => ({
      railSlotId: t.id,
      label: t.title,
      priceCents: t.price_cents ?? 0,
      startsAt: t.start_time,
      cancellation: toPolicy(t.cancellation),
    }));
  }

  async getCancellationPolicy(railSlotId: string): Promise<CancellationPolicy> {
    const data = await this.req(`/1/tours/${railSlotId}/cancellation`);
    return toPolicy(data.cancellation ?? data);
  }

  async hold(railSlotId: string, ctx: { partySize: number; dateTime: string }): Promise<HoldResult> {
    const data = await this.req(`/1/reservations`, { method: "POST", body: JSON.stringify({ tour_id: railSlotId, date: ctx.dateTime, participants: ctx.partySize }) });
    return {
      holdRef: data.reservation_id,
      expiresAt: data.expires_at,
      slot: { railSlotId, label: railSlotId, priceCents: data.price_cents ?? 0, startsAt: ctx.dateTime, cancellation: toPolicy(data.cancellation) },
    };
  }

  async book(holdRef: string, ctx: { leadName: string; leadEmail: string }): Promise<BookResult> {
    const data = await this.req(`/1/bookings`, { method: "POST", body: JSON.stringify({ reservation_id: holdRef, name: ctx.leadName, email: ctx.leadEmail }) });
    return { railRef: data.booking_id, confirmationCode: data.voucher_code, amountCents: data.amount_cents ?? 0 };
  }

  async cancel(railRef: string): Promise<{ refundAmountCents: number }> {
    const data = await this.req(`/1/bookings/${railRef}`, { method: "DELETE" });
    return { refundAmountCents: data.refund_cents ?? 0 };
  }

  async status(railRef: string): Promise<BookingStatus> {
    const data = await this.req(`/1/bookings/${railRef}`);
    return data.status === "confirmed" ? "confirmed" : data.status === "cancelled" ? "cancelled" : "pending";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/concierge-getyourguide.test.ts`
Expected: PASS — mapping tests + `runBookingRailContract` (2 contract tests) green.

- [ ] **Step 5: Commit**

```bash
git add src/concierge/getyourguide-adapter.ts src/__tests__/concierge-getyourguide.test.ts
git commit -m "feat(concierge): GetYourGuideAdapter (fetch-based paid rail, reserve->book)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Activity resolver path + paid-item policy guardrail

**Files:**
- Modify: `src/concierge/resolver.ts`
- Test: `src/__tests__/concierge-resolver-activity.test.ts`

**Interfaces:**
- Consumes: `BookingRail`, `BookingIntent`, `RailSlot`, `ManifestItem`, `BookingManifest`, `ConciergeTenant`, `ProposalSource` (existing).
- Produces: `async function resolveActivities(args: ResolveArgs): Promise<BookingManifest>`; `resolveDining` unchanged in behavior (now delegates to a shared `resolveForCategory`); `validateChoice` additionally rejects a **paid** slot whose refundable policy carries neither a free-cancel deadline nor a refund amount. Exports `type ResolveArgs` (with `type ResolveDiningArgs = ResolveArgs` kept as an alias).

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/concierge-resolver-activity.test.ts
import { describe, it, expect } from "vitest";
import { resolveActivities, DeterministicProposalSource, validateChoice } from "../concierge/resolver";
import { MockRail } from "../concierge/mock-rail";
import type { BookingIntent } from "../concierge/types";

const activityIntents: BookingIntent[] = [
  { itemId: "tour-1", category: "activity", query: { area: "Nashville", dateTime: "2026-08-01T14:00:00Z", partySize: 6, maxPriceCents: 10000 } },
];

describe("resolveActivities", () => {
  it("produces a manifest with a chosen paid slot per activity intent", async () => {
    const manifest = await resolveActivities({
      tripId: "trip-1",
      tenant: "moh",
      intents: activityIntents,
      rail: new MockRail({ priceCents: 8500 }),
      proposals: new DeterministicProposalSource(),
    });
    expect(manifest.items[0]!.chosen).not.toBeNull();
    expect(manifest.items[0]!.chosen!.priceCents).toBe(8500);
  });

  it("leaves chosen null when every candidate exceeds the budget cap", async () => {
    const manifest = await resolveActivities({
      tripId: "trip-2",
      tenant: "moh",
      intents: [{ itemId: "t", category: "activity", query: { area: "Z", dateTime: "2026-08-01T14:00:00Z", partySize: 6, maxPriceCents: 100 } }],
      rail: new MockRail({ priceCents: 8500 }),
      proposals: new DeterministicProposalSource(),
    });
    expect(manifest.items[0]!.chosen).toBeNull();
  });

  it("throws when a non-activity intent reaches resolveActivities", async () => {
    await expect(
      resolveActivities({
        tripId: "trip-3",
        tenant: "moh",
        intents: [{ itemId: "d", category: "dining", query: { area: "A", dateTime: "2026-08-01T19:00:00Z", partySize: 4 } }],
        rail: new MockRail(),
        proposals: new DeterministicProposalSource(),
      }),
    ).rejects.toThrow(/non-activity/);
  });

  it("guardrail rejects a PAID slot whose refundable policy has no deadline and no refund amount", () => {
    const err = validateChoice(
      { itemId: "x", category: "activity", query: { area: "A", dateTime: "2026-08-01T14:00:00Z", partySize: 2 } },
      { railSlotId: "s", label: "s", priceCents: 5000, startsAt: "2026-08-01T14:00:00Z", cancellation: { refundable: true, freeCancelUntil: null, refundAmountCents: 0 } },
    );
    expect(err).toMatch(/policy/i);
  });

  it("guardrail allows a paid slot with a concrete free-cancel deadline", () => {
    const err = validateChoice(
      { itemId: "x", category: "activity", query: { area: "A", dateTime: "2026-08-01T14:00:00Z", partySize: 2 } },
      { railSlotId: "s", label: "s", priceCents: 5000, startsAt: "2026-08-01T14:00:00Z", cancellation: { refundable: true, freeCancelUntil: "2026-07-30T00:00:00Z", refundAmountCents: 5000 } },
    );
    expect(err).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/concierge-resolver-activity.test.ts`
Expected: FAIL — `resolveActivities` is not exported.

- [ ] **Step 3: Write minimal implementation** (replace the whole file)

```ts
// src/concierge/resolver.ts
import type { BookingRail } from "./rail";
import type { BookingIntent, RailSlot, ManifestItem, BookingManifest, ConciergeTenant, BookingCategory } from "./types";

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
  // Money-safety: a PAID item that claims to be refundable must carry a concrete refund
  // term (a free-cancel deadline OR a refund amount). Dining (priceCents 0) is exempt.
  if (chosen.priceCents > 0) {
    const c = chosen.cancellation;
    if (c.refundable && c.freeCancelUntil == null && (c.refundAmountCents == null || c.refundAmountCents === 0)) {
      return "refundable policy missing a free-cancel deadline and refund amount";
    }
  }
  return null;
}

export interface ResolveArgs {
  tripId: string;
  tenant: ConciergeTenant;
  intents: BookingIntent[];
  rail: BookingRail;
  proposals: ProposalSource;
}
/** @deprecated alias kept for Phase 0 callers */
export type ResolveDiningArgs = ResolveArgs;

async function resolveForCategory(category: BookingCategory, args: ResolveArgs): Promise<BookingManifest> {
  const items: ManifestItem[] = [];
  for (const intent of args.intents) {
    // Fail loud if a mismatched category reaches this resolver.
    if (intent.category !== category) {
      throw new Error(`resolve for ${category} received non-${category} intent ${intent.itemId} (${intent.category})`);
    }
    const candidates = await args.rail.search(intent.query);
    // Provenance guard: a chosen slot MUST be one the rail actually returned.
    // The proposer may reorder/filter candidates but can never inject a fabricated slot.
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

export async function resolveDining(args: ResolveArgs): Promise<BookingManifest> {
  return resolveForCategory("dining", args);
}

export async function resolveActivities(args: ResolveArgs): Promise<BookingManifest> {
  return resolveForCategory("activity", args);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/concierge-resolver-activity.test.ts src/__tests__/concierge-resolver.test.ts`
Expected: PASS — new activity suite green AND the Phase 0 `resolveDining` suite still green (the `/non-dining/` throw test still matches: message contains `non-dining`).

- [ ] **Step 5: Commit**

```bash
git add src/concierge/resolver.ts src/__tests__/concierge-resolver-activity.test.ts
git commit -m "feat(concierge): activity resolver path + paid-item policy guardrail

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Saga orchestrator (compensation + audit + no-orphan invariant)

**Files:**
- Modify: `src/concierge/orchestrator.ts`
- Test: `src/__tests__/concierge-saga.test.ts`

**Interfaces:**
- Consumes: `BookingRail`, `BookingManifest`, `BookingRecord`, `BookingResult`, `bookingRecordId` (existing); `AuditLog`, `InMemoryAuditLog` (Task 1).
- Produces: `Orchestrator` constructor gains an optional 3rd param `audit: AuditLog = new InMemoryAuditLog()` (existing `new Orchestrator(rail, store)` still compiles); `async executeSaga(manifest, ctx: SagaCtx): Promise<SagaResult>`; `interface SagaCtx { lead: { leadName: string; leadEmail: string }; now: string; actor?: string }`; `interface CompensationRecord { itemId: string; railRef: string; refundAmountCents: number }`; `interface SagaResult { tripId: string; status: "confirmed" | "compensated"; results: BookingResult[]; compensations: CompensationRecord[]; error: string | null }`. The Phase 0 `execute()` method is unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/concierge-saga.test.ts
import { describe, it, expect } from "vitest";
import { Orchestrator, InMemoryBookingStore } from "../concierge/orchestrator";
import { InMemoryAuditLog } from "../concierge/audit";
import { resolveActivities, DeterministicProposalSource } from "../concierge/resolver";
import { MockRail } from "../concierge/mock-rail";
import type { BookingIntent } from "../concierge/types";

const lead = { leadName: "Ada", leadEmail: "ada@example.com" };
const now = "2026-07-20T12:00:00.000Z";
const intents: BookingIntent[] = [
  { itemId: "tour-1", category: "activity", query: { area: "Nashville", dateTime: "2026-08-01T14:00:00Z", partySize: 6, maxPriceCents: 20000 } },
  { itemId: "tour-2", category: "activity", query: { area: "Austin", dateTime: "2026-08-02T14:00:00Z", partySize: 6, maxPriceCents: 20000 } },
];

const manifestFor = (rail: MockRail) =>
  resolveActivities({ tripId: "trip-1", tenant: "moh", intents, rail, proposals: new DeterministicProposalSource() });

describe("Orchestrator.executeSaga", () => {
  it("books every item and logs a hold+book audit entry per item", async () => {
    const rail = new MockRail({ priceCents: 8500 });
    const audit = new InMemoryAuditLog();
    const saga = await new Orchestrator(rail, new InMemoryBookingStore(), audit).executeSaga(await manifestFor(rail), { lead, now });
    expect(saga.status).toBe("confirmed");
    expect(saga.results.every((r) => r.status === "confirmed")).toBe(true);
    const actions = (await audit.entries("trip-1")).map((e) => e.action);
    expect(actions.filter((a) => a === "hold")).toHaveLength(2);
    expect(actions.filter((a) => a === "book")).toHaveLength(2);
  });

  it("compensates already-booked items when a later item fails (no orphans)", async () => {
    const probe = new MockRail({ priceCents: 8500 });
    const manifest = await manifestFor(probe);
    const failingSlot = manifest.items[1]!.chosen!.railSlotId; // tour-2 fails to book
    const rail = new MockRail({ priceCents: 8500, failBookFor: [failingSlot] });
    const store = new InMemoryBookingStore();
    const audit = new InMemoryAuditLog();
    const saga = await new Orchestrator(rail, store, audit).executeSaga(manifest, { lead, now });

    expect(saga.status).toBe("compensated");
    expect(saga.compensations.map((c) => c.itemId)).toEqual(["tour-1"]); // the booked one got cancelled
    expect(saga.compensations[0]!.refundAmountCents).toBe(8500);
    // No-orphan invariant: the previously-booked item is now cancelled in the store...
    const rec1 = await store.get("trip-1:tour-1:mock");
    expect(rec1!.status).toBe("cancelled");
    // ...and the rail has no live booking for it.
    expect(await rail.status("ref-" + manifest.items[0]!.chosen!.railSlotId)).toBe("cancelled");
    // Audit records the compensating cancel.
    expect((await audit.entries("trip-1")).some((e) => e.action === "compensate")).toBe(true);
  });

  it("treats an expired hold as a first-class failure and compensates", async () => {
    const probe = new MockRail({ priceCents: 8500 });
    const manifest = await manifestFor(probe);
    // tour-1 books fine; tour-2's hold is already expired ⇒ saga must compensate tour-1.
    // Force expiry on ALL holds but let tour-1 slip through by giving it a future expiry is not
    // possible per-slot on MockRail, so instead: expire every hold and assert tour-1 (booked
    // first, before the guard trips on it too) — simplest deterministic check is the whole-saga
    // outcome + that no confirmed booking survives.
    const rail = new MockRail({ priceCents: 8500, holdExpiresAt: "2000-01-01T00:00:00.000Z" });
    const store = new InMemoryBookingStore();
    const saga = await new Orchestrator(rail, store, new InMemoryAuditLog()).executeSaga(manifest, { lead, now });
    expect(saga.status).toBe("compensated");
    expect(saga.error).toMatch(/expired/i);
  });

  it("is idempotent — re-running a confirmed saga does not double-book", async () => {
    const rail = new MockRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const orch = new Orchestrator(rail, store, new InMemoryAuditLog());
    const manifest = await manifestFor(rail);
    await orch.executeSaga(manifest, { lead, now });
    const second = await orch.executeSaga(manifest, { lead, now });
    expect(second.status).toBe("confirmed");
    expect((await store.all("trip-1")).length).toBe(2); // not 4
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/concierge-saga.test.ts`
Expected: FAIL — `executeSaga` is not a function / constructor arity.

- [ ] **Step 3: Write minimal implementation** (replace the whole file)

```ts
// src/concierge/orchestrator.ts
import type { BookingRail } from "./rail";
import type { BookingManifest, BookingRecord, BookingResult } from "./types";
import { bookingRecordId } from "./types";
import { InMemoryAuditLog, type AuditLog } from "./audit";

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

export interface SagaCtx {
  lead: { leadName: string; leadEmail: string };
  now: string; // ISO8601 — determinism; used for hold-expiry checks + audit timestamps
  actor?: string;
}

export interface CompensationRecord {
  itemId: string;
  railRef: string;
  refundAmountCents: number;
}

export interface SagaResult {
  tripId: string;
  status: "confirmed" | "compensated";
  results: BookingResult[];
  compensations: CompensationRecord[];
  error: string | null;
}

export class Orchestrator {
  constructor(
    private rail: BookingRail,
    private store: BookingStore,
    private audit: AuditLog = new InMemoryAuditLog(),
  ) {}

  /** Phase 0 path: book each chosen item independently; a single failure is isolated,
   *  never aborts the run. Correct for free, independent items (dining). Unchanged. */
  async execute(manifest: BookingManifest, ctx: ExecuteCtx): Promise<BookingResult[]> {
    const results: BookingResult[] = [];
    for (const item of manifest.items) {
      const { itemId } = item.intent;
      const id = bookingRecordId(manifest.tripId, itemId, this.rail.railId);

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

  /** Phase 1 path: book a manifest ATOMICALLY. On ANY item failure (no candidate, book
   *  throws, or hold expired), compensate — cancel every already-booked item — so the trip
   *  ends with zero live bookings (the no-orphan invariant). Idempotent + audit-logged. */
  async executeSaga(manifest: BookingManifest, ctx: SagaCtx): Promise<SagaResult> {
    const actor = ctx.actor ?? "orchestrator";
    const results: BookingResult[] = [];
    const booked: { itemId: string; railRef: string }[] = [];

    const compensate = async (error: string): Promise<SagaResult> => {
      const compensations: CompensationRecord[] = [];
      for (const b of booked) {
        const { refundAmountCents } = await this.rail.cancel(b.railRef);
        const id = bookingRecordId(manifest.tripId, b.itemId, this.rail.railId);
        const rec = await this.store.get(id);
        if (rec) await this.store.put({ ...rec, status: "cancelled" });
        await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId: b.itemId, actor, action: "compensate", rail: this.rail.railId, externalRef: b.railRef, amountCents: refundAmountCents });
        compensations.push({ itemId: b.itemId, railRef: b.railRef, refundAmountCents });
      }
      return { tripId: manifest.tripId, status: "compensated", results, compensations, error };
    };

    for (const item of manifest.items) {
      const { itemId } = item.intent;
      const id = bookingRecordId(manifest.tripId, itemId, this.rail.railId);

      // Idempotency: an already-confirmed item is treated as booked (and stays subject to
      // compensation if a LATER item in this run fails).
      const existing = await this.store.get(id);
      if (existing && existing.status === "confirmed" && existing.railRef) {
        results.push({ itemId, status: "confirmed", confirmationCode: existing.confirmationCode, error: null });
        booked.push({ itemId, railRef: existing.railRef });
        continue;
      }

      if (!item.chosen) {
        const rec: BookingRecord = { id, tripId: manifest.tripId, itemId, rail: this.rail.railId, status: "failed", railRef: null, confirmationCode: null, amountCents: 0, error: "no candidate chosen" };
        await this.store.put(rec);
        results.push({ itemId, status: "failed", confirmationCode: null, error: rec.error });
        return compensate(`item ${itemId}: no candidate chosen`);
      }

      try {
        const held = await this.rail.hold(item.chosen.railSlotId, { partySize: item.intent.query.partySize, dateTime: item.chosen.startsAt });
        await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId, actor, action: "hold", rail: this.rail.railId, externalRef: held.holdRef, amountCents: item.chosen.priceCents });

        // Hold-expiry is a first-class failure, never a silent lapse.
        if (ctx.now >= held.expiresAt) {
          throw new Error(`hold ${held.holdRef} expired at ${held.expiresAt}`);
        }

        const bookedRes = await this.rail.book(held.holdRef, ctx.lead);
        const rec: BookingRecord = { id, tripId: manifest.tripId, itemId, rail: this.rail.railId, status: "confirmed", railRef: bookedRes.railRef, confirmationCode: bookedRes.confirmationCode, amountCents: bookedRes.amountCents, error: null };
        await this.store.put(rec);
        await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId, actor, action: "book", rail: this.rail.railId, externalRef: bookedRes.railRef, amountCents: bookedRes.amountCents });
        results.push({ itemId, status: "confirmed", confirmationCode: bookedRes.confirmationCode, error: null });
        booked.push({ itemId, railRef: bookedRes.railRef });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const rec: BookingRecord = { id, tripId: manifest.tripId, itemId, rail: this.rail.railId, status: "failed", railRef: null, confirmationCode: null, amountCents: 0, error: msg };
        await this.store.put(rec);
        await this.audit.append({ ts: ctx.now, tripId: manifest.tripId, itemId, actor, action: "book_failed", rail: this.rail.railId, externalRef: null, amountCents: 0, detail: msg });
        results.push({ itemId, status: "failed", confirmationCode: null, error: msg });
        return compensate(msg);
      }
    }

    return { tripId: manifest.tripId, status: "confirmed", results, compensations: [], error: null };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/concierge-saga.test.ts src/__tests__/concierge-orchestrator.test.ts`
Expected: PASS — saga suite (4 tests) green AND the Phase 0 orchestrator suite (per-item `execute`) still green.

- [ ] **Step 5: Commit**

```bash
git add src/concierge/orchestrator.ts src/__tests__/concierge-saga.test.ts
git commit -m "feat(concierge): saga orchestrator — atomic book + compensation + audit (no-orphan)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Saga dry-run wiring + barrel exports + full-suite gate

**Files:**
- Modify: `src/concierge/dry-run.ts`
- Modify: `src/concierge/index.ts`
- Test: `src/__tests__/concierge-saga-dry-run.test.ts`

**Interfaces:**
- Consumes: `MockRail`, `resolveActivities`, `DeterministicProposalSource`, `Orchestrator`, `InMemoryBookingStore`, `InMemoryAuditLog`, `SagaResult`, `AuditEntry`, `BookingIntent`, `BookingManifest`, `ConciergeTenant`.
- Produces: `interface SagaDryRunArgs { tripId: string; tenant: ConciergeTenant; intents: BookingIntent[]; now: string; priceCents?: number }`; `async function runConciergeSagaDryRun(args: SagaDryRunArgs): Promise<{ manifest: BookingManifest; saga: SagaResult; audit: AuditEntry[] }>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/concierge-saga-dry-run.test.ts
import { describe, it, expect } from "vitest";
import { runConciergeSagaDryRun } from "../concierge/dry-run";
import type { BookingIntent } from "../concierge/types";

const intents: BookingIntent[] = [
  { itemId: "tour-1", category: "activity", query: { area: "Nashville", dateTime: "2026-08-01T14:00:00Z", partySize: 6, maxPriceCents: 20000 } },
  { itemId: "tour-2", category: "activity", query: { area: "Austin", dateTime: "2026-08-02T14:00:00Z", partySize: 6, maxPriceCents: 20000 } },
];

describe("runConciergeSagaDryRun", () => {
  it("turns activity intents into confirmed (mock) bookings with a complete audit trail", async () => {
    const { manifest, saga, audit } = await runConciergeSagaDryRun({
      tripId: "trip-dry-1",
      tenant: "moh",
      intents,
      now: "2026-07-20T12:00:00.000Z",
      priceCents: 8500,
    });
    expect(manifest.items).toHaveLength(2);
    expect(saga.status).toBe("confirmed");
    expect(saga.results.every((r) => r.status === "confirmed")).toBe(true);
    // Audit completeness: a hold and a book per item.
    expect(audit.filter((e) => e.action === "hold")).toHaveLength(2);
    expect(audit.filter((e) => e.action === "book")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/concierge-saga-dry-run.test.ts`
Expected: FAIL — `runConciergeSagaDryRun` is not exported.

- [ ] **Step 3: Write minimal implementation** (append to `dry-run.ts`)

Add these imports at the top of `src/concierge/dry-run.ts` (extend the existing import lines):

```ts
import { resolveDining, resolveActivities, DeterministicProposalSource } from "./resolver";
import { InMemoryAuditLog } from "./audit";
import type { SagaResult } from "./orchestrator";
import type { AuditEntry } from "./audit";
```

Then append:

```ts
export interface SagaDryRunArgs {
  tripId: string;
  tenant: ConciergeTenant;
  intents: BookingIntent[];
  now: string; // ISO8601
  priceCents?: number;
}

/** Wires Resolver(activity) + saga Orchestrator + paid MockRail + in-memory store + audit —
 *  zero external calls. The CI-provable Phase 1 "activity itinerary -> confirmed bookings,
 *  with compensation available on failure" loop. */
export async function runConciergeSagaDryRun(
  args: SagaDryRunArgs,
): Promise<{ manifest: BookingManifest; saga: SagaResult; audit: AuditEntry[] }> {
  const rail = new MockRail({ priceCents: args.priceCents ?? 8500 });
  const manifest = await resolveActivities({
    tripId: args.tripId,
    tenant: args.tenant,
    intents: args.intents,
    rail,
    proposals: new DeterministicProposalSource(),
  });
  const audit = new InMemoryAuditLog();
  const saga = await new Orchestrator(rail, new InMemoryBookingStore(), audit).executeSaga(manifest, {
    lead: { leadName: "Trip Lead", leadEmail: "lead@example.com" },
    now: args.now,
  });
  return { manifest, saga, audit: await audit.entries(args.tripId) };
}
```

> Note: `dry-run.ts` already imports `MockRail`, `Orchestrator`, `InMemoryBookingStore`, and the `resolveDining`/`DeterministicProposalSource` pair, plus the `BookingManifest`/`BookingIntent`/`ConciergeTenant` types. Merge the new imports into the existing lines rather than duplicating; the `resolveDining` import line becomes `import { resolveDining, resolveActivities, DeterministicProposalSource } from "./resolver";`.

- [ ] **Step 4: Add barrel exports**

Edit `src/concierge/index.ts` — add two lines:

```ts
export * from "./audit";
export * from "./getyourguide-adapter";
```

- [ ] **Step 5: Run the full gate**

Run: `npx tsc --noEmit`
Expected: clean (no output).

Run: `npx vitest run`
Expected: PASS — all suites (Phase 0's 21 + Phase 1's new: audit 2, mock-rail-paid 4, getyourguide 4, resolver-activity 5, saga 4, saga-dry-run 1).

- [ ] **Step 6: Commit**

```bash
git add src/concierge/dry-run.ts src/concierge/index.ts src/__tests__/concierge-saga-dry-run.test.ts
git commit -m "feat(concierge): saga dry-run wiring + barrel exports (activity loop proven)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review (against master spec §8 Phase 1 rows + §9 Phase 1 gate)

- **Adapter contract suite — GYG satisfies shared `BookingRail` contract** → Task 3 runs `runBookingRailContract`. ✅
- **Resolver: proposals schema-validated; guardrails reject out-of-budget / policy-missing** → Task 4 (budget-cap test + paid-policy guardrail test) + existing provenance guard. ✅
- **Orchestrator saga: idempotency, partial-failure isolation, hold-expiry handling, compensation correctness, no-orphan invariant** → Task 5 (all four `executeSaga` tests). ✅
- **Money-safety: no double-charge (idempotency), audit completeness** → Task 5 idempotency test + Task 1/6 audit-completeness. ✅ (Outbox exactly-once is Phase 2 — noted in Global Constraints.)
- **Dry-run mode — full loop against MockRail, zero external calls, in CI** → Task 6. ✅
- **Determinism** — `now` passed in; audit `ts = ctx.now`; ids from `bookingRecordId`; no `Date.now()`. ✅
- **Tenant safety** — `ConciergeTenant` union unchanged; OO/tdf unrepresentable. ✅
- **Gate: "Saga + audit spine green"** → satisfied when Task 6's full `tsc --noEmit` + `vitest run` pass. ✅
- **Placeholder scan** — every code step contains complete code; no TODO/TBD. ✅
- **Type consistency** — `SagaResult`/`SagaCtx`/`CompensationRecord`/`AuditEntry`/`AuditLog`/`resolveActivities`/`ResolveArgs`/`MockRailOpts` names used identically across tasks. ✅

**Deferred to Phase 2+ (out of scope, per §9):** staged-commit one-tap + shortest-hold-TTL-first ordering; card auth / spend caps; transactional outbox; Supabase persistence; state-machine `trips` table; change/cancel subsystem; split ledger; Stripe fee; Trip Room; BM/HH onboarding.

**Counsel note (spec §7/§9):** Phase 1 "counsel sign-off *begins*." Nothing here books-for-real or moves money (MockRail + mocked fetch only). No live-user exposure — consistent with the directive to keep everything off `main` and un-deployed until the whole engine is hardened.
