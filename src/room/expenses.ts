/**
 * H2.5 Splitwise-ledger helpers — pure utility functions shared between
 * the bind-time auto-propose handler and the view-side "You owe"
 * computation. Supabase CRUD lives in each consumer repo's src/lib/expenses.ts;
 * this module only holds framework-agnostic math + seed construction.
 */

import type { Expense, RoomStoredPlan } from "./types";
import { parseCentsFromPriceString } from "../pricing";

/** Resolve the room owner email from RoomStoredPlan. Always lowercased. */
export function getOwnerEmail(plan: RoomStoredPlan): string {
  return (plan.inputs?.organizerEmail ?? "").trim().toLowerCase();
}

/** Combine the plan's owner email with the supplied member email list. */
export function getRosterEmails(
  plan: RoomStoredPlan,
  memberEmails: string[]
): string[] {
  const owner = getOwnerEmail(plan);
  const set = new Set<string>();
  if (owner) set.add(owner);
  for (const e of memberEmails) {
    const clean = (e ?? "").trim().toLowerCase();
    if (clean) set.add(clean);
  }
  return [...set];
}

/**
 * Sum in cents that the given viewer theoretically owes to other members,
 * based on VERIFIED expense rows only. Proposed rows are not counted.
 * Returns 0 if the viewer is on every row as payer (they're owed; not owing).
 */
export function computeOwedCents(
  expenses: Expense[] | undefined,
  viewerEmail: string | null | undefined
): number {
  if (!expenses || !viewerEmail) return 0;
  const you = viewerEmail.trim().toLowerCase();
  let owed = 0;
  for (const e of expenses) {
    if (e.status !== "verified") continue;
    if (e.payerEmail.toLowerCase() === you) continue;
    if (!e.splitEmails.map(x => x.toLowerCase()).includes(you)) continue;
    const n = Math.max(1, e.splitEmails.length);
    owed += Math.floor(e.amountCents / n);
  }
  return owed;
}

/** Total crew spend in cents across verified rows (public-safe). */
export function computeCrewSpendCents(expenses: Expense[] | undefined): number {
  if (!expenses) return 0;
  return expenses
    .filter(e => e.status === "verified")
    .reduce((sum, e) => sum + e.amountCents, 0);
}

/** Proposed-row count — owner-visible pending-review pill. */
export function countPendingReview(expenses: Expense[] | undefined): number {
  if (!expenses) return 0;
  return expenses.filter(e => e.status === "proposed").length;
}

/**
 * Shape of the proposed row emitted by auto-propose. Consumer handlers
 * persist via Supabase using these fields (snake_case at the DB layer).
 */
export interface ProposedExpenseSeed {
  planId: string;
  source: "slot";
  slotId: string;
  candidateId: string;
  label: string;
  amountCents: number;
  suggestedCents: number | null;
  payerEmail: string;
  splitEmails: string[];
  perPersonHint: boolean;
}

/**
 * Category → default human label used when the Candidate has no title.
 */
export function humanCategoryLabel(cat: string): string {
  const map: Record<string, string> = {
    lodging: "Lodging",
    activities: "Activity",
    dining: "Dining",
    bars: "Bar tab",
    flights: "Flight",
    transport: "Transport",
  };
  return map[cat] ?? "Expense";
}

/**
 * Compute the seed for auto-propose. Returns null if the candidate has no
 * usable price info (handlers then skip the insert).
 */
export function buildProposedSeed(args: {
  planId: string;
  slotId: string;
  candidateId: string;
  candidateTitle?: string;
  candidatePrice?: string;
  category: string;
  ownerEmail: string;
  memberEmails: string[];
  plan: RoomStoredPlan;
}): ProposedExpenseSeed | null {
  const parsed = parseCentsFromPriceString(args.candidatePrice);
  if (!parsed) return null;
  const fallback = humanCategoryLabel(args.category);
  const label = (args.candidateTitle ?? "").trim() || fallback;
  return {
    planId: args.planId,
    source: "slot",
    slotId: args.slotId,
    candidateId: args.candidateId,
    label,
    amountCents: parsed.cents,
    suggestedCents: parsed.cents || null,
    payerEmail: args.ownerEmail.trim().toLowerCase(),
    splitEmails: getRosterEmails(args.plan, args.memberEmails),
    perPersonHint: parsed.perPersonHint,
  };
}
