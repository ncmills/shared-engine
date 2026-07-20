# Phase 2b — Honest cost vs honest value (Phase 0 gate)

> Written BEFORE the plan body, per the writing-plans augmentation. If the cheap version answers the
> same question, kill the plan.

## What Phase 2b is for

The staged-commit engine (2a) is proven only against `MockRail` — a rail whose `hold` price always
equals its `search` price and whose `book` amount always equals both. Every real money-safety flag the
2a reviewers deferred is a property of a **real** rail that MockRail cannot exhibit:

- **Price drift** (master spec §11): LiteAPI locks a price at *prebook*, which can differ from the
  price shown at *search*. MockRail never drifts, so the engine has never seen it.
- **`price_cents ?? 0`**: MockRail always returns a price. A live adapter that maps a missing rate to
  `0` would silently disable the spend-caps guardrail. Never exercised.
- **null `booking_id`/`voucher_code` → double-book**: MockRail always returns concrete refs. A live
  adapter that returns a null railRef would let `status()`/`cancel()` target nothing.

Phase 2b introduces the **first rail with a two-price flow** (search-price ≠ prebook-price) plus the
guardrail primitive that detects the gap, and proves the lodging path end-to-end through the staged
engine. It also adds the **villa deeplink presenter** the site needs to show a guest what was booked.

## The question this phase answers

> "When a real lodging rail locks a *different* price at prebook than it quoted at search, does our
> money-safety layer see it — and does a missing/un-priced rate get rejected rather than silently
> zeroed?"

## Cheapest version that surfaces the same finding

Option A — **just a `checkPriceDrift` util + a unit test** (no adapter, no dry-run). ~20 min.
- Surfaces: the drift arithmetic is correct.
- **Misses:** whether a *real* prebook flow actually produces a distinct locked price into a
  `RailSlot`; whether the money-safe mapping (`?? 0` ban, ref-narrowing) holds on a fetch adapter;
  whether the staged engine runs clean over a non-Mock lodging rail. i.e. it proves the calculator,
  not that anything upstream feeds it real numbers — exactly the gap that bit the 2a deferrals.

Option B — **full 2b** (adapter with real prebook flow + drift util + presenter + lodging dry-run).
~90–120 min.
- Surfaces everything Option A does, PLUS: the adapter actually maps a drifted prebook into
  `HoldResult.slot.priceCents`; the resolver/orchestrator run over it unchanged; the `?? 0` ban and
  ref-narrowing are enforced by tests that fail loudly; the deeplink the site consumes exists.

## Verdict: BUILD (Option B)

The cheap version (A) proves arithmetic we could eyeball. It does **not** de-risk the three deferred
money-safety flags, which are the entire reason 2b exists — those only show up when a real two-price
adapter feeds the engine. The full phase is the cheapest version that answers the actual question.

Scope discipline kept tight to avoid the 2a "bundled row" trap:
- **IN:** LiteAPI adapter (search/prebook-as-hold/book/cancel/release/status), `checkPriceDrift`
  primitive, villa deeplink presenter, lodging staged dry-run.
- **OUT (later sub-phases, unchanged):** Supabase persistence + transactional outbox + retry-safety
  (2c); change/cancel subsystem (2d); card-auth 3DS UX (site). **Not rewiring `executeStaged`'s cap
  check to use the prebook price** — that live-wiring lands in 2c; 2b ships the primitive + proves it
  against the adapter, and documents the deferral. Still MockRail-parity discipline: no real money, no
  deploy, no site mount, on-branch only.

## Counsel note

No real money, no deploy, no partner API keys used (fetch is faked in tests). Consistent with the
build-on-branch-until-hardened-then-counsel-then-live directive. Partner-approval apps
(GetYourGuide / OpenTable / LiteAPI) remain a parallel human track — code readiness ≠ go-live.
