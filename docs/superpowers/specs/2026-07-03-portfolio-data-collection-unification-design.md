# Portfolio Data-Collection Unification — Design Spec

**Date:** 2026-07-03
**Anchor repo:** `shared-engine` (source of truth for the regime)
**Sites touched:** `plan-my-party` (BMHQ), `maid-of-honor-hq` (MOH), `offsite-outpost` (OO), `handicap-hq` (HHQ) + shared Supabase `bzmehrytiudgmgdrdlkg`
**Status:** Design — awaiting Nick's review before writing the implementation plan.

---

## 1. Problem

Nick wants to "expand the data-collection regime from BM/MOH to OO/HHQ." Investigation showed the signal *plumbing* (route + rate-limit + emit helpers + 8-table allow-list + shared `wp_*` Supabase) already exists on all four sites. The real gaps are in **what actually gets fired, analyzed, and captured as leads** — and, underneath, in the fact that OO and HHQ **forked** their own copies of the engine (`oo-engine`, HHQ `src/lib/*`) instead of importing `shared-engine`. Those forks are the root cause of drift (three divergent PII-scrub sets writing to one shared DB).

Two findings reframed the request:

1. **BM/MOH is not a clean gold standard.** Its destination-popularity loop is *write-only* — it records views but never reads them back into plan generation. **HHQ has the only fully-closed popularity→ranking loop in the portfolio.** Literally "matching BM/MOH" would *downgrade* HHQ.
2. **The forks perpetuate drift.** Porting features fork-by-fork guarantees the PII/behavior sets keep diverging.

## 2. Decisions (locked with Nick)

- **Architecture:** Full converge onto `shared-engine`. The forks (`oo-engine` signals/vid/priors/lead-capture/analytics; HHQ `src/lib/signals|vid|lead-capture`) are deleted; every site imports the canonical modules.
- **Standard:** Best-of-portfolio, not literal parity. Standardize on the strongest version of each mechanism — HHQ's closed popularity loop + BM/MOH's wizard-field priors + HHQ's PII superset (with array recursion). This includes fixing BM/MOH's write-only popularity loop.
- **Scope:** One combined push covering all four dimensions on both target sites (and the necessary shared-engine + BM/MOH changes), delivered in a **lossless, staged rollout** (shared-engine → one site → verify → next). Not a big-bang cutover across four live sites.
- **HHQ brand:** Introduce a clean **`handicaphq`** brand. All historical `tdf` behavioral/lead rows in `wp_*` are golf-planner origin (verified: TDF-personal has no signals/wizard route; every current `tdf` emitter is HHQ), so they are **backfilled `tdf` → `handicaphq`** losslessly. OO keeps its existing `offsite` brand.

## 3. Goals / Non-goals

**Goals**
- One canonical data-collection engine in `shared-engine`, imported by all four sites.
- OO and HHQ reach best-of-portfolio capture, analytics/priors, and lead/profile parity.
- Closed loops everywhere they make sense: collect → aggregate → feed back into plan generation and Surprise Me.
- No data loss; no UX regression; no regression of HHQ's already-working popularity loop.

**Non-goals**
- Collaborative/post-trip capture surfaces (`wp_trip_room_*`, `wp_trip_memory`, `bestman_trip_submissions`, room-covers bucket) — feature-gated; only port if/when OO or HHQ ship a shared-trip/room feature. Reference schemas noted for later.
- Touching Stripe `metadata.site` tagging (separate system; TDF pro-shop keeps `tdf` there).
- `plan_bookmarks` / `offer_clicks` / `offer_conversions` emit wiring — unused across all four sites today (R1+); allow-list stays, no new emitters in this push.

## 4. Evidence — the gap map (4 dimensions × 2 targets)

| Dimension | OO — heavy lift | HHQ — nearly there |
|---|---|---|
| **Fire coverage** | `plan_inputs` never fires (generate route emits zero → no WizardState captured). No dwell timing, no AcquisitionBeacon, no surprise-me. | Fires `plan_inputs` but hand-enumerates ~20 fields instead of the full `wizardState` blob (drops unlisted fields). Has dwell + acquisition. Missing surprise-me. |
| **Analytics/priors** | Both endpoints exist but no bridge: no aggregator, no overlay artifact, static priors never reach a surface, `surprise-me.ts` is dead (no route). | No wizard-field priors layer at all — but has the closed popularity loop BM/MOH lack. |
| **Leads/profile** | No email lifecycle whatsoever (no schedule/cron/unsubscribe/subscribe funnel). Split, thin `oo_leads` unreconciled with `wp_leads`. event_date/days_to_event always null. | Essentially at parity. Only gap: no in-repo migrations (schema inherited from shared DB). |
| **Schema/newer** | No `leads_profile` migration in-repo, no `venue_geocoding` cache, weaker PII scrub. | Best PII scrubber in portfolio; no `venue_geocoding` cache; brand-check hygiene to confirm. |

## 5. Architecture — `shared-engine` as single source of truth

Six canonical modules, each promoted to or upgraded in `shared-engine`. Brand-specific bits (wizard field schemas, track names, tier slugs) are passed in as **config**, never hardcoded, so one engine serves all four brands.

1. **signals** — emit helpers (`logSignal`, `logSelection`, `logBookmark`, `logAcquisition`, `logLeadSignal`, `logSignalServer`) + `stripPII` (canonicalized on HHQ's superset: `attendeeEmail(s)`, `ip`, `ipAddress`, `ssn`, `address`, `streetAddress`, `attendees`, `attendeeNames`, existing banned set — **with array-element recursion**) + `vid` join-key cookie.
2. **priors** — static fallbacks (`priorsForBrand`) + `priors-builder` (reads `wp_plan_inputs` back → per-field weighted overlay, gated `minSamples`/`minBucket`) + `registerPriorOverlay` runtime wiring.
3. **popularity** — destination views/selects → ranking scores. **Lift HHQ's closed loop (`getAllPopularityScores` → `setPopularityScores` → capped ranking bonus in query) in as the canonical implementation.**
4. **lead-capture** — `buildLeadProfile` + derived scalars (event_date, days_to_event, group_size, est_spend, spend_tier, quality_band/score) → `wp_leads` + `leads_profile`.
5. **email lifecycle** — `email-scheduler` + welcome drip + cron-drain contract + unsubscribe.
6. **acquisition** — `AcquisitionBeacon` component (referrer/UTM/device on first pageview).

`Brand` type extends to `moh | bestman | tdf | offsite | handicaphq`. (`tdf` retained in the type for historical rows; no site emits it after WS2.)

## 6. Workstreams (one push, lossless staged order)

### WS0 — shared-engine canonical core (do first; everything imports it)
- Promote/upgrade the six modules. Extend `Brand`. Canonicalize `stripPII` on HHQ's superset + array recursion.
- Parameterize brand-specific config (wizard schema, tracks, tiers) via injected config objects.
- Lift HHQ's popularity loop and BM/MOH's priors-builder into the shared module set.
- Version bump. **Gate:** nothing ships to a site until shared-engine is green (typecheck + unit tests on the pure functions: stripPII, prior aggregation, popularity scoring, buildLeadProfile).

### WS1 — OO converge + fill (heaviest)
- Delete `oo-engine` signals/vid/priors/lead-capture/analytics → import `shared-engine`.
- **Fire coverage:** emit `plan_inputs` with full `wizardState` in the generate route (its #1 gap — currently zero rows); add per-step dwell timing to `OutingWizard`/`RetreatWizard`; mount `AcquisitionBeacon`; add `SurpriseMeButton` + surprise-me route → `surprise_me_actions`.
- **Leads:** reconcile thin `oo_leads` into `wp_leads` + `leads_profile` (backfill existing `oo_leads` rows; retire or view-alias the old table — lossless); add full email lifecycle (schedule migration, scheduler, cron, unsubscribe, subscribe funnel).
- **Loops:** wire priors-builder cron + overlay + `registerPriorOverlay`; adopt the destination-popularity loop.

### WS2 — HHQ converge + fill (smaller)
- Replace HHQ `src/lib` signals/vid/lead-capture with `shared-engine` imports.
- Fix `plan_inputs` to ship the full `wizardState` blob (stop hand-enumerating).
- Add the wizard-field priors layer it lacks (static + builder + `SurpriseMeButton` + route).
- Add in-repo `supabase/migrations` reproducing HHQ's inherited schema (fresh-clone reproducibility).
- **Brand switch:** emit `handicaphq` going forward; backfill historical `tdf` → `handicaphq` across all `wp_*` tables (see §7). HHQ's popularity loop is lifted into shared-engine in WS0, then re-imported here (not rewritten).

### WS3 — BM/MOH best-of-portfolio backfill
- Inherit HHQ's PII superset + array recursion automatically via shared-engine.
- **Close the write-only popularity loop:** read `getPopularityScores` back into `generate-plan` ranking using the canonical popularity module from WS0.

### WS4 — shared Supabase unification
- Canonical migrations: `leads_profile`, `email_schedule`, `venue_geocoding`; brand `CHECK` constraints updated for `offsite` + `handicaphq`.
- Adopt shared `venue_geocoding` cache on OO + HHQ (stop re-hitting Google Places).
- Cross-brand segregation validation (rows land under the correct brand).

## 7. Lossless `tdf` → `handicaphq` brand migration

- **Precondition (verified):** TDF-personal has no signals route and no wizard/generate route; every current `brand: "tdf"` emitter lives in `handicap-hq`. All existing `tdf` rows in `wp_*` are golf-planner origin.
- **Migration:** one-time backfill `UPDATE ... SET brand='handicaphq' WHERE brand='tdf'` across every `wp_*` behavioral + lead + email table (`wp_plan_inputs`, `wp_plan_selections`, `wp_acquisition_log`, `wp_leads`, `wp_email_schedule`, etc.). Run after WS0 extends the brand `CHECK` constraints to accept `handicaphq`, and coordinated with HHQ's emitter cutover so no row is written under `tdf` mid-migration.
- **Out of scope:** Stripe `metadata.site="tdf"` (TDF pro-shop) is untouched.
- **Verification:** zero `tdf` rows remain in `wp_*` after backfill; new HHQ emits all carry `handicaphq`; row counts before/after match (lossless).

## 8. Safety / verification (4 live sites)

- Signals stay strictly fire-and-forget — analytics failures never block UX. Preserve the 204-always contract.
- Rollout is **shared-engine → one site → verify → next**, even inside "one push." No big-bang cutover.
- Per-site verification battery: brand-segregation query; `plan_inputs` actually populating (esp. OO, currently zero); HHQ popularity loop **not regressed**; leads still flowing; email drip still scheduling.
- `~/e2e` wedding smoke suite gates BM/MOH; OO + HHQ get equivalent smoke checks before their cutover.
- Multi-repo change (`feedback_parallel_session_commits`): staged commits per repo, no bare `git commit -a` sweeps, no concurrent-session index races.
- Deployed-vs-running: confirm each site's deployed build actually imports the bumped `shared-engine` version before claiming a site done.

## 9. Open items / risks

- **shared-engine as a github dependency:** OO/HHQ currently import `shared-data` but not `shared-engine`. Adding it means a new dep + version-pin discipline across four consumers. Confirm the publish/consume flow (git tag vs branch pin) during WS0.
- **Config surface for brand-specific wizard schemas:** the priors-builder and plan_inputs capture must handle four different WizardState shapes. Config injection must be typed per brand; validate no field loss on any brand.
- **HHQ brand-check hygiene:** confirm HHQ isn't silently rejected by any `wp_*` brand `CHECK` it doesn't own before/after the `handicaphq` addition.
- **oo_leads retirement:** decide view-alias vs drop after backfill — keep lossless.

## 10. Success criteria

- All four sites import one `shared-engine` regime; forks deleted; one canonical `stripPII`.
- OO `wp_plan_inputs` populating with full WizardState; OO dwell timing, acquisition, and Surprise Me firing; OO email lifecycle live.
- HHQ `plan_inputs` ships full `wizardState`; HHQ wizard-field priors + Surprise Me live; HHQ in-repo migrations present; HHQ on `handicaphq` brand with zero `tdf` rows remaining.
- BM/MOH popularity loop closed (reads back into ranking); all four on HHQ's PII superset.
- Shared `venue_geocoding` cache adopted by OO + HHQ; canonical migrations committed.
- Cross-brand segregation validated; no data loss; no UX regression.
