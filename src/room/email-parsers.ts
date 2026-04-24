/**
 * Trip Room H3.1 — inbound email → Candidate parsers.
 *
 * Normalizes an ImprovMX-style webhook payload into an `EmailCandidateSeed`
 * that a webhook route can hand straight to the pool handlers.
 *
 * Pure functions, framework-free. The webhook route owns auth, rate
 * limiting, Supabase writes, and the LLM fallback (Haiku 4.5). This
 * module just pattern-matches the three highest-volume providers
 * (Airbnb · Delta · Resy) and exposes the shapes + helpers the route
 * needs.
 *
 * ImprovMX webhook payload shape (verified 2026-04-24 via docs):
 *   { to, from, subject, text, html, headers, attachments[], inlines[],
 *     spf, dkim, timestamp }
 * Attachment bodies are base64-encoded in the JSON.
 */

import type { CandidateCategory } from "./types";

// ────────────────────────────────────────────────────────────────────────
// Normalized inbound payload (ImprovMX today; room to absorb others)
// ────────────────────────────────────────────────────────────────────────

export interface InboundAttachment {
  filename?: string;
  contentType?: string;
  /** Base64-encoded body. */
  content?: string;
}

export interface InboundEmailPayload {
  to?: string;
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  attachments?: InboundAttachment[];
  headers?: Record<string, string>;
}

// ────────────────────────────────────────────────────────────────────────
// Output: shape the webhook route hands to the pool-handler layer
// ────────────────────────────────────────────────────────────────────────

export interface EmailCandidateSeed {
  planSlug: string;
  senderEmail: string;
  category: CandidateCategory;
  title: string;
  url?: string;
  price?: string;
  description?: string;
  imageUrl?: string;
  providerName?: string;
  notes?: string;
}

// ────────────────────────────────────────────────────────────────────────
// Address parsing: plan-{slug}@mail.bestmanhq.com → slug
// ────────────────────────────────────────────────────────────────────────

/**
 * Extract a plan slug from a `plan-{slug}@<host>` email address.
 * Host is not validated — the webhook route is per-domain, so if email
 * hit this route, the host is already the right one.
 */
export function parseRecipientSlug(to: string | undefined | null): string | null {
  if (!to) return null;
  const lower = to.toLowerCase().trim();
  // Address may come as "Display Name <plan-foo@mail.bestmanhq.com>" or raw.
  const match = lower.match(/<?plan-([a-z0-9-]+)@/);
  const slug = match?.[1];
  if (!slug) return null;
  if (slug.length < 3 || slug.length > 120) return null;
  return slug;
}

/**
 * Extract a clean email out of a `From:` header which may be
 * "Name <user@host>" or just `user@host`.
 */
export function parseSenderAddress(from: string | undefined | null): string | null {
  if (!from) return null;
  const lower = from.toLowerCase().trim();
  const angle = lower.match(/<([^>]+)>/);
  const raw = (angle?.[1] ?? lower).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : null;
}

// ────────────────────────────────────────────────────────────────────────
// Provider detection
// ────────────────────────────────────────────────────────────────────────

export type ProviderKey = "airbnb" | "delta" | "resy" | "unknown";

const PROVIDER_FROM_MATCHERS: Array<{ key: ProviderKey; re: RegExp }> = [
  { key: "airbnb", re: /@(?:\w+\.)?airbnb\.com$/i },
  { key: "delta", re: /@(?:\w+\.)?delta\.com$/i },
  { key: "resy", re: /@(?:\w+\.)?resy\.com$/i },
];

export function detectProvider(payload: InboundEmailPayload): ProviderKey {
  const sender = parseSenderAddress(payload.from);
  if (!sender) return "unknown";
  for (const { key, re } of PROVIDER_FROM_MATCHERS) {
    if (re.test(sender)) return key;
  }
  return "unknown";
}

// ────────────────────────────────────────────────────────────────────────
// Top-level parser
// ────────────────────────────────────────────────────────────────────────

/**
 * Try to deterministically extract a Candidate from the email. Returns
 * null when no provider matcher fires OR when the provider matcher
 * couldn't find its required fields — the webhook route should then
 * fall back to an LLM extractor.
 *
 * Callers must provide the `to` already parsed into a slug via
 * `parseRecipientSlug`. We still re-read the sender inside so the seed
 * carries it without the caller building a parallel parser.
 */
export function parseInboundEmail(
  payload: InboundEmailPayload,
  planSlug: string
): EmailCandidateSeed | null {
  const senderEmail = parseSenderAddress(payload.from);
  if (!senderEmail) return null;

  const provider = detectProvider(payload);
  let base: ParsedFields | null = null;

  if (provider === "airbnb") base = parseAirbnb(payload);
  else if (provider === "delta") base = parseDelta(payload);
  else if (provider === "resy") base = parseResy(payload);

  if (!base) return null;

  return {
    planSlug,
    senderEmail,
    category: base.category,
    title: base.title,
    url: base.url,
    price: base.price,
    description: base.description,
    providerName: base.providerName,
    imageUrl: base.imageUrl,
    notes: base.notes,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Provider extractors
// ────────────────────────────────────────────────────────────────────────

interface ParsedFields {
  category: CandidateCategory;
  title: string;
  url?: string;
  price?: string;
  description?: string;
  providerName?: string;
  imageUrl?: string;
  notes?: string;
}

function parseAirbnb(p: InboundEmailPayload): ParsedFields | null {
  const bodyText = normalizeToText(p);
  if (!bodyText) return null;

  // Listing name: Airbnb confirmations lead with "Your reservation at <Name>"
  // or "You're confirmed for <Name>" or a standalone heading with the name.
  const listing =
    bodyText.match(/Your reservation at ([^\n]+?)\s*(?:is confirmed|—|\.|\n)/i)?.[1] ??
    bodyText.match(/You're confirmed for ([^\n]+?)\s*(?:—|\.|\n)/i)?.[1] ??
    bodyText.match(/Reservation at ([^\n]+?)\s*(?:—|\.|\n)/i)?.[1] ??
    p.subject?.replace(/^Re:\s*/i, "").replace(/^(?:Reservation confirmed:|Your trip to)\s*/i, "").trim() ??
    "Airbnb reservation";

  const price = extractDollarAmount(bodyText);
  const url = extractFirstUrl(bodyText, /airbnb\.com\/rooms\/\d+/i) ??
    extractFirstUrl(bodyText, /airbnb\.com\/[a-z0-9/-]+/i);

  return {
    category: "lodging",
    title: collapseSpaces(listing).slice(0, 140),
    url,
    price,
    providerName: "Airbnb",
    notes: `Forwarded from ${parseSenderAddress(p.from) ?? "airbnb.com"}`,
  };
}

function parseDelta(p: InboundEmailPayload): ParsedFields | null {
  const bodyText = normalizeToText(p);
  if (!bodyText) return null;

  // Delta confirmation emails include the confirmation number + itinerary.
  // Pull a short human-readable itinerary title: either the subject line
  // or a "<From> to <To>" pair.
  const route = bodyText.match(/([A-Z]{3})\s*(?:to|→|-)\s*([A-Z]{3})/);
  const conf = bodyText.match(/Confirmation (?:Number|#|Code)[^\w]*([A-Z0-9]{6})/i)?.[1];
  const title = route
    ? `Delta ${route[1]} → ${route[2]}${conf ? ` · ${conf}` : ""}`
    : p.subject?.trim() || "Delta itinerary";

  const price = extractDollarAmount(bodyText);
  const url = extractFirstUrl(bodyText, /delta\.com\/[a-z0-9/?=&_-]+/i);

  return {
    category: "flights",
    title: collapseSpaces(title).slice(0, 140),
    url,
    price,
    providerName: "Delta",
    notes: `Forwarded from ${parseSenderAddress(p.from) ?? "delta.com"}`,
  };
}

function parseResy(p: InboundEmailPayload): ParsedFields | null {
  // Prefer the ICS attachment when present — Resy names it "reservation.ics"
  // or similar. ICS has DTSTART + SUMMARY which give us the date + venue.
  const ics = (p.attachments ?? []).find((a) => {
    const name = (a.filename ?? "").toLowerCase();
    const type = (a.contentType ?? "").toLowerCase();
    return name.endsWith(".ics") || type.includes("calendar") || type.includes("ics");
  });

  let venue: string | undefined;
  let startHuman: string | undefined;

  if (ics?.content) {
    const decoded = tryDecodeBase64(ics.content);
    if (decoded) {
      const summaryMatch = decoded.match(/SUMMARY[:;][^:\n]*?:([^\r\n]+)/i);
      const dtstartMatch = decoded.match(/DTSTART(?:;[^:\n]*)?:([0-9T]+Z?)/);
      if (summaryMatch?.[1]) venue = unescapeIcsText(summaryMatch[1]).trim();
      if (dtstartMatch?.[1]) startHuman = humanizeIcsDate(dtstartMatch[1]);
    }
  }

  const bodyText = normalizeToText(p);

  // Fallback extraction from the email body if ICS didn't carry a summary.
  if (!venue) {
    venue =
      bodyText?.match(/You're booked at ([^\n]+?)\s*(?:—|\.|\n|for)/i)?.[1] ??
      bodyText?.match(/Reservation at ([^\n]+?)\s*(?:—|\.|\n|for)/i)?.[1] ??
      p.subject?.replace(/^Re:\s*/i, "").replace(/^(?:Confirmed:|You're going to)\s*/i, "").trim() ??
      undefined;
  }
  if (!venue) return null;

  const url = bodyText ? extractFirstUrl(bodyText, /resy\.com\/[a-z0-9/?=&_-]+/i) : undefined;

  return {
    category: "dining",
    title: collapseSpaces(`${venue}${startHuman ? ` · ${startHuman}` : ""}`).slice(0, 140),
    url,
    providerName: "Resy",
    notes: `Forwarded from ${parseSenderAddress(p.from) ?? "resy.com"}`,
  };
}

// ────────────────────────────────────────────────────────────────────────
// LLM fallback contract
// ────────────────────────────────────────────────────────────────────────

/**
 * Build a strict-JSON-response prompt for Haiku 4.5 when none of the
 * deterministic extractors matched. The webhook route owns the actual
 * API call + caching; this module just shapes the input/output.
 */
export function buildLLMPrompt(payload: InboundEmailPayload): string {
  const { from, subject } = payload;
  const body = (normalizeToText(payload) ?? "").slice(0, 8000);
  return (
    `You are extracting booking details from a forwarded confirmation email.\n` +
    `Output ONLY a single-line JSON object with these keys (no prose):\n` +
    `  category: one of lodging|activities|dining|bars|flights|transport\n` +
    `  title: short human title (≤100 chars)\n` +
    `  url: booking URL if present, else null\n` +
    `  price: exact price string as seen, else null\n` +
    `  providerName: the booking site name (Airbnb, OpenTable, etc.), else null\n` +
    `  confidence: 0.0–1.0 — your own estimate\n\n` +
    `If the email is not a booking confirmation, return {"category":null,"title":null,"url":null,"price":null,"providerName":null,"confidence":0}\n\n` +
    `From: ${from ?? ""}\nSubject: ${subject ?? ""}\n\n---\n${body}\n---`
  );
}

export interface LLMCandidateResult {
  category: CandidateCategory;
  title: string;
  url?: string;
  price?: string;
  providerName?: string;
  confidence: number;
}

const VALID_LLM_CATEGORIES: CandidateCategory[] = [
  "lodging", "activities", "dining", "bars", "flights", "transport",
];

/**
 * Parse the LLM's single-line JSON response. Returns null on malformed
 * JSON, missing category/title, or category outside the valid set.
 */
export function parseLLMResponse(raw: string): LLMCandidateResult | null {
  const trimmed = raw.trim();
  // Some models wrap in ```json fences — strip if present.
  const jsonStr = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  const category = typeof obj.category === "string" ? obj.category as CandidateCategory : null;
  const title = typeof obj.title === "string" ? obj.title.trim() : null;
  if (!category || !title) return null;
  if (!VALID_LLM_CATEGORIES.includes(category)) return null;
  const confidence = typeof obj.confidence === "number" ? obj.confidence : 0;
  return {
    category,
    title: title.slice(0, 140),
    url: typeof obj.url === "string" ? obj.url : undefined,
    price: typeof obj.price === "string" ? obj.price : undefined,
    providerName: typeof obj.providerName === "string" ? obj.providerName : undefined,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

// ────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────

function normalizeToText(p: InboundEmailPayload): string | null {
  if (p.text && p.text.trim()) return p.text;
  if (p.html && p.html.trim()) return stripHtml(p.html);
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function extractDollarAmount(text: string): string | undefined {
  // Prefer lines that explicitly mention total/grand/subtotal.
  const totalLine = text.match(/(?:grand\s+total|total(?:\s+charged)?|amount\s+charged)[^\n]{0,40}?\$([\d,]+(?:\.\d{2})?)/i);
  if (totalLine) return `$${totalLine[1]}`;
  const any = text.match(/\$([\d,]+(?:\.\d{2})?)/);
  return any ? `$${any[1]}` : undefined;
}

function extractFirstUrl(text: string, pathRegex: RegExp): string | undefined {
  // Require https:// preceding the host. Allow any subdomain prefix
  // (e.g. `www.`, `email.`) so hand-written regexes can target the
  // apex domain and still catch subdomain URLs.
  const re = new RegExp(`https?://(?:[a-z0-9-]+\\.)*${pathRegex.source}`, pathRegex.flags);
  const m = text.match(re);
  return m ? m[0] : undefined;
}

function tryDecodeBase64(b64: string): string | null {
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(b64, "base64").toString("utf8");
    }
    // Browser fallback — unused in this module's expected runtimes but kept for safety.
    return atob(b64);
  } catch {
    return null;
  }
}

function unescapeIcsText(s: string): string {
  return s.replace(/\\n/g, " ").replace(/\\,/g, ",").replace(/\\;/g, ";");
}

function humanizeIcsDate(dt: string): string | undefined {
  // DTSTART values can be YYYYMMDD or YYYYMMDDTHHMMSSZ.
  const m = dt.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
  if (!m) return undefined;
  const [, y, mo, d, hh, mm] = m;
  if (!hh) return `${y}-${mo}-${d}`;
  const h = parseInt(hh, 10);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${y}-${mo}-${d} ${h12}:${mm} ${ampm}`;
}
