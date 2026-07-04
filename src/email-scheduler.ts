// src/email-scheduler.ts
//
// Welcome-sequence scheduler, promoted from Handicap HQ's
// src/lib/email-scheduler.ts (`scheduleWelcomeSequence`). Generalized to
// take an injected `SupabaseClient` and a caller-supplied `sequence`
// (WelcomeEmail[]) instead of HHQ's hardcoded 5-step `STEP_OFFSETS_MS`, so
// each brand (BestManHQ / MOH / HHQ / Offsite) can define its own welcome
// cadence while sharing the same insert/idempotency logic.
//
// DB-SHAPE DISCREPANCY (see task-6-report.md for the full note): the task
// brief asked for insert columns (brand, email, vid, step, template,
// send_at), but the canonical migration
// (~/plan-my-party/supabase/migrations/20260423T2_email_schedule.sql) and
// all three live producers (plan-my-party / MOH / HHQ email-scheduler.ts)
// only ever write `email, brand, sequence_step, send_at` to
// `wp_email_schedule`. There is no `template` or `vid` column on the table
// — every consumer cron (`api/cron/send-scheduled-emails`, all 3 brands)
// resolves which template to render purely from `sequence_step` (+ its own
// brand-scoped renderer), and `vid` belongs to the separate `wp_leads`
// capture flow, not this table. Per the brief's fidelity instruction ("follow
// HHQ for the DB shape and report the discrepancy"), this port persists only
// the columns that exist on the live table; `template` and `vid` are kept on
// the pure/JS interfaces (for parity with the brief's contract and so
// callers can still carry that metadata in-process) but are NOT sent to
// Supabase.
//
// IDEMPOTENCY PRESERVED from HHQ (do not simplify to a plain insert): HHQ's
// insert is an `upsert` with `onConflict: "email,brand,sequence_step"` +
// `ignoreDuplicates: true`, matching the migration's unique index
// (idx_wp_email_schedule_email_brand_step). HHQ's own comment explains why:
// it prevents double-seeding the same welcome sequence when a lead
// re-submits their email (e.g. grabs a lead magnet twice). A plain insert
// would throw/duplicate on the second call for the same lead, so this
// behavior is carried over unchanged.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Brand } from "./signals";

export interface WelcomeEmail {
  step: number;
  sendAtOffsetHours: number;
  template: string;
}

/**
 * Pure send_at computation, extracted from HHQ's inline
 * `STEP_OFFSETS_MS.map(...)`. No I/O — `send_at = startIso + offsetHours`.
 */
export function buildWelcomeSchedule(
  sequence: WelcomeEmail[],
  startIso: string
): { send_at: string; step: number; template: string }[] {
  const start = Date.parse(startIso);
  return sequence.map((item) => ({
    send_at: new Date(start + item.sendAtOffsetHours * 3600_000).toISOString(),
    step: item.step,
    template: item.template,
  }));
}

export interface ScheduleWelcomeSequenceArgs {
  brand: Brand;
  email: string;
  /** Accepted for interface parity; not persisted (see file header — no `vid` column on wp_email_schedule). */
  vid?: string;
  sequence: WelcomeEmail[];
  nowIso: string;
}

/**
 * Inserts one row per sequence step into the shared `wp_email_schedule`
 * table. Ported from HHQ's `scheduleWelcomeSequence`: same email
 * normalization guard, same idempotent upsert. See file header for the
 * `template`/`vid` DB-shape discrepancy vs the task brief.
 *
 * WS4 DEPENDENCY: the live `wp_email_schedule` (and `wp_leads`) `brand` CHECK
 * constraint currently allows only `('moh', 'bestman', 'tdf')`. Calling this
 * with `brand: 'offsite'` or `brand: 'handicaphq'` will be rejected by the DB
 * until WS4 widens that constraint — WS4 must land before Offsite Outpost or
 * Handicap HQ can call this function.
 *
 * FAILS LOUD, ON PURPOSE (Nick hard rule — no silent failures in shared
 * libraries): every row's `step` is validated against the table's
 * `CHECK (sequence_step BETWEEN 1 AND 10)` *before* any I/O, and any Supabase
 * upsert error is thrown rather than logged-and-swallowed. It is the
 * caller's job (e.g. the WS1/WS2 lead-capture routes) to decide whether to
 * catch and log — this library will never hide a failure from its caller.
 */
export async function scheduleWelcomeSequence(
  supabase: SupabaseClient,
  args: ScheduleWelcomeSequenceArgs
): Promise<{ scheduled: number }> {
  // Ported from HHQ: normalize + guard against empty/malformed email before
  // ever touching the DB.
  const email = args.email.trim().toLowerCase();
  if (!email || !email.includes("@")) return { scheduled: 0 };

  // Validate BEFORE the upsert: `sequence_step` is 1-based (matches every
  // real producer — HHQ/MOH use `idx + 1`, BMHQ uses `1..5`) and the DB has
  // `CHECK (sequence_step BETWEEN 1 AND 10)`. A single out-of-range step
  // (e.g. a caller passing a 0-based `step`) would otherwise get the WHOLE
  // upsert batch rejected by Postgres — fail fast, in-process, with a clear
  // message instead of a batch-wide DB rejection.
  for (const item of args.sequence) {
    if (!Number.isInteger(item.step) || item.step < 1 || item.step > 10) {
      throw new Error(`email-scheduler: step must be 1..10, got ${item.step}`);
    }
  }

  const rows = buildWelcomeSchedule(args.sequence, args.nowIso);
  const dbRows = rows.map((row) => ({
    email,
    brand: args.brand,
    sequence_step: row.step,
    send_at: row.send_at,
  }));

  // onConflict + ignoreDuplicates preserved from HHQ (see file header) —
  // leaves an already-seeded row (and its sent_at) untouched rather than
  // resetting it when a lead resubmits.
  const { error } = await supabase.from("wp_email_schedule").upsert(dbRows, {
    onConflict: "email,brand,sequence_step",
    ignoreDuplicates: true,
  });
  if (error) {
    // THROW — do not console.warn-and-continue. Swallowing this here would
    // hide a real production failure (e.g. the brand CHECK rejecting
    // 'offsite'/'handicaphq' pre-WS4) from every caller. The caller decides
    // whether to catch+log; that is not this library's job to hide.
    throw new Error(`email-scheduler: upsert failed: ${error.message}`);
  }

  return { scheduled: dbRows.length };
}
