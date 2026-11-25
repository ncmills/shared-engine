# Portfolio Data Resale Program — Design Spec

**Date:** 2026-07-05
**Author:** Nick + Claude
**Status:** Draft for review
**Depends on:** `spec/portfolio-data-collection-unification` (WS0 — standardized `wp_*` tables, `stripPII`, `lead-profile`, `AcquisitionBeacon`). This program builds on top of that layer and should branch from it.
**Grounding audit:** `~/work/notes/2026-07-05-portfolio-data-collection-audit.md`

---

## 1. Goal

Turn the portfolio's first-party behavioral data into a sellable product: **for a given person (by email), package exactly what they clicked / selected / are interested in across all sites, and export it — segmented — to buyers.** Maximize data collected per identity. Do it lawfully: consented data only, sensitive categories gated behind legal sign-off.

Scope decision (Nick, 2026-07-05): **A + B + C** — all 10 data-rich sites, with Bucket C (sensitive) export hard-gated behind counsel.

## 2. Non-goals / hard constraints

These are load-bearing. The build is wrong if it violates any:

1. **Opt-out export model (Nick, 2026-07-05).** A record is sellable BY DEFAULT and leaves the system **unless `do_not_sell = true`** (set by a GPC signal or a Do-Not-Sell request). No opt-in is required — this is lawful under CCPA/CPRA's opt-out regime — BUT two things are mandatory for it to stay lawful: (a) every capture point carries a **notice-at-collection**, and (b) the **privacy policy discloses the opt-out sale** (rewritten away from the old opt-in promise on 2026-07-05 for BM/MOH/HHQ/OO). Enforced in one choke point. Sensitive categories remain deny-by-default (see #3).
2. **No back-catalog from no-sell-policy sites.** Bucket B sites (imfrustrated, WPD, Cornerstone, DoppelWriter, IDHW) collected data under explicit no-sell promises. Only data collected **after** the policy rewrite + new consent is sellable. Pre-flip rows are permanently marked non-sellable.
3. **Sensitive categories deny-by-default.** Health/disability (AISSDI, MOH toggles) and estate/wealth+minors (IDHW) flow into the graph but are **blocked from export** until a valid, scoped `legal_approval_id` is attached to the export request. The plumbing is built; the sale is locked pending counsel. No silent path around this.
4. **Payment data never enters.** Stripe/card data is out of scope entirely.
5. **Every export is logged.** Buyer, criteria, record set, fields, timestamp, and (if sensitive) approval id — immutable audit trail. Required for CCPA/CPRA compliance and for honoring later deletion/opt-out.
6. **Opt-out is retroactive.** A later GPC signal or Do-Not-Sell request marks the identity non-sellable going forward and is recorded; the export log lets us tell a buyer a record was withdrawn.

## 3. The three site buckets

| Bucket | Sites | State | Engine treatment |
|--------|-------|-------|------------------|
| **A — sellable now** | BestMan HQ, Maid of Honor HQ, Handicap HQ, Offsite Outpost | Consent-sale policies live (OO added 2026-07-05). Data mostly already collected. | Wire straight into engine. HHQ blocked until `brand=tdf`→`handicaphq` de-comingling (unification WS4). |
| **B — policy-flip, forward-only** | imfrustrated, WhatPeptidesDo, Cornerstone, DoppelWriter, IDHW | Explicit no-sell policies. | Rewrite policy + add consent gate. Mark all pre-flip data `sellable=false` permanently. Only new consented data flows. |
| **C — sensitive, counsel-gated** | AISSDI (disability/health/income), IDHW (estate+minors), MOH (pregnancy/sobriety/mobility toggles) | Sensitive category. | Plumbing built; rows tagged `sensitive`. Export DENIED until scoped legal approval. |

Note IDHW and MOH appear in two buckets: their non-sensitive fields follow the bucket rule; their sensitive fields are additionally C-gated.

## 4. Architecture

New module in `shared-engine`: `src/exchange/` (the "Data Exchange" layer). DI-first (inject Supabase + Redis clients, matching the unification pattern). Five components:

### 4.1 Identity resolution (`exchange/identity.ts`)
`vid` is per-domain; **email is the cross-site key.** `resolveIdentity(email) → UnifiedProfile` queries `wp_leads WHERE lower(email)=?` across all brands and merges:
- `brands: string[]` — which sites this person touched
- `interests` — union of `profile.explicit` selections + `profile.derived.vendor_categories` across brands
- `behavior` — merged options_clicked/selected, plans_generated, dwell, return_visits, acquisition
- `spend` — max/blended `est_spend_usd`, `spend_tier`, soonest `event_date`
- `consent` — **most-restrictive-wins**: if `do_not_sell=true` on ANY brand row, the whole identity is non-sellable
- `sensitive` — set of sensitive categories present (from the registry, §4.5)

Backed by a `wp_identity` SQL view (grouped by lower(email)) for query performance; the merge logic that can't be expressed in SQL lives in TS over the view rows.

### 4.2 Collection maximization (per-site, consumes shared emitters)
From the audit gap list. Bucket A first:
- **BM/MOH:** persist builder venue selections as `logSelection`; wire dead `logBookmark`; fold `concierge-lead` (add vid+consent) and `crew_responses` into `wp_leads`.
- **OO:** fire `plan_inputs` on generate; attach `vid` to ConciergeForm; emit canonical funnel + `identify()`; wire `logAcquisition`.
- **HHQ:** de-comingle `brand=tdf`→`handicaphq` (unification WS4 dependency), then same as BM.
- **Wizards:** wire `offer_clicks`/`offer_conversions` for outbound booking-intent.
Bucket B (after policy flip): wire WPD's orphaned lead modal; add Cornerstone DB + catalog-view logging; imfrustrated structured template-open event; IDHW link `will_stats`↔email (sensitive → C-gated); DoppelWriter retention change (product-promise reversal — flag).

### 4.3 Consent + policy (`exchange/consent.ts` + per-site policy)
- `ConsentState` type unified across sites: `{ consent_share, do_not_sell, consent_text, consent_at, source }` (already on `wp_leads`).
- `isSellable(identity) → boolean` — the single predicate (opt-out model): `!do_not_sell && (!sensitive || hasValidApproval)`. `consent_share` is no longer required (retained as a column but not gating).
- Portfolio-wide Do-Not-Sell propagation (BM/MOH already flip across brands via `/api/privacy/do-not-sell`; extend to all brands) + GPC honored everywhere.
- Bucket B policy rewrites (5 sites) + consent checkbox added to their capture points; a `policy_version` / `sellable_from` timestamp per site so pre-flip rows are excluded.

### 4.4 Export layer (`exchange/export.ts`)
- `buildSegment(criteria) → Identity[]` — query `wp_identity`, filter through `isSellable`. Criteria: brand(s), interests, spend tier, event window, geo, recency.
- `exportSegment(segment, { format, buyer, fields, legalApprovalId? }) → Artifact` — CSV or API payload of the **consented fields only**.
- **Choke point:** `assertExportable(identity, req)` runs on every record before it serializes (§5). One function, TDD'd hard.
- `logExport(...)` writes `wp_export_log` — mandatory, transactional with the export.

### 4.5 Sensitive gate (`exchange/sensitive.ts`)
- `SENSITIVE_REGISTRY` — maps field/brand → category: `health` (AISSDI condition/treatment/income, MOH pregnant/sober/mobility), `estate` (IDHW bequests/beneficiaries/minors).
- Any identity carrying a registered field → `sensitive` set populated.
- `wp_legal_approvals` table: `{ id, categories[], scope_note, approved_by, approved_at, expires_at }`. An export of sensitive rows must reference a non-expired approval whose `categories` cover the row's sensitive set. **Default deny.**

## 5. The export gate (highest-risk logic — TDD first)

```
assertExportable(identity, req):   // opt-out model: sellable by default
  if identity.do_not_sell:                         DENY "opted out (GPC or Do-Not-Sell)"
  if identity.source_sellable_from is null
     or record.collected_at < source_sellable_from: DENY "pre-policy-rewrite data"
  if identity.sensitive.nonEmpty:
     if not req.legalApprovalId:                    DENY "sensitive requires approval"
     approval = getApproval(req.legalApprovalId)
     if approval is null or approval.expired:       DENY "invalid/expired approval"
     if not approval.categories ⊇ identity.sensitive: DENY "approval scope insufficient"
  ALLOW
```

This is the only path data leaves the system. It is deny-by-default at every branch. Unit tests must cover each DENY reason plus the ALLOW.

## 6. Data model (additions to shared Supabase `bzmehrytiudgmgdrdlkg`)

- `wp_identity` — VIEW over `wp_leads` grouped by `lower(email)`; exposes brands[], merged consent (bool_or(do_not_sell), bool_and(consent_share)), spend, sensitive tags.
- `wp_export_log` — `id, buyer, segment_criteria jsonb, record_count, record_id_hash, fields_exported text[], sensitive bool, legal_approval_id, exported_by, exported_at`.
- `wp_legal_approvals` — `id, categories text[], scope_note, approved_by, approved_at, expires_at`.
- `wp_leads` additions: `sellable_from timestamptz null` (set at policy-flip per brand; null = never sellable), `sensitive_categories text[] default '{}'`.
- Consent columns already exist.

## 7. Phasing

- **P1 — Aggregation + inventory ("what do I have").** Nick's call (2026-07-05): don't build the sell/export pipe yet — aggregate first, decide the sell mechanism once the inventory is visible. So P1 is: `exchange/identity.ts` (cross-brand merge) + `wp_identity` view + `isSellable` predicate + `sensitive` tagging + an **inventory report generator** (script → markdown/JSON: identity counts, cross-site overlap, breakdown by brand/interest/spend-tier, and consent + sensitive splits so sellable/gated/non-sellable are honestly counted). **No external export, no `wp_export_log`, no buyer delivery** — deferred to a later phase once Nick picks a mechanism. **Deliverable: a report that shows exactly what the aggregated portfolio dataset contains and how much of it is sellable.**
- **P2 — Max collection (Bucket A) + HHQ de-comingle.** Wire the dead/ missing signals; land the `tdf`→`handicaphq` migration so HHQ is separable.
- **P3 — Bucket B policy flips + forward collection.** Rewrite 5 policies, add consent gates, set `sellable_from`, wire new collection. Pre-flip data stays `sellable=false`.
- **P4 — Bucket C sensitive plumbing.** Tag sensitive rows, populate `SENSITIVE_REGISTRY`, wire IDHW will↔email + AISSDI into the graph. **Export stays locked** — no `wp_legal_approvals` rows exist until counsel signs off. Nick initiates legal review here.

## 8. Testing strategy

- **Gate (`assertExportable`) — exhaustive unit tests, written first.** Every DENY branch + ALLOW. This is the compliance-critical unit.
- Identity merge: multi-brand same-email → correct union; most-restrictive consent wins.
- Do-Not-Sell propagation: opt-out on one brand → identity non-sellable everywhere.
- Sensitive deny-by-default: sensitive row with no approval → DENY; with expired/under-scoped approval → DENY; with valid approval → ALLOW.
- Export log: every export writes a row transactionally; failure to log ⇒ export rolls back.
- `sellable_from`: pre-flip Bucket B rows never export.

## 9. Open decisions

1. ~~OO prod deploy path~~ **RESOLVED (2026-07-05):** cherry-picked the 3 legal files onto `main` (commit `e780190`), pushed, auto-deploying to offsiteoutpost.com.
2. **Buyer delivery mechanism:** ~~CSV / API / clean-room~~ **DEFERRED (Nick, 2026-07-05).** Aggregate + inventory first (P1); decide the sell mechanism once the inventory is known. The export layer (§4.4) + `wp_export_log` move out of P1 to a later phase.
3. **Legal counsel for Bucket C** — Nick to engage before any `wp_legal_approvals` row is created.
4. **Pricing/packaging of segments** — out of scope for this spec (product/GTM, not engineering).

---

*Terminal state of brainstorming is writing-plans. Next step: turn P1 into an implementation plan and execute via TDD, gate-first.*
