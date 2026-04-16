/**
 * Trip Room V1 (2026-04-16) — booking deep-link constructors (shared).
 *
 * Each function builds a partner search URL pre-populated with the owner's
 * exact dates + party size + destination so the handoff kit is a true
 * one-stop booking surface. The refcode is passed in by the caller
 * ("moh-test" on MOH, "bestman-test" on BESTMAN) so this lib stays
 * brand-agnostic.
 *
 * All constructors are pure functions — no network calls. Missing dates/
 * guests are handled defensively (falls back to city-only search).
 */

export interface BookingContext {
  city?: string;
  state?: string;
  checkIn?: string;       // YYYY-MM-DD
  checkOut?: string;      // YYYY-MM-DD
  guestCount?: number;
  homeAirport?: string;   // 3-letter IATA
  destAirport?: string;
}

function encodeCity(city?: string, state?: string): string {
  if (!city) return "";
  const combined = state ? `${city}, ${state}` : city;
  return encodeURIComponent(combined);
}

// ─────────────────────────────────────────────────────────────────────
//  LODGING
// ─────────────────────────────────────────────────────────────────────

export function airbnbSearchUrl(ctx: BookingContext, refcode: string): string {
  const q = new URLSearchParams();
  if (ctx.guestCount) q.set("adults", String(ctx.guestCount));
  if (ctx.checkIn) q.set("checkin", ctx.checkIn);
  if (ctx.checkOut) q.set("checkout", ctx.checkOut);
  q.set("refcode", refcode);
  const city = encodeCity(ctx.city, ctx.state);
  return `https://www.airbnb.com/s/${city}/homes?${q.toString()}`;
}

export function vrboSearchUrl(ctx: BookingContext, refcode: string): string {
  const q = new URLSearchParams();
  if (ctx.city) q.set("q", ctx.state ? `${ctx.city}, ${ctx.state}` : ctx.city);
  if (ctx.checkIn) q.set("startDate", ctx.checkIn);
  if (ctx.checkOut) q.set("endDate", ctx.checkOut);
  if (ctx.guestCount) q.set("sleeps", String(ctx.guestCount));
  q.set("rid", refcode);
  return `https://www.vrbo.com/search?${q.toString()}`;
}

export function hotelsComSearchUrl(ctx: BookingContext, refcode: string): string {
  const q = new URLSearchParams();
  if (ctx.city) q.set("destination", ctx.state ? `${ctx.city}, ${ctx.state}` : ctx.city);
  if (ctx.checkIn) q.set("startDate", ctx.checkIn);
  if (ctx.checkOut) q.set("endDate", ctx.checkOut);
  q.set("rooms", "1");
  if (ctx.guestCount) q.set("adults", String(ctx.guestCount));
  q.set("affcid", refcode);
  return `https://www.hotels.com/Hotel-Search?${q.toString()}`;
}

export function bookingComSearchUrl(ctx: BookingContext, refcode: string): string {
  const q = new URLSearchParams();
  if (ctx.city) q.set("ss", ctx.state ? `${ctx.city}, ${ctx.state}` : ctx.city);
  if (ctx.checkIn) q.set("checkin", ctx.checkIn);
  if (ctx.checkOut) q.set("checkout", ctx.checkOut);
  if (ctx.guestCount) q.set("group_adults", String(ctx.guestCount));
  q.set("aid", refcode);
  return `https://www.booking.com/searchresults.html?${q.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────
//  ACTIVITIES
// ─────────────────────────────────────────────────────────────────────

export function viatorSearchUrl(ctx: BookingContext, refcode: string, venueQuery?: string): string {
  const q = new URLSearchParams();
  q.set("pid", refcode);
  q.set("medium", "link");
  if (ctx.checkIn) q.set("date", ctx.checkIn);
  if (venueQuery) q.set("text", venueQuery);
  const cityBit = ctx.city ? ctx.city.toLowerCase().replace(/\s+/g, "-") : "";
  const path = cityBit ? `/${cityBit}` : "";
  return `https://www.viator.com${path}?${q.toString()}`;
}

export function getYourGuideSearchUrl(ctx: BookingContext, refcode: string, venueQuery?: string): string {
  const q = new URLSearchParams();
  q.set("partner_id", refcode);
  if (ctx.checkIn) q.set("date", ctx.checkIn);
  if (venueQuery) q.set("q", venueQuery);
  const cityBit = ctx.city ? ctx.city.toLowerCase().replace(/\s+/g, "-") : "";
  const path = cityBit ? `/${cityBit}` : "";
  return `https://www.getyourguide.com${path}?${q.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────
//  DINING
// ─────────────────────────────────────────────────────────────────────

export function resySearchUrl(ctx: BookingContext, refcode: string, venueName?: string): string {
  const q = new URLSearchParams();
  if (ctx.checkIn) q.set("date", ctx.checkIn);
  if (ctx.guestCount) q.set("seats", String(Math.min(ctx.guestCount, 12)));
  q.set("utm_source", refcode);
  if (venueName) q.set("query", venueName);
  const cityBit = ctx.city ? ctx.city.toLowerCase().replace(/\s+/g, "-") : "";
  const path = cityBit ? `/cities/${cityBit}` : "";
  return `https://resy.com${path}?${q.toString()}`;
}

export function openTableSearchUrl(_refcode: string, ctx: BookingContext, venueName?: string): string {
  // OpenTable doesn't accept a public affiliate refcode in their search URL,
  // so refcode is accepted for signature parity but ignored.
  const q = new URLSearchParams();
  if (ctx.checkIn) {
    q.set("dateTime", `${ctx.checkIn}T19:00`);
  }
  if (ctx.guestCount) q.set("covers", String(Math.min(ctx.guestCount, 12)));
  if (venueName) q.set("q", venueName);
  if (ctx.city) q.set("location", ctx.city);
  return `https://www.opentable.com/s?${q.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────
//  FLIGHTS
// ─────────────────────────────────────────────────────────────────────

export function googleFlightsUrl(ctx: BookingContext): string {
  const from = ctx.homeAirport || "";
  const dest = ctx.destAirport || ctx.city || "";
  const checkIn = ctx.checkIn || "";
  const checkOut = ctx.checkOut || "";
  const q = `flights from ${from} to ${dest}${checkIn ? ` on ${checkIn}` : ""}${checkOut ? ` returning ${checkOut}` : ""}`.trim();
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

export function kayakFlightsUrl(ctx: BookingContext): string {
  const from = (ctx.homeAirport || "").toUpperCase();
  const dest = (ctx.destAirport || "").toUpperCase();
  if (from && dest && ctx.checkIn) {
    const range = ctx.checkOut ? `${ctx.checkIn}/${ctx.checkOut}` : ctx.checkIn;
    return `https://www.kayak.com/flights/${from}-${dest}/${range}`;
  }
  const q = new URLSearchParams();
  if (ctx.city) q.set("destination", ctx.city);
  return `https://www.kayak.com/flights?${q.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────
//  PAYMENTS
// ─────────────────────────────────────────────────────────────────────

export function venmoRequestUrl(username: string, amountCents: number, note: string): string {
  const amount = (amountCents / 100).toFixed(2);
  const q = new URLSearchParams();
  q.set("txn", "charge");
  q.set("amount", amount);
  q.set("note", note);
  q.set("audience", "private");
  return `https://venmo.com/${encodeURIComponent(username)}?${q.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────
//  GENERIC
// ─────────────────────────────────────────────────────────────────────

export function googleMapsUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export function googleSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

export type BookingPartner =
  | "airbnb"
  | "vrbo"
  | "hotels.com"
  | "booking.com"
  | "viator"
  | "getyourguide"
  | "resy"
  | "opentable"
  | "google-flights"
  | "kayak"
  | "venmo"
  | "google-maps"
  | "google-search";
