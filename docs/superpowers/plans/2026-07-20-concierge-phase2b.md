# Planner Concierge Engine — Phase 2b (LiteAPI lodging + drift guard + villa deeplink) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development (RED→GREEN→commit per task). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Introduce the first **real two-price rail** — a LiteAPI lodging adapter whose *prebook* locks a
price that can differ from the *search* price — plus the `checkPriceDrift` guardrail primitive that
detects the gap, a **villa deeplink presenter** for the guest-facing surface, and a lodging **staged
dry-run** proving the engine runs clean over a non-Mock lodging rail. All against faked `fetch`, no
money, no infra, on-branch only.

**Why:** MockRail's `search`/`hold`/`book` prices are always equal, so the three money-safety flags the
2a reviewers deferred (price drift §11; `price_cents ?? 0` disabling caps; null railRef → double-book)
have never been exercised. 2b is the phase that makes them real and provably handled. See the
`is-this-worth-it` gate.

**Architecture:** Extends `src/concierge/`. Adds:
- `liteapi-adapter.ts` — `LiteAPIAdapter implements BookingRail`. `hold` = LiteAPI **prebook** (locks the
  authoritative price into `HoldResult.slot.priceCents`); `book` = LiteAPI **book**; `release` = no-op
  resolve (prebooks are transient — no cancel endpoint; they expire on their own). Money-safe mapping:
  **never `?? 0`** — un-priced search offers are *excluded*, an un-priced prebook *throws*; `book`
  **throws on a null/empty `bookingId`** (double-book guard) and on a non-finite amount.
- `price-drift.ts` — `checkPriceDrift(quotedCents, lockedCents, opts?)`: the §11 primitive. Upward drift
  beyond tolerance → error string; downward (cheaper) or within-tolerance → null. NaN-guarded.
- `lodging-deeplink.ts` — `buildLodgingDeeplink(args)`: pure, deterministic, PII-free tenant-aware URL
  to the lodging listing (`{host}/stay/{railSlotId}?...`).
- `dry-run.ts` — `runConciergeLodgingDryRun(args)`: `LiteAPIAdapter(built-in deterministic sandbox
  fetch)` → `resolveManifest` → `executeStaged` → per-confirmed-booking deeplinks. Zero external calls.

**Tech Stack:** TypeScript, vitest (`npx vitest run`), `tsc --noEmit`. No new runtime deps (global `fetch`).

## Global Constraints (carried from 2a, unchanged)

- Tenants `'moh' | 'bestman' | 'handicaphq'` only. OO/`'tdf'` unrepresentable.
- The LLM/`ProposalSource` may only propose; only the `Orchestrator` calls `hold`/`book`/`cancel`/`release`.
- Determinism: no `Math.random()` / `Date.now()` / argless `new Date()`. Prices are integer cents.
- **Money-safety mandate:** never map a missing price to `0`; never return a null/empty external ref
  that a later `cancel`/`status` would target; every money action stays audited by the orchestrator.
- MockRail-parity discipline: no real money, no deploy, no site mount, on-branch. `fetch` is faked.
- Conventions: tests in `src/__tests__/concierge-*.test.ts`; `import` from `../concierge/<file>`;
  export new public surface through `src/concierge/index.ts`. `noUncheckedIndexedAccess` is on.
- Commit trailer: end every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Scope guard — explicitly OUT (unchanged deferrals)

- **NOT rewiring `executeStaged`'s cap check to use the prebook price.** The engine still validates the
  quoted (search) price; tying the cap to the *locked* prebook price is 2c/live wiring (2a reviewer #4).
  2b ships the `checkPriceDrift` primitive + proves it against the adapter, and documents the deferral.
- NO Supabase persistence / transactional outbox / `executeStaged` retry-safety (2c).
- NO change/cancel subsystem (2d). NO card-auth 3DS UX (site).

---

## File Structure

- `src/concierge/liteapi-adapter.ts` — **NEW.** `LiteAPIAdapter`, `LiteAPIAdapterOpts`.
- `src/concierge/price-drift.ts` — **NEW.** `PriceDriftOpts`, `checkPriceDrift`.
- `src/concierge/lodging-deeplink.ts` — **NEW.** `LodgingDeeplinkArgs`, `buildLodgingDeeplink`, `LODGING_HOST`.
- `src/concierge/dry-run.ts` — **MODIFY.** Add `LodgingDryRunArgs` + `runConciergeLodgingDryRun` + the
  internal deterministic `liteApiSandboxFetch`.
- `src/concierge/index.ts` — **MODIFY.** `export * from` the three new files.
- Tests: `src/__tests__/concierge-{liteapi,price-drift,lodging-deeplink,lodging-dry-run}.test.ts`.

---

## Task 1: LiteAPIAdapter (prebook flow, money-safe) — RED→GREEN→commit

**Interfaces produced:** `class LiteAPIAdapter implements BookingRail` (railId `"liteapi"`);
`interface LiteAPIAdapterOpts { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }`.

**Mapping contract:**
- `search(q)` → POST `/rates` → map each offer to `RailSlot`. **Exclude** any offer whose price is not a
  finite number (never `?? 0`). Price → integer cents via `Math.round(amount*100)`; guard finite ≥ 0.
  Cancellation: refundable rate → `freeCancelUntil` from the policy; non-refundable → `refundable:false`.
- `hold(offerId, ctx)` → POST `/rates/prebook` → `HoldResult` with `holdRef = prebookId`,
  `expiresAt`, `slot.priceCents = ROUND(prebook price)` (**the authoritative locked price**). A prebook
  with no finite price **throws** (cannot proceed to book without a locked price).
- `book(prebookId, ctx)` → POST `/rates/book` → `BookResult`. **Throws if `bookingId` is missing/empty**
  (null railRef → double-book) or the amount is non-finite.
- `cancel(bookingId)` → PUT `/bookings/{id}` (LiteAPI cancels via status change) → `{ refundAmountCents }`.
- `release(prebookId)` → **no-op resolve** (prebooks are transient; LiteAPI has no prebook-cancel — it
  expires). Documented; matches the contract's "releasing resolves, not throws."
- `status(bookingId)` → GET `/bookings/{id}` → map to `BookingStatus`.

**Test (`concierge-liteapi.test.ts`):** fake-fetch sandbox à la GYG test.
- search maps to priced `RailSlot[]` with a real refundable policy; an un-priced offer is EXCLUDED.
- hold(prebook) returns a `slot.priceCents` equal to the **prebook** price even when it differs from
  search (drift is captured, not dropped).
- book returns non-zero amount + confirmation; a null-`bookingId` book response **throws**.
- release resolves (no throw); run `runBookingRailContract("LiteAPIAdapter(mock fetch)", make)`.

---

## Task 2: `checkPriceDrift` guard — RED→GREEN→commit

**Interfaces produced:** `interface PriceDriftOpts { toleranceCents?: number; toleranceFraction?: number }`;
`function checkPriceDrift(quotedCents: number, lockedCents: number, opts?: PriceDriftOpts): string | null`.

**Behavior:** null when `lockedCents <= quotedCents + tolerance` (cheaper or within tolerance is fine).
Error string naming both amounts when locked exceeds quoted beyond tolerance. Tolerance = max of the
absolute `toleranceCents` (default 0) and `ceil(quotedCents * toleranceFraction)` (default 0). NaN/negative
inputs → error (fail loud, never silently pass). Inclusive boundary (`==` cap allowed).

**Test (`concierge-price-drift.test.ts`):** within/at/over each tolerance mode; cheaper→null; NaN→error.

---

## Task 3: villa deeplink presenter — RED→GREEN→commit

**Interfaces produced:** `const LODGING_HOST: Record<ConciergeTenant,string>`;
`interface LodgingDeeplinkArgs { tenant: ConciergeTenant; railSlotId: string; checkIn?: string; checkOut?: string; partySize?: number }`;
`function buildLodgingDeeplink(args): string`.

**Behavior:** `https://{LODGING_HOST[tenant]}/stay/{encodeURIComponent(railSlotId)}` + sorted, encoded
query for any provided checkIn/checkOut/partySize. Deterministic; **no PII** (never name/email). Throws
on empty `railSlotId`.

**Test (`concierge-lodging-deeplink.test.ts`):** per-tenant host; encodes a slotId with special chars;
stable query ordering; omits absent params; throws on empty slotId; contains no PII fields.

---

## Task 4: lodging staged dry-run + barrel + full gate — RED→GREEN→commit

**Interfaces produced:** `interface LodgingDryRunArgs { tripId: string; tenant: ConciergeTenant; intents: BookingIntent[]; now: string; fetchImpl?: typeof fetch }`;
`async function runConciergeLodgingDryRun(args): Promise<{ manifest; staged: StagedResult; deeplinks: { itemId: string; url: string }[]; audit: AuditEntry[] }>`.

**Behavior:** builds `LiteAPIAdapter({ fetchImpl: args.fetchImpl ?? liteApiSandboxFetch() })` →
`resolveManifest` → `executeStaged` → for each `confirmed` result, `buildLodgingDeeplink`. The internal
`liteApiSandboxFetch` returns a deterministic refundable, priced lodging offer whose prebook price equals
search (clean happy path — drift is proven in Task 1/2, not here). Zero external calls.

**Test (`concierge-lodging-dry-run.test.ts`):** a lodging itinerary → `staged.state === "CONFIRMED"`,
one deeplink per confirmed booking pointing at the tenant host.

**Barrel:** add `export * from "./liteapi-adapter" | "./price-drift" | "./lodging-deeplink"` to `index.ts`.

**Full gate:** `npx tsc --noEmit` clean; `npx vitest run` all green (64 + Task1..4 additions).

---

## Self-Review checklist (fill at end)

- Money-safe mapping: no `?? 0` anywhere in the adapter; un-priced search excluded, un-priced prebook
  throws, null `bookingId` throws. ✅/❌
- Prebook is the authoritative locked price into `slot.priceCents`; drift observable. ✅/❌
- `checkPriceDrift` catches upward drift, allows cheaper, fails loud on NaN. ✅/❌
- Deeplink deterministic + PII-free + tenant-correct. ✅/❌
- Dry-run runs `executeStaged` over the LiteAPI adapter with zero network. ✅/❌
- Determinism: no `Date.now`/`Math.random`; `now` injected. ✅/❌
- Deferrals documented: cap check still uses quoted price (2c wires prebook); no persistence/outbox/
  change-cancel/3DS. ✅/❌
- Counsel note: no money, no deploy, no site mount, fetch faked. ✅/❌

## Adversarial whole-branch review (2 independent reviewers)
Per `feedback_adversarial_whole_branch_review`, money-safety mandate. Range: 2b tip vs 2a tip (314c907).
Record confirmed/fixed below after the run.
