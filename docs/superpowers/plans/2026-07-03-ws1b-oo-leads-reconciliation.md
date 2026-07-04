# WS1b — Offsite Outpost: Leads Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Finish OO's lead-capture convergence: replace the byte-identical `oo-engine/lead-profile` fork with a shared-engine import, and fix the field-drop bug where the wizard/concierge lead routes discard the scoring-relevant fields before `captureLead`, so the `wp_leads` scored profile is fed by explicit wizard answers (not just anonymous vid-signal rows).

**Architecture:** `~/offsite-outpost`, branch `feat/ws1a-data-collection-converge` (continue on it — WS1a is its base). `captureLead(args: CaptureLeadArgs)` in `lib/lead-capture.ts` ALREADY accepts `wizardSnapshot?: WizardSnapshot` and uses it (`:243`) to derive scored fields + build the `explicit` profile block. The two callers (`/api/lead`, `/api/concierge`) simply never pass it. We build a `WizardSnapshot` at each caller from the fields it already has. `oo_leads` (concierge raw/free-text intake) is KEPT; `wp_leads`+`leads_profile` gets enriched — no data loss, clean separation (scored fields → wp_leads profile; free-text contact → oo_leads).

**Tech Stack:** TypeScript, Next.js, vitest (`npx vitest run`), shared-engine (branch pin).

## Global Constraints

- Branch: continue `feat/ws1a-data-collection-converge` (already pins shared-engine to the WS0 branch).
- `oo-engine/lead-profile.ts` is byte-for-behavior identical to `shared-engine/src/lead-profile.ts` (controller-verified) — replace with the shared import; delete the fork. KEEP `lib/lead-capture.ts` (per-repo I/O glue) and `oo-engine/derive.ts` (site-specific, differs from shared).
- Lead capture stays best-effort: `captureLead` must never throw into the request; a lead-capture failure must not fail the user's lead/concierge submission.
- Do NOT force free-text concierge fields (`name`, `company`, `message`, `context`) into `wp_leads` — those stay in `oo_leads`. Only scoring-relevant fields (`headcount`, `productType`) flow to `wizardSnapshot`.
- `event_date`/`days_to_event` stay null (OO wizard collects no date — out of scope; do NOT fabricate a date).
- Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage only named files; no `git commit -a`. Do NOT deploy.

---

### Task 1: Replace the lead-profile fork with a shared-engine import

**Files:** Modify `src/lib/lead-capture.ts:22`, `src/lib/lead-score.ts:19`, `src/lib/lead-score.test.ts:3` (repoint `@/lib/oo-engine/lead-profile` / `./oo-engine/lead-profile` → `shared-engine`). Delete `src/lib/oo-engine/lead-profile.ts`.

**Interfaces:**
- Consumes: shared-engine `LeadProfile`, `BehaviorSummary`, `assembleBehavior`, `buildLeadProfile`, `SignalRow` (whatever the 3 importers currently pull from the fork). **Pre-check:** confirm shared-engine exports EVERY symbol the 3 importers use from `oo-engine/lead-profile`. If any is missing, STOP — do not delete the fork.

- [ ] **Step 1:** List the exact symbols each of the 3 files imports from `oo-engine/lead-profile`. Confirm each is exported by `shared-engine` (grep `~/shared-engine/src/lead-profile.ts` + `src/index.ts`).
- [ ] **Step 2:** Repoint all 3 imports to `shared-engine`. Delete `src/lib/oo-engine/lead-profile.ts` + any dead barrel line in `oo-engine/index.ts`.
- [ ] **Step 3:** `grep -rn "oo-engine/lead-profile" src` → zero. Run the lead tests: `npx vitest run src/lib/lead-score.test.ts` → PASS (they test `LeadProfile` behavior; a green run proves the shared types are drop-in). `npx tsc --noEmit` clean (pre-existing `.next` error acceptable).
- [ ] **Step 4:** Commit `refactor: use shared-engine lead-profile (WS1b)`.

**Verification:** lead-score tests green; zero fork refs; typecheck clean.

---

### Task 2: Fix the field-drop in `/api/lead` (wizard lead)

**Files:** Modify `src/app/api/lead/route.ts` (the `captureLead({...})` call ~`:80`). Test: add/extend a route test.

**Interfaces:**
- Consumes: `captureLead`'s existing `wizardSnapshot?: WizardSnapshot` param. `LeadBody` already carries `headcount?: number` and `productType?: string` (`route.ts:20-21`) — currently dropped.
- Produces: `captureLead` receives `wizardSnapshot: { productType, headcount }` so the scored `wp_leads` profile reflects the wizard answers.

- [ ] **Step 1: Write the failing test.** Mock `@/lib/lead-capture` `captureLead`; POST a lead body with `{ email, headcount: 40, productType: "retreat", ... }`; assert `captureLead` was called with `wizardSnapshot` `objectContaining({ headcount: 40, productType: "retreat" })`. Run → RED (current call omits wizardSnapshot).
- [ ] **Step 2:** In `route.ts`, build `const wizardSnapshot = { productType: body.productType as ("retreat"|"outing"|undefined), headcount: body.headcount };` (only include keys that are present/valid — `productType` must be `"retreat"|"outing"` to match the type; coerce/guard). Add `wizardSnapshot` to the `captureLead({ ... })` call. Do NOT change the Nick-notification email or any other behavior.
- [ ] **Step 3:** Run → GREEN. `npx tsc --noEmit` clean. Commit `fix: forward wizard fields to lead profile in /api/lead (WS1b)`.

**Verification:** test green; wizard headcount/productType now reach `captureLead`.

---

### Task 3: Fix the field-drop in `/api/concierge` (enrich wp_leads; keep oo_leads)

**Files:** Modify `src/app/api/concierge/route.ts` (the `captureLead({...})` call ~`:85`). Test: extend a route test.

**Interfaces:**
- Consumes: `captureLead`'s `wizardSnapshot`. Concierge body has `headcount` (scoring-relevant → wizardSnapshot) plus `name`/`company`/`timing`/`message`/`context` (free-text/contact → stay in `oo_leads` via the existing `saveLead`, unchanged).
- Produces: concierge leads now also get a scored `wp_leads` profile enriched with `headcount`; `oo_leads` write is untouched (no data loss).

- [ ] **Step 1: Write the failing test.** Mock `captureLead` + `saveLead`; POST a concierge body `{ name, email, company, headcount: "25", timing, message }`; assert (a) `saveLead` still receives the full concierge record (oo_leads unchanged) AND (b) `captureLead` receives `wizardSnapshot: objectContaining({ headcount: 25 })`. Run → RED.
- [ ] **Step 2:** Coerce `headcount` to a number (concierge sends it as string — `Number(body.headcount)` guard for NaN) and pass `wizardSnapshot: { headcount }` to `captureLead`. Do NOT move `name`/`company`/`message` into captureLead — they stay in the `saveLead` → `oo_leads` write. Keep the concierge notification email unchanged.
- [ ] **Step 3:** Run → GREEN. `npx tsc --noEmit` clean. Commit `fix: enrich wp_leads profile from concierge headcount, keep oo_leads (WS1b)`.

**Verification:** oo_leads write intact; concierge headcount reaches the scored profile.

---

### Task 4: Green gate

**Files:** none (verification).

- [ ] **Step 1:** `grep -rn "oo-engine/lead-profile" src` → zero. Confirm `oo-engine/derive.ts`, `oo-engine/priors.ts`, `oo-engine/surprise-me.ts`, `lib/lead-capture.ts` still present (site-specific — kept).
- [ ] **Step 2:** `npx tsc --noEmit` clean (modulo pre-existing `.next` error); `npm run build` succeeds; `npx vitest run` (lead + route tests) green.
- [ ] **Step 3:** Commit any final touch-up (e.g. the deferred WS1a T3 stale comment at `api/signals/route.ts:13`): `chore: WS1b green gate + stale-comment sweep`. Do NOT deploy.

**Verification:** build green; leads flow with wizard/concierge scoring fields into wp_leads; oo_leads intact.

---

## Self-Review

**Spec coverage:** replace lead-profile fork ✓ (T1); fix field-drop in both lead paths ✓ (T2/T3 — the core bug: scored profile was fed only by vid rows); reconcile oo_leads↔wp_leads ✓ (T3 — keep oo_leads for free-text, enrich wp_leads for scoring); keep site-specific engine ✓ (Global Constraints/T4). Email lifecycle + priors/popularity are WS1c/WS1d.

**Placeholder scan:** T1 carries a symbol-export pre-check that STOPS before deleting the fork if shared-engine lacks a symbol. T2/T3 are TDD with concrete assertions on the `captureLead` `wizardSnapshot` arg.

**Type consistency:** `wizardSnapshot: WizardSnapshot` matches `captureLead`'s existing param; `productType` narrowed to `"retreat"|"outing"`; concierge `headcount` string→number coercion called out. `oo_leads` write (`saveLead`) explicitly unchanged.

**Open (WS1d):** `event_date`/`days_to_event` remain null until the wizard collects a date — deliberately deferred.
