export interface HobbyVenueLike {
  name: string;
  highlight?: string;
  type?: string;
  cuisine?: string;
}

export interface HobbyDestinationLike {
  city: string;
  tagline: string;
  description: string;
  activities: readonly HobbyVenueLike[];
  nightlife: readonly HobbyVenueLike[];
  dining: readonly HobbyVenueLike[];
  lodging: readonly HobbyVenueLike[];
}

/**
 * Fuzzy-match honoree hobbies against destination venue/activity text.
 * Counts how many hobbies find at least one textual hit anywhere in the
 * destination data. Used by the personalization-density and hobby-anchor
 * scoring factors.
 *
 * Extracted 2026-04-15 from identical copies in BESTMAN + MOH
 * party-planner-prompt.ts.
 */
export function countHobbyMatches(
  hobbies: string[] | undefined,
  dest: HobbyDestinationLike
): { matchedHobbies: string[]; hitCount: number } {
  if (!hobbies || hobbies.length === 0) return { matchedHobbies: [], hitCount: 0 };
  const haystackParts: (string | undefined)[] = [
    dest.city,
    dest.tagline,
    dest.description,
    ...dest.activities.flatMap((a) => [a.name, a.highlight, a.type]),
    ...dest.nightlife.flatMap((v) => [v.name, v.highlight, v.type]),
    ...dest.dining.flatMap((d) => [d.name, d.highlight, d.cuisine]),
    ...dest.lodging.flatMap((l) => [l.name, l.highlight, l.type]),
  ];
  const haystack = haystackParts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ").toLowerCase();
  const matched: string[] = [];
  let totalHits = 0;
  for (const raw of hobbies) {
    const h = raw.trim().toLowerCase();
    if (!h || h.length < 2) continue;
    const tokens = h.split(/\s+/).filter((t) => t.length >= 3);
    const hits = tokens.reduce((n, t) => n + (haystack.includes(t) ? 1 : 0), 0);
    if (hits > 0) {
      matched.push(raw);
      totalHits += hits;
    }
  }
  return { matchedHobbies: matched, hitCount: totalHits };
}
