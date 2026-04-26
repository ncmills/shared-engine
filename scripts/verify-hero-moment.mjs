#!/usr/bin/env -S npx tsx
/**
 * Fixture-based smoke test for the hero-moment validator.
 *
 * Run: `npx tsx scripts/verify-hero-moment.mjs` from shared-engine root.
 *
 * Convention mirrors verify-pricing.mjs / verify-trip-stage.mjs — explicit
 * pass/fail expectations per fixture, exits non-zero if any case is wrong.
 */
import { validateHeroMoment } from "../src/hero-moment-validator.ts";

const cases = [
  // ── Should PASS — concrete, named, specific ──
  {
    label: "Capt. Nick swordfish — full anchor",
    expected: "pass",
    h: {
      title: "Capt. Nick Stanczyk, midnight broadbills off Islamorada",
      description:
        "Nick runs 20 miles offshore, drops baits to 1,500 feet, and fights 400 lb swordfish under spreader lights. Window: April–July only.",
      namedOperator: "Capt. Nick Stanczyk",
      season: "April–July midnight broadbill window",
    },
  },
  {
    label: "Garrison Brothers tasting bookend",
    expected: "pass",
    h: {
      title: "Garrison Brothers single-barrel tasting, Hye Texas",
      description:
        "After the helicopter boar hunt, the group lands at Garrison Brothers in Hye for a private barrel pull and tasting flight. About 90 minutes from the strip.",
      namedOperator: "Garrison Brothers Distillery",
    },
  },
  {
    label: "September elk rut + Sage Lodge",
    expected: "pass",
    h: {
      title: "September bugling elk, Paradise Valley above Yellowstone",
      description:
        "Three guides, 4am alarm, glassing the meadows north of Yellowstone during peak rut. Decompression at Sage Lodge with hot towels and ribeye.",
      season: "September rut",
    },
  },
  {
    label: "Sonoma sunrise balloon",
    expected: "pass",
    h: {
      title: "Sunrise balloon over Sonoma, champagne pour at 1500ft",
      description:
        "Pre-dawn launch from Wine Country Balloons in Healdsburg. 60 minutes aloft over the Russian River vineyards, Veuve toast at altitude, Sonoma Plaza brunch on landing.",
      namedOperator: "Wine Country Balloons",
    },
  },

  // ── Should FAIL — generic, unanchored ──
  {
    label: "FAIL: dinner downtown",
    expected: "fail",
    h: {
      title: "Dinner downtown",
      description: "A nice dinner at one of the best restaurants in town.",
    },
  },
  {
    label: "FAIL: rooftop drinks",
    expected: "fail",
    h: {
      title: "Drinks at a rooftop bar",
      description:
        "Catch the sunset over the city skyline at a rooftop bar with the crew before heading out for the night.",
    },
  },
  {
    label: "FAIL: missing description",
    expected: "fail",
    h: {
      title: "Boundary Waters dog sled",
      description: "Sledding in the woods.",
    },
  },
  {
    label: "FAIL: missing entirely",
    expected: "fail",
    h: undefined,
  },
  {
    label: "FAIL: wine tasting day, no anchor",
    expected: "fail",
    h: {
      title: "Wine tasting day",
      description:
        "Hit a few wineries in the area, taste some local pours, get a little buzzed before the group dinner that night.",
    },
  },
];

let failed = 0;
for (const c of cases) {
  const result = validateHeroMoment(c.h);
  const got = result.ok ? "pass" : "fail";
  const ok = got === c.expected;
  const icon = ok ? "✓" : "✗";
  const reason = result.ok ? "" : `  reasons: ${result.reasons.join(" | ")}`;
  console.log(
    `${icon} [${c.expected}→${got}, score=${result.score}] ${c.label}${reason}`,
  );
  if (!ok) failed += 1;
}

// ── LLM-judge fallback fixtures ──
// Verifies validateHeroMomentWithJudge: regex-pass short-circuits judge,
// regex-fail with judge=ok overrides to ok=true, regex-fail with judge=fail
// keeps fail, judge throw falls back to regex result.
const { validateHeroMomentWithJudge } = await import("../src/hero-moment-validator.ts");

const passingHero = cases[0].h; // Capt. Nick swordfish — regex passes
const failingHero = cases[4].h; // dinner downtown — regex fails

let judgeCalled = 0;
const yesJudge = async () => { judgeCalled += 1; return { ok: true, reason: "looked specific to me" }; };
const noJudge = async () => { judgeCalled += 1; return { ok: false, reason: "still generic" }; };
const throwJudge = async () => { judgeCalled += 1; throw new Error("simulated judge crash"); };

// 1. Regex passes → judge never called
judgeCalled = 0;
const r1 = await validateHeroMomentWithJudge(passingHero, yesJudge);
const r1ok = r1.ok === true && judgeCalled === 0 && r1.judgeOverrode === undefined;
console.log(`${r1ok ? "✓" : "✗"} regex-pass short-circuits judge — ok=${r1.ok}, judgeCalls=${judgeCalled}`);
if (!r1ok) failed += 1;

// 2. Regex fails + judge=yes → override to ok=true
judgeCalled = 0;
const r2 = await validateHeroMomentWithJudge(failingHero, yesJudge);
const r2ok = r2.ok === true && r2.judgeOverrode === true && r2.judgeReason === "looked specific to me" && judgeCalled === 1;
console.log(`${r2ok ? "✓" : "✗"} regex-fail + judge=yes overrides to ok=true — ok=${r2.ok}, override=${r2.judgeOverrode}`);
if (!r2ok) failed += 1;

// 3. Regex fails + judge=no → stays failed (with judgeReason logged)
judgeCalled = 0;
const r3 = await validateHeroMomentWithJudge(failingHero, noJudge);
const r3ok = r3.ok === false && r3.judgeOverrode === false && r3.judgeReason === "still generic" && judgeCalled === 1;
console.log(`${r3ok ? "✓" : "✗"} regex-fail + judge=no upholds fail — ok=${r3.ok}, override=${r3.judgeOverrode}`);
if (!r3ok) failed += 1;

// 4. Judge throws → fall back to regex result, no crash
judgeCalled = 0;
const r4 = await validateHeroMomentWithJudge(failingHero, throwJudge);
const r4ok = r4.ok === false && judgeCalled === 1;
console.log(`${r4ok ? "✓" : "✗"} judge throws → falls back to regex without crash — ok=${r4.ok}`);
if (!r4ok) failed += 1;

// 5. No judge provided → regex result unchanged
judgeCalled = 0;
const r5 = await validateHeroMomentWithJudge(failingHero);
const r5ok = r5.ok === false && r5.judgeOverrode === undefined && judgeCalled === 0;
console.log(`${r5ok ? "✓" : "✗"} no judge supplied → regex result unchanged — ok=${r5.ok}`);
if (!r5ok) failed += 1;

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length + 5} fixtures wrong.`);
  process.exit(1);
}
console.log(`\nAll ${cases.length + 5} hero-moment fixtures pass (${cases.length} regex + 5 judge).`);
