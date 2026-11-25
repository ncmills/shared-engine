# Is this worth it? — Planner Concierge Engine, Phase 0

**Written before the plan body, per planning discipline.**

## The one question Phase 0 answers

Can a **deterministic core** turn a planner-site's generated itinerary into a **real, confirmed booking** on an external rail — tenant-agnostically, with the LLM confined to proposing (never acting)? If that loop doesn't work cleanly, nothing downstream (money, saga, split, fee) is worth building.

## Cheapest version that surfaces that finding

**Phase 0: `ConciergeTenantConfig` + `BookingRail` interface + `MockRail` + `OpenTableAdapter` + Resolver + a minimal dining-only orchestrator + status read.**

- **Dining (OpenTable) is the rail** precisely because *no money moves* — so we prove the whole agentic-booking loop with **zero legal exposure, zero card handling, zero custody**.
- **MockRail-first:** the entire loop is built and proven against `MockRail` in CI, so Phase 0 ships **without waiting on OpenTable's weeks-long partner approval**. The `OpenTableAdapter` is written to the same contract and swapped in against sandbox once creds land.

## Cost comparison

| | Cheap version (Phase 0) | Full v1 (all phases) |
|---|---|---|
| Subsystems | Resolver + 1 rail + minimal orchestrator | + card auth, staged-commit saga, change/cancel, split ledger, Stripe fee, Trip Room, 3 tenants |
| Money movement | **None** | Real, non-refundable bookings + our fee |
| Legal gate | **None** (no money) | Counsel sign-off required before go-live |
| External approvals blocking | None (MockRail-first) | GYG + OpenTable partner approval; legal |
| Rough effort | Days | Weeks |

## What the cheap version deliberately misses

Money movement, staged-commit correctness under real non-refundable holds, card authorization + 3DS, the split ledger, the concierge fee, and multi-tenant onboarding. **That's fine** — each is an explicitly later phase with its own risk, and none of them is worth building until Phase 0 proves the core loop is real. If Phase 0 works, we plan Phase 1. If it doesn't, we've spent days, not weeks, and learned the thing that kills or reshapes the project.

## Verdict

**Worth it — and Phase 0 is the correct first (and only) plan to write now.** It is the minimum that produces working, testable software *and* de-risks the entire concept. Do **not** write the full-v1 plan up front; plan Phase 0, execute, prove the loop, then plan Phase 1 against what we learned.
