# Phase 2c (retry-safety) — Honest cost vs honest value (Phase 0 gate)

> Written BEFORE the plan body, per the writing-plans augmentation. If the cheap version answers the
> same question, kill the plan.

## Where 2c stands

2c was originally scoped as one lump: "Supabase persistence + transactional outbox + `executeStaged`
retry-safety." The drift half of 2c already shipped (per-item price-drift enforcement inside the
staged loop). What remains is the lump above — and the lump is the problem, not the work.

`executeStaged`'s own doc comment still says **"call this exactly once per trip."** That is the last
un-guarded way this engine loses real money:

- The caller times out mid-`book` and retries → the rail is asked to book a second time.
- The process dies between `book` and `store.put` → a confirmed booking exists on the rail that our
  records have no memory of. Nothing compensates it; nobody knows to cancel it.
- A drift/cap abort unwinds correctly today, but a *crash* mid-unwind leaves live holds nobody
  releases.

None of that is hypothetical once this is mounted. All of it is invisible in every test we have,
because every test calls `executeStaged` exactly once against an in-memory store.

## The question this phase answers

> "If the caller retries — or the process dies mid-flight — does the engine refuse to double-book,
> and can it tell what it already did?"

## The insight that changes the cost

The expensive noun in the original scope is **Supabase**. It is also the one that answers none of the
question. The engine already has:

- `BookingStore` — a 3-method async interface (`get` / `put` / `all`), already injected into
  `Orchestrator`, already faked by `InMemoryBookingStore`.
- `bookingRecordId(tripId, itemId, rail)` — a **deterministic** key, `${tripId}:${itemId}:${rail}`.

Idempotency is a property of *consulting the store before acting on the rail*, keyed by that id. It is
not a property of which database is behind the store. A Supabase-backed `implements BookingStore` is a
later adapter swap that changes zero orchestration logic — exactly the seam Phase 0 built.

So the durable-persistence work and the money-safety work are **separable**, and only one of them is
urgent.

## Cheapest version that surfaces the same finding

Option A — **wire Supabase first, then idempotency on top.** ~half a day+, needs schema decisions
(table shape, migrations, RLS, connection handling, which project's instance) and drags real infra
into a subsystem with zero consumers.
- Surfaces: durable records survive a process restart.
- **Misses:** nothing about double-booking. A persisted store that the orchestrator still doesn't
  consult before calling `book` double-books exactly as cheerfully as an in-memory one. Costs the most,
  answers the question last.

Option B — **idempotency + resume against the existing `BookingStore` interface.** ~60–90 min.
- `executeStaged` consults the store per item before `hold`/`book`; an item already `confirmed` is
  skipped and its recorded result replayed rather than re-booked.
- A record is written **before** the irreversible call, so a crash between call and confirmation is
  detectable (in-flight, not lost).
- Tests drive the same `executeStaged` twice over one store, and simulate a crash by dropping a
  store write mid-flight.
- **Misses:** durability across a process restart — which the `InMemoryBookingStore` was never going
  to give us anyway, and which a later adapter grants for free without touching this logic.

## Verdict: BUILD (Option B). Supabase stays deferred.

Option B is strictly the cheaper half AND the half that removes the money risk. Option A is the
expensive half that removes none of it. Doing A first would be the 2026-05-10 backtest-fidelity
mistake again: building the infrastructure-shaped thing because it looks like the milestone, when a
much smaller change answers the actual question.

- **IN:** per-item idempotency in `executeStaged` (skip/replay confirmed work), write-before-act
  ordering, resume semantics, tests that call the engine twice and that simulate a mid-flight crash.
- **OUT (still deferred, unchanged):** Supabase-backed `BookingStore` implementation, transactional
  outbox, change/cancel subsystem (2d), card-auth 3DS UX (site). No real money, no deploy, no site
  mount, on-branch only.

## Counsel note

Unchanged from 2b: no real money, no deploy, no partner API keys (`fetch` stays faked). This phase
does not move the engine closer to being live — it moves it closer to being *safe to consider* going
live. Merging the concierge branch to `main` remains gated on the whole-branch adversarial review +
counsel, and `main` has not moved since the branch point, so there is no rot cost to waiting.
