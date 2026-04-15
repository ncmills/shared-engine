# shared-engine

Shared plan-generation engine for BESTMAN HQ (`~/plan-my-party`) and Maid of Honor HQ (`~/maid-of-honor-hq`).

Consumed via `file:` protocol:

```json
"dependencies": {
  "shared-engine": "file:../shared-engine"
}
```

## Modules

- `brand-config.ts` — `BrandConfig` + `BESTMAN_CONFIG` / `MOH_CONFIG`.
- `types.ts` — shared types (`PriceTargets`, `PricingDestination`, `BrandEventProps`, etc.).
- `pricing.ts` — `computePriceTargets` + `BUDGET_CAPS_PER_PERSON`. Identical across both brands; no brand divergence.
- `analytics.ts` — `CANONICAL_EVENTS` + `captureCanonical(posthog, event, props)` helper. Every event must include `brand`.
- `priors.ts` — per-brand popularity priors for wizard fields. Seed values; a future offline job can recompute from Redis history.
- `surprise-me.ts` — weighted random pick from priors, per field. Used by `/api/wizard/surprise-me`.

## Not in scope (yet)

- Scoring logic (`pickThreeDestinations`) — too divergent between brands (type-specific branches, bride/groom scoring). Stays per-brand for now.
- JSON repair / generation loop — will extract after pricing stabilizes.
- Data catalogs — destinations stay per-brand by design.
