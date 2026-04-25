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

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} fixtures wrong.`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} hero-moment fixtures pass.`);
