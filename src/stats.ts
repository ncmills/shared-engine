// Site-level archive stats. One pure function so every place that
// renders "N trips across M cities" on either brand lands on the same
// numbers.

export interface SiteStatsInputTrip {
  /** City string as rendered ("Nashville, TN"). Dedupe is string equality;
   *  callers should normalize their data to a single canonical form before
   *  passing. */
  destination: string;
  /** Group size used for the "totalGuests" sum. Missing = 0. */
  groupSize?: number;
  /** Mark true on seed fixtures so they're excluded from public stats. */
  isDevFixture?: boolean;
}

export interface SiteStatsInput {
  trips: SiteStatsInputTrip[];
  /** Count of city pages the site actually renders. Callers compute this
   *  from their route/sitemap output and pass it in. */
  citiesPublished?: number;
}

export interface SiteStats {
  /** Distinct destinations appearing in at least one published trip. */
  citiesWithData: number;
  /** Count of published trips (dev fixtures excluded). */
  totalTrips: number;
  /** Sum of groupSize across published trips. */
  totalGuests: number;
  /** Count of city pages that exist and render. */
  citiesPublished: number;
}

export function getSiteStats(input: SiteStatsInput): SiteStats {
  const published = input.trips.filter((t) => !t.isDevFixture);
  const cities = new Set<string>();
  let totalGuests = 0;
  for (const t of published) {
    if (t.destination) cities.add(t.destination);
    totalGuests += t.groupSize ?? 0;
  }
  return {
    citiesWithData: cities.size,
    totalTrips: published.length,
    totalGuests,
    citiesPublished: input.citiesPublished ?? 0,
  };
}
