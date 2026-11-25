# Concierge Phase 1 — Is This Worth It? (honest-cost gate)

**Date:** 2026-07-15
**Gate owner rule:** `~/.claude/CLAUDE.md` — writing-plans Phase 0 honest-cost check.

## What Phase 1 is supposed to prove
That the deterministic core can execute a **multi-item, paid, partner-MoR booking manifest** with:
1. a **correct compensation path** (any booking failure ⇒ every already-booked item is cancelled ⇒ zero orphans), and
2. an **append-only audit trail** of every hold/book/cancel,
against a **real-shaped paid rail** (GetYourGuide `reserve → book`, real cancellation policy + non-zero price), all provable in CI with **no money and no external calls** (MockRail + mocked fetch).

This is the first phase where a bug leaves a real, non-refundable booking stranded. The compensation/audit spine is the whole point.

## Cheapest version that surfaces the same finding
Add `executeSaga()` + `AuditLog` to the orchestrator and test it against `MockRail` only — **skip the GetYourGuide adapter**.

- **What the cheap version proves:** the saga/compensation/audit machinery is correct.
- **What it MISSES:** that the `BookingRail` contract actually generalizes from a free, no-policy dining rail to a **paid rail with a real cancellation policy and a non-zero refund on cancel** — i.e. that compensation calls `cancel` on a rail that returns a real `refundAmountCents`, and that the resolver's budget/policy guardrails fire on priced candidates. The dining rail can't exercise any of that (price is always 0, policy is always trivially refundable).

## Verdict: build the full phase
The GYG adapter is **cheap** — it mirrors the existing `OpenTableAdapter` template almost line-for-line (fetch + mocked-fetch contract test) — and it's the only thing that exercises the paid/refundable path the compensation spine exists to protect. Cutting it would mean shipping a compensation engine that has never once cancelled a booking with a real refund. Not worth the saving.

**Scope discipline (what Phase 1 does NOT include — deferred to Phase 2 per master spec §9):**
- Staged-commit **one-tap** + shortest-hold-TTL-first ordering (Phase 2).
- Card authorization / LiteAPI Payment SDK / spend-cap UX (Phase 2).
- Transactional **outbox** + Supabase persistence (Phase 2 — Phase 1 stays in-memory).
- Split ledger / Stripe fee / Trip Room (Phase 3).
- BM/HH onboarding (Phase 4).

Phase 1 = **prove compensation + audit on a paid rail, in memory, no money.**
