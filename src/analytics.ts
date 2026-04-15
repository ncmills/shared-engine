import type { BrandEventProps } from './types.js';

export const CANONICAL_EVENTS = {
  PLAN_STARTED: 'plan_started',
  PLAN_STEP_COMPLETED: 'plan_step_completed',
  PLAN_GENERATED: 'plan_generated',
  PLAN_SHARED: 'plan_shared',
  PLAN_VIEWED: 'plan_viewed',
  LEAD_CAPTURED: 'lead_captured',
  EMAIL_OPT_IN: 'email_opt_in',
  SURPRISE_ME_USED: 'surprise_me_used',
  OFFER_VIEWED: 'offer_viewed',
  OFFER_CLICKED: 'offer_clicked',
} as const;

export type CanonicalEventName =
  (typeof CANONICAL_EVENTS)[keyof typeof CANONICAL_EVENTS];

export function budgetBand(budget: string | undefined): string {
  if (!budget) return 'unknown';
  return budget;
}

export function groupSizeBand(size: number | undefined): string {
  if (size == null) return 'unknown';
  if (size <= 4) return '1-4';
  if (size <= 8) return '5-8';
  if (size <= 12) return '9-12';
  if (size <= 20) return '13-20';
  return '20+';
}

export interface PosthogLike {
  capture: (event: string, props?: Record<string, unknown>) => void;
}

export function captureCanonical(
  posthog: PosthogLike | null | undefined,
  event: CanonicalEventName,
  props: BrandEventProps
): void {
  if (!posthog) return;
  const payload: Record<string, unknown> = { ...props };
  if (props.budgetBand == null && typeof props['budget'] === 'string') {
    payload.budgetBand = budgetBand(props['budget'] as string);
  }
  if (props.groupSizeBand == null && typeof props['groupSize'] === 'number') {
    payload.groupSizeBand = groupSizeBand(props['groupSize'] as number);
  }
  posthog.capture(event, payload);
}
