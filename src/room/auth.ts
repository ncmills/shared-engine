/**
 * Trip Room V1.2 (2026-04-16) — auth helpers (shared).
 *
 * Extracted from MOH + BESTMAN src/lib/room-auth.ts. The `isOwnerForPlan`
 * pure function is the canonical owner check — the consumer repo composes
 * it with its own `getSessionEmail()` + `getPlan()` wrappers.
 *
 * Identity model:
 *  - Every request has a `sessionHash` (daily-rotating per IP+UA).
 *  - A session is "owner-equivalent" (`isOwner`) if the logged-in session
 *    email matches `plan.inputs.organizerEmail` OR is in `plan.coOwners`.
 *    Both are compared case-insensitively, trimmed.
 *  - `isOriginalOwner` is true only when the session email matches the
 *    original organizerEmail — only that email can invite co-owners.
 */

import type { RoomStoredPlan } from "./types";

export interface OwnerCheck {
  isOwner: boolean;
  isOriginalOwner: boolean;
}

/** Pure owner-check function. No I/O, no session side-effects. */
export function isOwnerForPlan(
  plan: RoomStoredPlan,
  sessionEmail: string | null
): OwnerCheck {
  const ownerEmail = (plan.inputs?.organizerEmail || "").trim().toLowerCase();
  const sessionEmailNormalized = sessionEmail ? sessionEmail.trim().toLowerCase() : "";
  const coOwnerEmails = (plan.coOwners ?? []).map((e) =>
    (e || "").trim().toLowerCase()
  );

  const isOriginalOwner =
    !!ownerEmail && sessionEmailNormalized === ownerEmail;
  const isCoOwner =
    !!sessionEmailNormalized && coOwnerEmails.includes(sessionEmailNormalized);
  const isOwner = isOriginalOwner || isCoOwner;

  return { isOwner, isOriginalOwner };
}

/**
 * Short public display name for anonymous voters. Used as fallback label
 * on votes + flags.
 */
export function anonDisplayName(sessionHash: string): string {
  const adjectives = ["kind", "lucky", "brave", "sunny", "cozy", "bright", "bold", "glow", "spark", "fern"];
  const idx = parseInt(sessionHash.slice(0, 4), 16) % adjectives.length;
  return `guest-${adjectives[idx]}`;
}
