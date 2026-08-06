# Phase 0 — Is this worth it? (extract refine()+trip-qa() into shared-engine)

**Date:** 2026-07-21
**Decision:** PROCEED with full extraction. Not killed.

## The question the plan answers
Stop the three copies of `refine-plan.ts` / `trip-qa.ts` (MOH, BMHQ, HHQ) from
drifting. The 2026-07-21 session had to apply guardrail hardening (ban weather,
exact-verbatim prices, no volunteered estimates, already-set honesty, HHQ
weekday-inference ban) to THREE copies by hand. That triplicated edit is the
extraction signal.

## Cheapest version that surfaces the same finding/value
**Cheap version:** extract ONLY the two prompt-skeleton builders
(`buildRefineSystemPrompt`, `buildQASystemPrompt`) into shared-engine,
parameterized by a small brand config. Leave the algorithm
(`proposeWizardPatch`, `answerTripQuestion`, `parseModelJson`, whitelist/diff/
unmet, `serializePlanForQA`, `pickViewedPlan`) local in each repo.

- **Cost:** ~1/2 the file moves, ~1/3 the wiring. HHQ still needs the dep.
- **Captures:** ~90% of the anti-drift value, because **the guardrail prose is
  the only thing that actually drifted this session.** The algorithm has been
  byte-stable across all three copies.

## Full-plan cost vs cheap-version cost
- **Cheap:** shared `src/chat/prompts.ts` (2 builders + config type) + rewire
  each repo's `buildRefineSystemPrompt`/`buildQASystemPrompt` to import it.
  ~3 files in shared-engine, ~2 edits/repo.
- **Full:** shared `src/chat/{refine,trip-qa,prompts,types}.ts` (whole
  algorithm + prompts + types, config-injected) + each repo keeps only
  `{ config, route, validate, UI }`. ~5 files in shared-engine, ~3 edits/repo,
  + HHQ takes the github dep.
- Delta is small because the whole surface is tiny: refine ~276 LOC, trip-qa
  ~96 LOC, near-identical across repos.

## What the cheap version would miss
- Algorithm bugs still fixed in 3 places (e.g. the `parseModelJson` fence
  tolerance, the whitelist→validate→diff logic, `coerceUnmet`). Low frequency,
  but real — HHQ's `validate.ts` "Scotland"→"SCOT" truncation and BMHQ's
  enum-drift were both algorithm-adjacent bugs this session.
- Type drift (`RefineResult`/`Unmet`/`QAResult`) — three copies of the shape.
- Doesn't deliver the stated "scale-out" goal (a real shared chat module).

## Verdict
The marginal cost of moving the (small, stable) algorithm alongside the prompt
skeleton is low, and Nick chose full extraction + HHQ-takes-the-dep. The value
(one place to harden guardrails AND fix algorithm bugs across 3 live sites that
already bit 3× this session) exceeds the modest incremental cost. **Proceed with
full extraction.** Keep transport injected at the route (already the case) and
validate injected per-brand — do NOT centralize those.
