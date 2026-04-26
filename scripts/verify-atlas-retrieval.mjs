#!/usr/bin/env -S npx tsx
/**
 * Atlas-retrieval smoke test. Builds a synthetic atlas and queries it
 * with a few representative wizard-state-style inputs to confirm the
 * scoring + topK + nearestRegion behave correctly.
 *
 * Run: `npx tsx scripts/verify-atlas-retrieval.mjs` from shared-engine root.
 */
import {
  scoreAtlas,
  topK,
  nearestRegion,
} from "../src/atlas-retrieval.ts";

/** @type {import("../src/atlas-retrieval.ts").AtlasEntry[]} */
const atlas = [
  {
    id: "boar-hunt-hill-country",
    slug: "helicopter-boar-hunt-texas-weekend",
    title: "Helicopter Boar Hunt Weekend",
    destination: "Austin + Hill Country, TX",
    regionKey: "texas-hill-country",
    season: [11, 12, 1, 2],
    nights: 2,
    minGroup: 4,
    maxGroup: 8,
    budgetBucket: 3,
    estPerPerson: [2400, 4200],
    categoryTags: ["hunt-wilderness", "outdoors", "guns", "bourbon"],
    narrative: "R44 at dawn over invasive hogs.",
    namedOperators: ["Heli-Hunter", "Garrison Brothers"],
  },
  {
    id: "elk-bugle-san-juans",
    slug: "elk-bugle-backcountry-colorado",
    title: "Elk Bugle Backcountry Camp",
    destination: "Pagosa Springs + San Juans, CO",
    regionKey: "colorado-san-juans",
    season: [9],
    nights: 4,
    minGroup: 4,
    maxGroup: 6,
    budgetBucket: 4,
    estPerPerson: [3800, 6500],
    categoryTags: ["hunt-wilderness", "outdoors", "horseback", "remote"],
    narrative: "Horse pack-in to a wall tent camp at 10000 ft.",
  },
  {
    id: "tarpon-homosassa",
    slug: "tarpon-fly-homosassa-keys",
    title: "Tarpon-on-Fly at Homosassa",
    destination: "Homosassa, FL",
    regionKey: "florida-keys",
    season: [5, 6],
    nights: 3,
    minGroup: 4,
    maxGroup: 6,
    budgetBucket: 4,
    estPerPerson: [3500, 5500],
    categoryTags: ["fishing-water", "outdoors", "fly-fishing"],
    narrative: "Capt. Nick Stanczyk runs the palace flat in May.",
    namedOperators: ["Stanczyk Charters"],
  },
  {
    id: "bonneville-speed-week",
    slug: "bonneville-salt-flats-speed-day",
    title: "Bonneville Salt Flats Speed Day",
    destination: "Wendover, UT",
    regionKey: "utah-bonneville",
    season: [8],
    nights: 3,
    minGroup: 6,
    maxGroup: 12,
    budgetBucket: 3,
    estPerPerson: [1800, 3200],
    categoryTags: ["industrial-strange", "speed", "machine"],
    narrative: "Run a B-class belly tank during Speed Week.",
  },
  {
    id: "boundary-waters-dogsled",
    slug: "boundary-waters-dog-sled-weekend",
    title: "Boundary Waters Dog Sled",
    destination: "Ely, MN",
    regionKey: "boundary-waters-mn",
    season: [1, 2, 3],
    nights: 4,
    minGroup: 4,
    maxGroup: 8,
    budgetBucket: 3,
    estPerPerson: [2200, 3800],
    categoryTags: ["mountain-snow", "outdoors", "wilderness"],
    narrative: "Mush a dog team across frozen lakes.",
  },
  {
    id: "hill-country-boar-2",
    slug: "hill-country-suppressor-bourbon",
    title: "Hill Country Suppressor + Bourbon",
    destination: "Hill Country, TX",
    regionKey: "texas-hill-country",
    season: [10, 11, 12],
    nights: 2,
    minGroup: 4,
    maxGroup: 10,
    budgetBucket: 3,
    estPerPerson: [2200, 3800],
    categoryTags: ["hunt-wilderness", "outdoors", "guns", "bourbon"],
    narrative: "Same Hill Country region, similar tags — should be diversity-filtered.",
  },
];

const cases = [
  {
    label: "exact: Hill Country bourbon weekend",
    query: {
      destination: "Austin Hill Country",
      regionKey: "texas-hill-country",
      monthIndex: 12,
      groupSize: 6,
      tier: "theLegend",
      vibeTags: ["outdoors", "bourbon", "guns"],
    },
    expectTopId: "boar-hunt-hill-country",
    expectTopConfidence: "exact",
  },
  {
    label: "region: Florida fishing",
    query: {
      destination: "Florida Keys",
      regionKey: "florida-keys",
      monthIndex: 5,
      groupSize: 5,
      tier: "theKing",
      vibeTags: ["fishing", "outdoors"],
    },
    expectTopId: "tarpon-homosassa",
    expectTopConfidence: "exact",
  },
  {
    label: "no match: Tulsa",
    query: {
      destination: "Tulsa, OK",
      regionKey: "oklahoma-tulsa",
      monthIndex: 6,
      groupSize: 8,
      tier: "theLegend",
      vibeTags: ["nightlife", "comedy"],
    },
    expectAllConfidence: "none",
  },
];

let failed = 0;
for (const c of cases) {
  const hits = scoreAtlas(c.query, atlas);
  const top = hits[0];
  const confidence = top?.confidence ?? "none";
  if (c.expectAllConfidence) {
    const ok = hits.every((h) => h.confidence === c.expectAllConfidence);
    console.log(
      `${ok ? "✓" : "✗"} ${c.label} — every hit confidence=${c.expectAllConfidence}, top score=${top?.score ?? 0}`,
    );
    if (!ok) failed += 1;
  } else {
    const ok = top?.entry.id === c.expectTopId && confidence === c.expectTopConfidence;
    console.log(
      `${ok ? "✓" : "✗"} ${c.label} — got id=${top?.entry.id} score=${top?.score} conf=${confidence}; expected ${c.expectTopId}/${c.expectTopConfidence}`,
    );
    if (!ok) {
      console.log(`    reasons: ${top?.reasons.join(" | ")}`);
      failed += 1;
    }
  }
}

// Diversity test: query that hits both Hill Country boar entries should
// only return one (regionKey + categoryTags overlap >= 50%).
const diversityHits = scoreAtlas(
  {
    destination: "Austin Hill Country",
    regionKey: "texas-hill-country",
    monthIndex: 12,
    groupSize: 6,
    tier: "theLegend",
    vibeTags: ["outdoors", "bourbon", "guns"],
  },
  atlas,
);
const top3 = topK(diversityHits, 3);
const hillCountryCount = top3.filter((h) => h.entry.regionKey === "texas-hill-country").length;
console.log(
  `${hillCountryCount === 1 ? "✓" : "✗"} diversity penalty trims duplicate Hill Country to 1 — got ${hillCountryCount} (top3 ids: ${top3.map((h) => h.entry.id).join(", ")})`,
);
if (hillCountryCount !== 1) failed += 1;

// nearestRegion fallback for an unknown destination.
const near = nearestRegion(
  { destination: "Tulsa, OK", regionKey: "oklahoma-tulsa" },
  atlas,
);
console.log(`✓ nearestRegion fallback for Tulsa picked: ${near?.id} (regionKey=${near?.regionKey})`);

// categoryHints boost: same query, with/without hints — hints must increase
// the score for hint-matching entries without affecting confidence (geo-gated).
const baseQuery = {
  destination: "Florida Keys",
  regionKey: "florida-keys",
  monthIndex: 5,
  groupSize: 5,
  tier: "theKing",
  vibeTags: [],
};
const baseTop = scoreAtlas(baseQuery, atlas)[0];
const hintedTop = scoreAtlas({ ...baseQuery, categoryHints: ["fly-fishing"] }, atlas)[0];
const boosted = (hintedTop?.score ?? 0) > (baseTop?.score ?? 0);
const sameConf = hintedTop?.confidence === baseTop?.confidence;
console.log(
  `${boosted && sameConf ? "✓" : "✗"} categoryHints boosts score (${baseTop?.score} → ${hintedTop?.score}) without inflating confidence (${baseTop?.confidence})`,
);
if (!boosted || !sameConf) failed += 1;

// Destination-level dedup: two entries at the same destination string but
// with different categoryTags should both score, but topK must keep only one.
const sameDestAtlas = [
  ...atlas,
  {
    id: "marfa-art",
    slug: "marfa-art-weekend",
    title: "Marfa Art Weekend",
    destination: "Marfa, TX",
    regionKey: "west-texas",
    season: [3, 4, 10, 11],
    nights: 3,
    minGroup: 4,
    maxGroup: 10,
    budgetBucket: 2,
    estPerPerson: [1200, 2400],
    categoryTags: ["editorial-stay", "art-gallery"],
    narrative: "Donald Judd's foundation, Cosmico airstreams.",
  },
  {
    id: "marfa-desert",
    slug: "marfa-desert-offroad",
    title: "Marfa Desert Off-Road",
    destination: "Marfa, TX",
    regionKey: "west-texas",
    season: [3, 4, 10, 11],
    nights: 3,
    minGroup: 4,
    maxGroup: 10,
    budgetBucket: 2,
    estPerPerson: [1400, 2600],
    categoryTags: ["desert-utv", "outdoors"],
    narrative: "UTV through Big Bend foothills, mystery lights at night.",
  },
];
const marfaQuery = {
  destination: "Marfa, TX",
  regionKey: "west-texas",
  monthIndex: 3,
  groupSize: 6,
  tier: "theLegend",
  vibeTags: [],
};
const marfaTop3 = topK(scoreAtlas(marfaQuery, sameDestAtlas), 3);
const marfaCount = marfaTop3.filter((h) => h.entry.destination === "Marfa, TX").length;
console.log(
  `${marfaCount === 1 ? "✓" : "✗"} destination-level dedup keeps 1 Marfa in topK — got ${marfaCount} (top3 ids: ${marfaTop3.map((h) => h.entry.id).join(", ")})`,
);
if (marfaCount !== 1) failed += 1;

// Phase 9c audience filter: query audience=bachelorette must drop a
// bachelor-only entry; untagged entries pass; cross-tagged entries pass.
const audienceAtlas = [
  { ...atlas[0], id: "bachelor-only", audiences: ["bachelor"] },          // boar hunt
  { ...atlas[2], id: "bachelorette-only", audiences: ["bachelorette"] },  // tarpon flat
  { ...atlas[4], id: "cross-tagged", audiences: ["bachelor", "bachelorette"] }, // dog sled
  { ...atlas[3], id: "untagged" },                                        // bonneville (no audiences)
];
const audienceQuery = {
  destination: "anywhere",
  monthIndex: 6,
  groupSize: 6,
  tier: "theLegend",
  vibeTags: [],
  audience: "bachelorette",
};
const audienceHits = scoreAtlas(audienceQuery, audienceAtlas);
const audienceIds = new Set(audienceHits.map((h) => h.entry.id));
const droppedBachelorOnly = !audienceIds.has("bachelor-only");
const keptCrossTagged = audienceIds.has("cross-tagged");
const keptBacheloretteOnly = audienceIds.has("bachelorette-only");
const keptUntagged = audienceIds.has("untagged");
const audOk = droppedBachelorOnly && keptCrossTagged && keptBacheloretteOnly && keptUntagged;
console.log(
  `${audOk ? "✓" : "✗"} audience=bachelorette filter — dropped(bachelor-only)=${droppedBachelorOnly}, kept(cross-tagged)=${keptCrossTagged}, kept(bachelorette-only)=${keptBacheloretteOnly}, kept(untagged)=${keptUntagged}`,
);
if (!audOk) failed += 1;

if (failed > 0) {
  console.error(`\n${failed} fixtures wrong.`);
  process.exit(1);
}
console.log(`\nAll atlas-retrieval fixtures pass.`);
