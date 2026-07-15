# Planner Concierge Engine — Master Design Spec (v1)

**Date:** 2026-07-15
**Status:** Approved (design) — comprehensive v1, built & rolled out in verified phases
**Home:** `shared-engine` (tenant-agnostic backend). Consumer sites mount thin UI only.
**Tenants (v1):** **MOH** (maidofhonorhq — bachelorette), **BM** (plan-my-party / BestManHQ — bachelor party), **HH** (handicaphq — golf trips).
**Explicitly excluded:** **Offsite Outpost (OO)** — different product, not a tenant of this engine.
**Positioning:** A fully agent-driven concierge that turns *any* planner site's generated itinerary into a **booked, cost-split, on-the-ground group trip** (lodging, activities, dining — **no flights**) on rented merchant-of-record rails — while the business carries **zero fund custody and no seller-of-travel license**, and is *more* autonomous than the VC-funded competitors (The Bach, Layla), which keep a human in the loop or only book activities.

---

## 0. Multi-tenancy — the load-bearing constraint

**This is a backend, not a site feature. Zero site-specific logic lives in the engine.** The engine speaks a generic vocabulary — *group trip*, *participants*, *trip lead*, *honoree* — never "bachelorette" or "MOH." All tenant flavor comes from config.

- **Keys off the existing `BrandConfig`/`BrandId`** in `shared-engine/src/brand-config.ts` (already models bachelor vs bachelorette vocabulary, honoree terms, voice). The concierge adds a `ConciergeTenantConfig` that composes with it.
- **`ConciergeTenantConfig`** (per site): `{ siteId, brandId, tripNoun, categories[], railConfig, feeAmountCents, currency, tosRef, voiceProfile }`.
  - `categories` — which bookable categories this tenant uses (e.g. MOH/BM: lodging+activities+dining; HH: lodging+dining+golf+activities).
  - `railConfig` — which rail serves each category for this tenant (see §2; lets HH swap in a golf-tee-time rail without touching the engine).
  - `feeAmountCents` — per-tenant flat concierge fee.
- **A consumer site provides only three thin things:** (1) an intake extension in its own wizard, (2) a Trip Room UI, (3) its `ConciergeTenantConfig`. Everything else — resolver, adapters, orchestrator, saga, split ledger, fee, audit — is shared and built once.
- **Every row is tenant-scoped** by `site` (the existing `metadata.site` convention already separating MOH/BM in Supabase `bzmehrytiudgmgdrdlkg` and the Belmont Mills Stripe account). HH is onboarded as a new `site` value + its own Stripe webhook secret.
- **Pilot-then-onboard:** the engine is hardened on one pilot tenant (**MOH** — highest SEO demand per `project_moh_seo_driver_is_demand_0705`), then BM and HH are onboarded by adding a config + thin UI, not by writing engine code.

---

## 1. Locked decisions (from brainstorming + research)

| # | Decision | Choice | Why it matters |
|---|---|---|---|
| 1 | Money custody | **Never touch traveler funds** | No money-transmitter license |
| 2 | Booking execution | **API rails only; partner is merchant-of-record** | No card/3DS burden; partner carries fulfillment liability |
| 3 | Flights | **Excluded from v1** | "Arranging air/sea for compensation" is the CA/FL Seller-of-Travel trigger — dropping flights keeps us a *technology provider* |
| 4 | Split & collect | **Plan here, collect elsewhere** (our ledger + Venmo/PayPal; Splitwise optional) | No pooled wallet, no escrow, no MTL |
| 5 | Monetization | **Partner commission + flat per-tenant concierge fee** (Stripe Standard) | Not a per-booking travel markup (which would make us a seller of travel); non-custodial |
| 6 | Villa lodging | **Hotels/resorts auto-booked; villas = one-tap deeplink** | Airbnb/Vrbo have no self-serve booking API |
| 7 | Agent architecture | **Deterministic state-machine core; LLM confined to fuzzy steps** | `feedback_v0_is_safety_floor_for_llm` — an LLM must never move money |
| 8 | Trip atomicity | **Staged commit** (hold free-cancel items → assemble → one-tap commits non-refundables last) | No orphan bookings, no stuck money |
| 9 | Legal posture | **Build to a documented posture; counsel sign-off gates go-live** | Applies uniformly to all tenants (one LLC, one structure) |
| 10 | Scope | **Tenant-agnostic backend; MOH/BM/HH only; OO excluded** | Build once, roll out to three planner sites |

---

## 2. Rented stack (each partner carries the liability we're avoiding)

| Category | Rail | MoR / who charges the card | 3DS on us? | Hold→confirm two-step | Cancellation data + refund |
|---|---|---|---|---|---|
| Lodging (hotel/resort) | **LiteAPI / Nuitée** | Partner (Payment SDK) | **No** — SDK absorbs 3DS | `preBook → book` | Policy + NRFN at preBook; `cancelBooking` returns fee + refund |
| Lodging (villa/STR) | **Airbnb/Vrbo deeplink** (not a rail) | N/A (traveler books off-site) | N/A | N/A | Off-platform |
| Activities/tours | **GetYourGuide Partner API** | Partner (commercial agent) | **No** | `reserve → book` | Policy exposed; GYG refunds customer directly |
| Dining | **OpenTable Partner API** | N/A (no money) | N/A | `slot_lock → reservation` | modify/cancel by RID + confirmation |
| **Golf tee-times (HH only)** | **GolfNow / tenant rail (deferred)** | TBD at integration | TBD | TBD | Plugs into the same `BookingRail` interface via `railConfig`; **not v1-core** — HH ships v1 on lodging/dining/activities, tee-times as a fast-follow adapter (or activity-style deeplink initially) |
| Concierge fee | **Stripe Standard** (Checkout Session, `mode:payment`) | Us (our own fee only) | Stripe | N/A | Refund via Stripe if we cancel service |

**Deliberately dropped:** Duffel Stays (forces 3DS + two-legged card refund onto us; its main value is flights, excluded). Net-rate bedbanks (RateHawk/Hotelbeds) — they make *us* the seller of record. Venmo/Cash App APIs — dead for automation.

**Access lead-time:** LiteAPI + Stripe are self-serve. **GetYourGuide + OpenTable partner/sandbox access are approval-gated (weeks)** — apply at kickoff; build against `MockRail` meanwhile.

---

## 3. Architecture

### 3.1 Core principle — LLM proposes, deterministic core disposes

```
                    ┌─────────────── LLM (fuzzy only) ───────────────┐
                    │ interpret itinerary → booking intents          │
                    │ rank candidates (which hotel/restaurant/tour)  │
                    │ draft human copy (collection msgs, summaries)  │
                    └───────────────────────┬────────────────────────┘
                                            │ proposals (never actions)
                                            ▼
        ┌──────────── Deterministic guardrails (validate every proposal) ───────────┐
        │  schema-valid? within budget caps? candidate available? policy read?      │
        └───────────────────────────────────┬───────────────────────────────────────┘
                                            ▼
        ┌──────────────── Deterministic state-machine orchestrator ─────────────────┐
        │  holds · staged commit · saga + compensations · outbox · audit log        │
        │  the ONLY thing that ever calls book / charge / cancel                     │
        └───────────────────────────────────────────────────────────────────────────┘
```

The LLM **cannot** call book/charge/cancel. It emits validated proposals; the deterministic core executes. Money-moving commits happen only via the no-money auto-path (dining) or the trip lead's explicit one-tap confirm.

### 3.2 Components (each isolated & testable; `[engine]` = shared, `[site]` = thin consumer)

| Component | Responsibility | Where |
|---|---|---|
| **Intake extension** | Roster, dates, party size, destination, trip lead, per-person budget ceilings, total + per-category spend caps, ToS/consent capture — rendered per-site, schema generic | `[site]` UI → `[engine]` schema |
| **Bookable-Plan Resolver** | LLM turns itinerary → structured intents; guardrails validate; query rails for live price/availability/cancellation → ranked **booking manifest** | `[engine]` |
| **Rail adapters** | `BookingRail` interface + `LiteApiAdapter`, `GetYourGuideAdapter`, `OpenTableAdapter`, `MockRail`, `VillaDeeplinkPresenter`; tenant rails via `railConfig` | `[engine]` |
| **Authorization gate** | Trip lead authorizes own card at partner + spend caps + per-booking supplier-terms acceptance + authority-to-bind-co-travelers | `[engine]` + `[site]` |
| **Booking Orchestrator** | Deterministic saga: hold free-cancel items → assemble priced trip → `PENDING_CONFIRM` → on one-tap commit non-refundables shortest-TTL-first; compensations; outbox-driven; audit-logged | `[engine]` |
| **Change/Cancel subsystem** | Post-confirm changes, drop-outs, compensating cancels within free windows, refund routing to partner, split recompute | `[engine]` |
| **Split & Settle** | Own per-person itemized ledger from *actual booked* totals; Venmo/PayPal deep-links; optional Splitwise export; nudges | `[engine]` + `[site]` UI |
| **Monetization** | Stripe Checkout for the tenant's flat fee at finalize; per-booking commission accrual | `[engine]` |
| **Trip Room** | Live status, hold countdowns, one-tap confirm CTA, who-owes/who-paid, change/cancel controls | `[site]` UI over `[engine]` state |
| **Trust/Legal layer** | ToS, disclosures, consent logging, disclaimers, support/escalation | both |
| **Observability** | Audit log, outbox relay monitor, hold-TTL monitor, stuck-saga alerts | `[engine]` |

Mirror shared-surface changes through the MOH↔BM pre-commit parity check; extend it to include HH when HH is onboarded.

### 3.3 Trip state machine

```
DRAFT ─▶ RESOLVING ─▶ HELD ─▶ PENDING_CONFIRM ─▶ COMMITTING ─▶ CONFIRMED ─▶ SETTLED
  │          │          │            │                │            │  │
  │          │          │            │                │            │  └▶ CHANGE_REQUESTED ─▶ RESOLVING
  │          │          │            │                │            └───▶ CANCELLING ─▶ (compensations) ─▶ CANCELLED
  └──────────┴──────────┴────────────┴── ABORT (compensate any holds/bookings) ─▶ FAILED
```

- **HELD:** all free-cancel/holdable items reserved. No non-refundable commitment yet.
- **PENDING_CONFIRM:** full priced trip assembled; awaiting the lead's single one-tap. Hold TTLs ticking — the critical window.
- **COMMITTING:** commit non-refundables **shortest-hold-TTL-first**; any failure triggers compensations.
- **SETTLED:** split ledger posted + concierge fee charged.

---

## 4. Correctness spine (non-negotiable for a money-moving system)

1. **Idempotency everywhere** — external-call keys derived from `(site, trip_id, item_id, step)`, never random.
2. **Transactional outbox** — the intent to call an external API is written in the same DB transaction as the state change; a relay performs the call. No dual-write orphans.
3. **Orchestrated saga with compensating actions** — each booking step defines its compensation (cancel booking, release hold, refund via partner, delete split).
4. **Append-only audit log** — immutable, timestamped rows for every money-moving action. The forensic record for chargebacks/disputes.
5. **Hold-expiry is the primary failure mode** — every hold (15–30 min) tracked with its TTL; commit shortest-TTL-first; an expired hold is a first-class re-resolve/compensate event, never a silent lapse.

---

## 5. Data model (Supabase `bzmehrytiudgmgdrdlkg`, tenant-scoped by `site`)

| Table | Key columns | Notes |
|---|---|---|
| `trips` | id, **site**, status, dates, destination, party_size, lead_contact, total_cap, category_caps, consent_ref | Tenant-scoped; state-machine anchor |
| `participants` | id, trip_id, name, email, budget_ceiling, owed_amount, paid_status | Split targets |
| `manifest_items` | id, trip_id, category, intent, chosen_candidate, rail, hold_ref, hold_expires_at, price, cancellation_policy, status | Resolver output + hold tracking |
| `bookings` | id, trip_id, item_id, rail, rail_ref, status, confirmation_code, amount, refundable, refund_amount | **Idempotent by `(trip_id, item_id, rail)`** |
| `outbox` | id, trip_id, action, payload, status, attempts | Exactly-once external calls |
| `audit_log` | id, trip_id, actor, action, external_ref, amount, ts | **Append-only** |
| `fee_charges` | id, trip_id, **site**, stripe_session_id, amount, status | Per-tenant concierge fee |
| `commissions` | id, trip_id, booking_id, rail, amount, status | Revenue accrual |

---

## 6. Money flows (all non-custodial, identical across tenants)

- **Vendor payment:** the trip lead authorizes **their own card at the MoR partner** per booking (no silent stored-card push). Partner charges + is merchant of record. We never touch it.
- **Cost split:** our ledger computes each participant's itemized share from *actual booked* totals; participants settle via Venmo/PayPal deep-links (optional Splitwise export). **We never pool participant funds** — the one money-transmitter bright line.
- **Concierge fee:** Stripe Standard Checkout Session (`mode:payment`, one-time, idempotency key `= (site, trip_id)`, `metadata.site=<tenant>`, Belmont Mills LLC, per-tenant webhook secret) at finalize; `checkout.session.completed` unlocks. Merchant of record on our fee only.

---

## 7. Legal / trust posture (one LLC, one posture, all tenants; counsel signs off before real-user go-live)

- **Technology-provider structure:** no flights; flat software fee (never a per-booking travel markup); traveler authorizes their own card at the MoR partner; ToS grants **limited agency with no authority to modify supplier terms**; per-booking supplier-terms acceptance; explicit "partner is seller & merchant of record / no traveler funds held / no commingling" reps; organizer represents authority to bind co-travelers.
- **Residual state exposure (no-flights):** CA/FL air-sea triggers largely cleared; possible light-touch registration in **WA** (register, *no* bond) and **HI**. Counsel confirms the matrix — same analysis covers all three tenants since it's one entity/structure.
- **Counsel checklist before go-live:** (1) seller-of-travel registration matrix given no flights; (2) flat-fee-not-a-markup characterization; (3) ToS + authorization-flow review; (4) confirm no MTL exposure on our fee; (5) Splitwise commercial-use sign-off.
- **Unsettled (flag, don't rely):** whether an autonomous AI "arranger" changes the analysis — conservative bridge: keep the human traveler as the card-authorizing party (design already does).

---

## 8. Testing strategy (TDD throughout)

- **Adapter contract suite** — every rail + `MockRail` satisfies one shared `BookingRail` contract.
- **Resolver tests** — LLM proposals schema-validated; guardrails reject out-of-budget / unavailable / policy-missing.
- **Orchestrator saga tests (against `MockRail`)** — idempotency, partial-failure isolation, **hold-expiry handling**, compensation correctness, the **no-orphan invariant**.
- **State-machine transition tests** — every legal/illegal transition.
- **Money-safety tests** — no double-charge, outbox exactly-once, audit completeness.
- **Multi-tenant isolation tests** — a `site`'s trips/fees/rails never leak across tenants; `ConciergeTenantConfig` swap changes behavior with no engine code change.
- **Dry-run mode** — full loop against `MockRail`, zero external calls, in CI.
- **Sandbox e2e** — one smoke test per rail once creds land.

---

## 9. Phased build & rollout (perfection *via* increments — no real users on a money layer until hardened)

Engine is built & hardened on the **MOH pilot**, then BM + HH are onboarded by config.

| Phase | Adds | Money? | Gate |
|---|---|---|---|
| **0 — Wedge proof** | `ConciergeTenantConfig` scaffold + Resolver + **OpenTable dining** (MockRail-first, sandbox on approval), on MOH | No | Loop proven; no-money closed beta OK pre-counsel |
| **1 — First commission** | **GetYourGuide activities** + hold/reserve + saga compensation (paid, partner-MoR rail) | Partner-charged | Saga + audit spine green; **counsel sign-off begins** |
| **2 — Lodging + commit engine** | **LiteAPI lodging** + card auth + spend caps + **staged-commit one-tap** + change/cancel subsystem + full outbox/saga/audit; villa deeplink | Partner-charged | **Counsel sign-off complete**; money-safety suite green |
| **3 — Split + fee + polish** | Own split-ledger + Venmo/PayPal deep-links (+ optional Splitwise) + **Stripe fee** + Trip Room | Our fee | Full e2e; Trip Room UX audit |
| **4 — Tenant onboarding** | Add **BM** + **HH** `ConciergeTenantConfig` + thin intake/Trip Room; HH golf-tee-time rail as fast-follow | — | Per-tenant isolation tests green; parity check extended to HH |

**Hard gate:** nothing that books-for-real or charges ships to real users until counsel clears the posture (§7). Phase 0 (no money) may run a closed beta beforehand. **OO is never a tenant of this engine.**

---

## 10. Deferred (YAGNI)

Flights; programmatic villa/Vrbo booking; in-product Stripe-Connect split; pooled/group wallet; live group chat; multi-currency; non-US trips; **OO** (separate product). Each is a documented future item, not a v1 requirement.

---

## 11. Open items to resolve during planning

- GetYourGuide + OpenTable partner-approval applications (start at kickoff — weeks of lead time).
- Exact `BookingRail` + `ConciergeTenantConfig` interface signatures; per-rail quirks (LiteAPI preBook price-drift flag; GYG reservation TTL; OpenTable slot-lock TTL).
- How `ConciergeTenantConfig` composes with existing `BrandConfig`/`BrandId`.
- HH golf category → rail decision (GolfNow adapter vs activity-deeplink for v1).
- Card-authorization UX with LiteAPI's Payment SDK (tokenization + 3DS handoff).
- Splitwise commercial-use email + own-ledger fallback as primary.
- Trip Room hold-countdown UX and the one-tap confirm affordance.
