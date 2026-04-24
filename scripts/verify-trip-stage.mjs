#!/usr/bin/env node
// H3.3 smoke test — five golden fixtures covering the stage ladder.
// Matches the style of verify-email-parsers.mjs: load the TS source via
// dynamic import after a quick tsc compile-to-memory is not available,
// so this script runs against the TypeScript via `tsx`/`node --loader` is
// heavier than the rest of the smoke suite. Instead we reimplement the
// expected contract in pure ESM and assert against a fresh import of the
// compiled-to-ESM source at ../src/room/viewmodel.ts via a small inline
// shim: Node 22 + type: module + .ts extensions fail, so we keep the
// fixtures declarative and run via the project's existing `tsx` dev dep.

import { computeTripStage } from "../src/room/viewmodel.ts";

let passed = 0;
let failed = 0;

function assert(name, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${name} → ${actual}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} — expected ${expected}, got ${actual}`);
  }
}

// ── Fixture 1: preview (no stage field) ────────────────────────────────
assert(
  "preview — no stage, dates ignored",
  computeTripStage(
    {
      id: "p1",
      finalCheckIn: "2026-05-01",
      finalCheckOut: "2026-05-04",
    },
    new Date("2026-05-02T18:00:00Z")
  ),
  "preview"
);

// ── Fixture 2: locked with no dates → locked ────────────────────────────
assert(
  "locked — stage=locked, no dates",
  computeTripStage({ id: "p2", stage: "locked" }, new Date("2026-05-01")),
  "locked"
);

// ── Fixture 3: finalized before check-in → finalized ────────────────────
assert(
  "finalized — pre-trip",
  computeTripStage(
    {
      id: "p3",
      stage: "finalized",
      finalCheckIn: "2026-06-10",
      finalCheckOut: "2026-06-13",
    },
    new Date("2026-05-24T12:00:00Z")
  ),
  "finalized"
);

// ── Fixture 4: finalized during trip window → live ──────────────────────
assert(
  "live — mid-trip",
  computeTripStage(
    {
      id: "p4",
      stage: "finalized",
      finalCheckIn: "2026-05-22",
      finalCheckOut: "2026-05-25",
    },
    new Date("2026-05-23T14:00:00Z")
  ),
  "live"
);

// ── Fixture 5: finalized, post-trip, past archive grace → archived ──────
assert(
  "archived — >3d past check-out",
  computeTripStage(
    {
      id: "p5",
      stage: "finalized",
      finalCheckIn: "2026-04-10",
      finalCheckOut: "2026-04-12",
    },
    new Date("2026-04-17T00:00:00Z")
  ),
  "archived"
);

// ── Extra fixture: locked during trip window should still be live ──────
assert(
  "live — locked stage mid-trip (fallback)",
  computeTripStage(
    {
      id: "p6",
      stage: "locked",
      finalCheckIn: "2026-05-01",
      finalCheckOut: "2026-05-04",
    },
    new Date("2026-05-02T09:00:00Z")
  ),
  "live"
);

// ── Extra fixture: post check-out within grace → still finalized ───────
assert(
  "finalized — within 3-day grace after checkOut",
  computeTripStage(
    {
      id: "p7",
      stage: "finalized",
      finalCheckIn: "2026-04-10",
      finalCheckOut: "2026-04-12",
    },
    new Date("2026-04-14T12:00:00Z")
  ),
  "finalized"
);

// ── Extra fixture: inputs.checkIn/checkOut fallback ────────────────────
assert(
  "live — inputs fallback (no finalCheck*)",
  computeTripStage(
    {
      id: "p8",
      stage: "finalized",
      inputs: { checkIn: "2026-05-22", checkOut: "2026-05-24" },
    },
    new Date("2026-05-23T10:00:00Z")
  ),
  "live"
);

console.log(`\n${passed}/${passed + failed} assertions passed`);
process.exit(failed === 0 ? 0 : 1);
