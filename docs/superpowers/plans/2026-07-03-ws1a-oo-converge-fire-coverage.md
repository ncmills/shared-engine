# WS1a — Offsite Outpost: Converge + Fire Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make `offsite-outpost` import `shared-engine@0.4.0` for the generic data-collection primitives (replacing its redundant forks), and close its capture holes so it fires the full signal set BM/MOH/HHQ fire — most importantly `plan_inputs` (which currently never fires), plus per-step dwell timing, an acquisition beacon, and a Surprise-Me action signal.

**Architecture:** Repo `~/offsite-outpost` (Next.js, ioredis + supabase-js, brand `offsite`). We swap the *generic* forks (`oo-engine/signals`, `oo-engine/vid`, `oo-engine/engine-signals`, `oo-engine/analytics`, `signals-server` stripPII) for shared-engine imports, delete the dead dupes, and add the missing emits. We KEEP OO's site-specific engine pieces (`oo-engine/priors.ts` `priorsForTrack`, `oo-engine/surprise-me.ts`, `oo-engine/derive.ts`, `oo-engine/lead-profile.ts` [handled in WS1b], `lib/lead-capture.ts`) — these are OO-specific like `BrandConfig` is wedding-specific and are out of scope here.

**Tech Stack:** TypeScript, Next.js, ioredis (`getRedis()` `src/lib/kv.ts:14`), supabase-js (`src/lib/supabase.ts:32`), shared-engine (github branch pin), Playwright (OO has an e2e setup — verify).

## Global Constraints

- Pin `shared-engine` to the WS0 branch: `"shared-engine": "github:ncmills/shared-engine#spec/portfolio-data-collection-unification"` (NOT main — main lacks 0.4.0 until final merge).
- Brand tag is `"offsite"` (already in shared-engine `Brand` + the DB brand CHECK for `wp_leads`/signals via `20260625_add_offsite_brand.sql`).
- Redis is ioredis — inject `getRedis()` directly into shared-engine DI (no adapter). Do NOT inject a keyPrefix'd client.
- Signals stay fire-and-forget; `/api/signals` must keep returning 204 always; never block wizard UX on a signal.
- `plan_inputs` payload is the full resolved `PlanInput` (`src/lib/engine/generate.ts:33-67`), PII-scrubbed via shared-engine `stripPII` (email/organizer fields dropped; `vid` preserved).
- Do NOT delete OO's site-specific `oo-engine/priors.ts`, `oo-engine/surprise-me.ts`, `oo-engine/derive.ts`, `oo-engine/lead-profile.ts` (lead-profile handled in WS1b), or `lib/lead-capture.ts`.
- Default Vercel scope: this is a solo project → `ncmillsionaire` (do NOT deploy under uppersonly). Do NOT deploy in this plan — commit only; Nick pushes/deploys.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage only named files; no `git commit -a`. Branch off OO's default branch first (do not commit to main directly).

---

### Task 1: Add shared-engine dependency + branch/worktree setup

**Files:** Modify `~/offsite-outpost/package.json` (dependencies)

**Interfaces:**
- Produces: `shared-engine@0.4.0` resolvable via `import { logSignal, stripPII, readVid, AcquisitionBeacon, ... } from "shared-engine"` inside OO.

- [ ] **Step 1:** Create a work branch off OO's default branch: `cd ~/offsite-outpost && git checkout -b feat/ws1a-data-collection-converge`.
- [ ] **Step 2:** Add to `package.json` dependencies: `"shared-engine": "github:ncmills/shared-engine#spec/portfolio-data-collection-unification"`. Run `npm install`.
- [ ] **Step 3:** Verify resolution: create `/tmp/se-check.mjs`? No — instead add a temporary import in a scratch test. Simpler: `node -e "require.resolve('shared-engine')"` may fail (ESM/TS). Instead run `npx tsc --noEmit` after Task 2's first import lands. For this task, verify `ls node_modules/shared-engine/src/index.ts` exists.
- [ ] **Step 4:** Commit `package.json` + `package-lock.json`: `feat: add shared-engine dep (WS1a)`.

**Verification:** `ls node_modules/shared-engine/src/signals.ts` succeeds.

---

### Task 2: Repoint `vid` to shared-engine

**Files:** Modify `~/offsite-outpost/src/lib/proxy.ts:2`, `src/app/api/signals/route.ts:9`, `src/components/EmailCapture.tsx:5`. Delete `src/lib/oo-engine/vid.ts` (after confirming no other importers).

**Interfaces:**
- Consumes: shared-engine `vid.ts` exports. **Pre-check:** confirm shared-engine exports the same names OO uses (`VID_COOKIE`, `VID_MAX_AGE`, `isValidVid`, `newVid`, `readVid`, `getVid`). If shared-engine's `vid.ts` is missing any, STOP and report — do not delete the fork.

- [ ] **Step 1:** Diff `~/offsite-outpost/src/lib/oo-engine/vid.ts` against `~/shared-engine/src/vid.ts`. If not behavior-identical (cookie name, max-age, validation regex), STOP and report the delta — a `vid` scheme change would orphan existing first-party cookies.
- [ ] **Step 2:** Repoint the three importers' `@/lib/oo-engine/vid` → `shared-engine`.
- [ ] **Step 3:** `grep -rn "oo-engine/vid" src` → expect zero hits. Delete `src/lib/oo-engine/vid.ts`.
- [ ] **Step 4:** `npx tsc --noEmit` clean; run OO's lint/build if fast. Commit: `refactor: use shared-engine vid (WS1a)`.

**Verification:** typecheck clean; `grep -rn "oo-engine/vid" src` empty.

---

### Task 3: Repoint signals + stripPII to shared-engine; delete generic-signal dupes

**Files:** Modify `src/components/wizard/OutingWizard.tsx:17`, `src/components/wizard/RetreatWizard.tsx:10` (logSelection import), `src/app/api/signals/route.ts:8` (stripPII/resolveSignalTableName), `src/lib/signals-server.ts:11` (stripPII re-export). Delete `src/lib/oo-engine/signals.ts`, `src/lib/oo-engine/engine-signals.ts` (dead dup) after import churn cleared.

**Interfaces:**
- Consumes: shared-engine `logSelection`, `stripPII`, `resolveSignalTableName`, `SignalTable`. **Pre-check:** OO's `oo-engine/signals.ts` `stripLeadSignalPII` has an OO-specific banned set (`attendeeEmail, phone, ip, ipAddress`). shared-engine's canonical `stripPII` (WS0) is a SUPERSET of that — verify each OO-banned key is in shared-engine's banned set before deleting the fork. If any OO-specific banned key is absent from shared-engine, STOP (do not weaken scrubbing).

- [ ] **Step 1:** Confirm shared-engine `stripPII` banned set ⊇ OO's `stripLeadSignalPII` banned set (it should — WS0 adopted the HHQ superset which includes attendeeEmail/phone/ip/ipAddress). Document the check in the report.
- [ ] **Step 2:** Repoint `api/signals/route.ts` to import `stripPII` + `resolveSignalTableName` + `SignalTable` from `shared-engine`; keep the route's rate-limit + 204-always behavior unchanged. Repoint `signals-server.ts` to re-export/use shared-engine `stripPII`.
- [ ] **Step 3:** Repoint both wizards' `logSelection` import to `shared-engine`. (The `logSelection` signature is compatible: `logSelection(brand, { slot, optionId?, action, dwellMs? })` — but OO currently calls `logSelection({slot,optionId,action})` WITHOUT a brand arg via its fork. Confirm the shared signature and update call sites to pass `"offsite"` as the brand.)
- [ ] **Step 4:** `grep -rn "oo-engine/signals\|oo-engine/engine-signals" src` → zero. Delete both files.
- [ ] **Step 5:** `npx tsc --noEmit` clean. Commit: `refactor: use shared-engine signals + stripPII (WS1a)`.

**Verification:** typecheck clean; `/api/signals` still returns 204 (spot-check via the existing e2e or a curl if a dev server is up); no `oo-engine/signals` imports remain.

---

### Task 4: Delete the dead analytics fork (repoint any live use to shared analytics)

**Files:** `src/lib/oo-engine/analytics.ts` (scout: NO importers — dead). Confirm + delete.

- [ ] **Step 1:** `grep -rn "oo-engine/analytics" src` — expect zero. If any importer exists, repoint it to shared-engine `analytics.ts` (canonical PostHog helpers) instead of deleting; verify the needed export exists there.
- [ ] **Step 2:** Delete `src/lib/oo-engine/analytics.ts`. `npx tsc --noEmit` clean. Commit: `chore: delete dead oo-engine/analytics fork (WS1a)`.

**Verification:** typecheck clean; file gone; no broken imports.

---

### Task 5: Fire `plan_inputs` with the full PlanInput on plan generation

**Files:** Modify `src/app/api/generate/route.ts` (after `const input = coerceInput(body)` ~`:143` and after `generatePlans` ~`:148`).

**Interfaces:**
- Consumes: OO's `signals-server.ts:logSignalServer(req: Request, table: SignalTable, payload: SignalPayload): void` (already exists at `signals-server.ts:46`, brand hardcoded `"offsite"`, scrubs via shared `stripPII`, writes `wp_*`, fire-and-forget) — it has ZERO callers today; this task adds the one call. Table = `plan_inputs`; payload = `{ brand: "offsite", wizardState: <full PlanInput>, productType, planId? }`.
- **PII (verified against real code):** `PlanInput` (`src/lib/engine/generate.ts:33`) has `organizerEmail?` — which IS in shared-engine's `stripPII` banned set, so `stripPII`'s object recursion strips it from `wizardState`. `notifyEmail` is coerced SEPARATELY (`route.ts:28 coerceNotifyEmail`, local var) and is NOT part of `input` — it never reaches the emit. So no email leak; the test asserts `organizerEmail` scrubbed, not `notifyEmail`.
- Emit point: after `const primaryId = planIds[0]` (~`route.ts:163`), where both `input` and `primaryId` are in scope. The POST handler param is named `request`.

- [ ] **Step 1: Write the failing test.** Goal: prove the route now EMITS `plan_inputs` with the full wizard state (the actual gap — it emits nothing today). Preferred approach: `vi.mock` the heavy route deps (`@/lib/image-service`, `@/lib/kv`, `@/lib/email`) and SPY on `@/lib/signals-server` `logSignalServer`; invoke the route's `POST` with a fake `Request` carrying a valid outing/retreat body; assert `logSignalServer` was called once with `("plan_inputs", objectContaining({ wizardState: <the coerced input>, productType }))`. If invoking the full `POST` is too entangled with route internals, extract a thin `emitPlanInputs(request, input, planId)` in the route/signals-server and unit-test that instead (assert it calls `logSignalServer` with the right table+payload). Place the test next to `src/lib/engine/generate.test.ts` conventions. (OO runs tests via `npx vitest run <file>` — there is no bare `"test"` script, only `"taste"`.)
- [ ] **Step 2:** Run `npx vitest run <testfile>` → RED (route emits nothing today / helper doesn't exist).
- [ ] **Step 3:** In `generate/route.ts`, after `const primaryId = planIds[0]`, call `logSignalServer(request, "plan_inputs", { brand: "offsite", wizardState: input, productType: input.productType, planId: primaryId ?? undefined })`. It is already fire-and-forget (void, never throws) — do NOT await it, place it so it never delays the response.
- [ ] **Step 4:** Run → GREEN. `npx tsc --noEmit` clean (pre-existing `.next` generated-types error acceptable).
- [ ] **Step 5:** Commit: `feat: emit plan_inputs signal on OO plan generation (WS1a)`.

**Verification:** test green; manual generate (dev server) writes a `wp_plan_inputs` row with brand `offsite` and full `wizardState` (query Supabase or assert via mock).

---

### Task 6: Per-step dwell timing in both wizards

**Files:** Modify `src/components/wizard/OutingWizard.tsx` (`step` state `:70`, `goNext/goBack` `:73-74`) and `src/components/wizard/RetreatWizard.tsx` (`:60`, `:63-64`).

**Interfaces:**
- Consumes: shared-engine `logSelection("offsite", { slot: "step-N", action: "add", dwellMs })`. (Reference: BM `PartyWizardClient.tsx:825-830`.)

- [ ] **Step 1:** Add a `stepEnteredAt` ref set whenever the active step changes (mirror BM's pattern). On `goNext`/`goBack`/`setStep`, compute `dwellMs = Date.now() - stepEnteredAt` and emit `logSelection("offsite", { slot: \`step-${prevStep}\`, action: "add", dwellMs })`. Note: `Date.now()` in app runtime is fine (this is the browser, not a workflow script).
- [ ] **Step 2:** Repeat for both wizards (same shape). Keep it fire-and-forget.
- [ ] **Step 3:** `npx tsc --noEmit` clean. Manually click through a wizard (dev server) and confirm `plan_selections` rows with `slot: step-*` + non-null `dwellMs` appear. Commit: `feat: per-step dwell timing in OO wizards (WS1a)`.

**Verification:** dwell emits fire on step advance/back; `dwellMs` populated.

---

### Task 7: Mount the shared AcquisitionBeacon

**Files:** Modify OO's root layout (`src/app/layout.tsx`) to mount `<AcquisitionBeacon brand="offsite" />`.

**Interfaces:**
- Consumes: shared-engine `AcquisitionBeacon` (client component, fires `logAcquisition` once/session).

- [ ] **Step 1:** Import `AcquisitionBeacon` from `shared-engine` in `layout.tsx`; mount it inside `<body>` (mirror how HHQ mounts it in its `layout.tsx`). It renders `null`.
- [ ] **Step 2:** `npx tsc --noEmit` clean. Dev server: load the site with `?utm_source=test&utm_medium=x`; confirm ONE `wp_acquisition_log` row (brand `offsite`) with the utm + device, and that a reload does NOT double-fire (sessionStorage guard). Commit: `feat: mount shared AcquisitionBeacon on OO (WS1a)`.

**Verification:** exactly one acquisition row per session; utm/device captured.

---

### Task 8: `surprise_me_actions` emit on the existing "Fill it for me" flow

**Approach (revised after reading OO):** OO already has a "Fill it for me" button → `handleRandomFill()` (`OutingWizard.tsx:157`, calls `randomOutingFill()`; `RetreatWizard.tsx` has the analog `handleRandomFill`/`randomRetreatFill`). Do NOT add a redundant `SurpriseMeButton` or a `/api/surprise-me` route. Instead INSTRUMENT the existing fill to emit `surprise_me_actions` — this is the minimal, non-duplicative capture. WS1d can later swap `randomOutingFill` for a priors-backed suggester behind the same emit.

**Files:** Modify `src/components/wizard/OutingWizard.tsx` (`handleRandomFill` ~`:157`) and `src/components/wizard/RetreatWizard.tsx` (its `handleRandomFill`).

**Interfaces:**
- Consumes: shared-engine `logSignal("surprise_me_actions", { brand: "offsite", field, suggested })` (import `logSignal` from `shared-engine`; wizards already import `logSelection`). Mirror BM `SurpriseMeButton.tsx:51`'s `{ field, suggested }` shape. `confidence` is OMITTED here (the fill is prior-free; a fabricated confidence would be misleading — WS1d adds real confidence when priors back it).
- Produces: `surprise_me_actions` rows (one per filled field) on each "Fill it for me" click.

- [ ] **Step 1:** In `handleRandomFill` (both wizards), after computing `const fill = randomOutingFill()` (resp. `randomRetreatFill()`) and BEFORE/AFTER applying the setters, emit one `logSignal("surprise_me_actions", { brand: "offsite", field, suggested: String(value) })` per field in `fill` (e.g. iterate `Object.entries(fill)`). Keep it fire-and-forget (do not await). Do not change the fill/setter behavior itself.
- [ ] **Step 2:** `npx tsc --noEmit` clean (pre-existing `.next` error acceptable). If a light vitest assertion is feasible without React infra (e.g. extract the emit into a tiny pure `emitFillSignals(fill)` helper and test it calls logSignal per field), add it; otherwise rely on typecheck + code review (note the choice).
- [ ] **Step 3:** Commit staging both wizard files (+ any helper/test): `feat: surprise_me_actions signal on OO fill (WS1a)`, trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. No `git commit -a`.

**Verification:** clicking "Fill it for me" emits one `surprise_me_actions` row per field (brand `offsite`); the fill still populates the wizard; no new button or route added.

---

### Task 9: Green gate — typecheck, build, e2e, no dead forks

**Files:** none (verification + version note).

- [ ] **Step 1:** `grep -rn "oo-engine/\(signals\|engine-signals\|vid\|analytics\)" src` → zero (deleted forks fully repointed).
- [ ] **Step 2:** `npx tsc --noEmit` clean; `npm run build` succeeds; run OO's e2e/lint if present and fast.
- [ ] **Step 3:** Confirm the KEPT site-specific forks still exist and compile: `oo-engine/priors.ts`, `oo-engine/surprise-me.ts`, `oo-engine/derive.ts`, `oo-engine/lead-profile.ts`, `lib/lead-capture.ts`.
- [ ] **Step 4:** Commit any final touch-ups: `chore: WS1a green gate`. Do NOT deploy — Nick pushes.

**Verification:** build green; all four signal families (plan_inputs, plan_selections+dwell, acquisition_log, surprise_me_actions) confirmed firing under brand `offsite`; site-specific forks intact.

---

## Self-Review

**Spec coverage (WS1 fire-coverage + converge items):** add shared-engine dep ✓ (T1); repoint generic forks (vid/signals/stripPII/analytics) ✓ (T2–T4); delete dead dupes ✓ (T3/T4); plan_inputs full WizardState ✓ (T5 — the #1 OO gap); dwell timing ✓ (T6); AcquisitionBeacon ✓ (T7); Surprise-Me signal ✓ (T8); keep OO site-specific engine ✓ (Global Constraints + T9). Leads reconciliation, email lifecycle, and the priors/popularity loops are explicitly OUT of scope (WS1b/WS1c/WS1d).

**Placeholder scan:** each fork-replacement task carries a fidelity pre-check (vid scheme identical; stripPII superset ⊇ OO banned set) that STOPS rather than silently weakening scrubbing or orphaning cookies — mirroring the WS0 lesson. Test code for the load-bearing new emit (plan_inputs, T5) is specified as TDD.

**Type consistency:** `logSelection("offsite", {...})` brand-first signature is called out in T3 (OO's fork omitted the brand arg — call sites must add `"offsite"`). `logSignalServer(req, table, payload)` reused in T5. AcquisitionBeacon `brand` prop in T7.

**Open dependency for later WS1 sub-plans:** WS1c must widen `wp_email_schedule` brand CHECK for `offsite` before scheduling; WS1d wires OO's site-local `priorsForTrack`/`surprise-me` to the shared `buildPriorsOverlay` + adds `recordDestinationView/Select`→ranking. WS1b fixes the captureLead field-drop + replaces the `lead-profile` fork.
