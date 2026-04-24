// Manual smoke test for H3.1 parseInboundEmail. Run:
//   npx tsx scripts/verify-email-parsers.mjs
// Expected: prints "ALL PASS" on exit 0.
import {
  parseInboundEmail,
  parseRecipientSlug,
  parseSenderAddress,
  detectProvider,
  parseLLMResponse,
} from "../src/room/email-parsers.ts";

// ────────────────────────────────────────────────────────────────────────
// Address-parsing cases
// ────────────────────────────────────────────────────────────────────────

const addressCases = [
  { in: "plan-matt-last-rodeo@mail.bestmanhq.com", out: "matt-last-rodeo" },
  { in: "Plan <PLAN-Jane-Does-Trip@mail.maidofhonorhq.com>", out: "jane-does-trip" },
  { in: "info@bestmanhq.com", out: null },                // wrong prefix
  { in: "plan-@mail.bestmanhq.com", out: null },          // empty slug
  { in: "", out: null },
  { in: undefined, out: null },
];

const senderCases = [
  { in: "Airbnb <automated@airbnb.com>", out: "automated@airbnb.com" },
  { in: "automated@airbnb.com", out: "automated@airbnb.com" },
  { in: "Not an email", out: null },
];

// ────────────────────────────────────────────────────────────────────────
// Provider detection
// ────────────────────────────────────────────────────────────────────────

const providerCases = [
  { from: "Airbnb <automated@airbnb.com>", want: "airbnb" },
  { from: "noreply@email.airbnb.com", want: "airbnb" },
  { from: "Delta <noreply@e.delta.com>", want: "delta" },
  { from: "Resy <hello@resy.com>", want: "resy" },
  { from: "random@example.com", want: "unknown" },
];

// ────────────────────────────────────────────────────────────────────────
// Golden-fixture provider parses
// ────────────────────────────────────────────────────────────────────────

const airbnbFixture = {
  from: "Airbnb <automated@airbnb.com>",
  to: "plan-sam-stag-weekend@mail.bestmanhq.com",
  subject: "Reservation confirmed: Loft in Charleston",
  text: [
    "Hi Sam,",
    "",
    "Your reservation at Luxury Loft in Downtown Charleston is confirmed.",
    "Check-in: Fri, May 15, 2026 — 4:00 PM",
    "Check-out: Sun, May 17, 2026 — 10:00 AM",
    "Guests: 8",
    "",
    "Grand total: $2,450.00",
    "",
    "View your itinerary: https://www.airbnb.com/rooms/12345678",
  ].join("\n"),
};

const deltaFixture = {
  from: "Delta Air Lines <delta@e.delta.com>",
  to: "plan-sam-stag-weekend@mail.bestmanhq.com",
  subject: "Your DL trip is confirmed — ATL to CHS",
  text: [
    "Confirmation Number: ABC123",
    "",
    "ATL → CHS",
    "Fri, May 15, 2026",
    "Depart 6:30 AM Atlanta (ATL) · Arrive 7:28 AM Charleston (CHS)",
    "",
    "Total charged: $312.40",
    "",
    "Manage your trip at https://www.delta.com/trips/view?pnr=ABC123",
  ].join("\n"),
};

// Build a tiny ICS body + base64 it for the Resy fixture attachment.
const icsBody = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:resy-987654",
  "SUMMARY:FIG (Charleston) — reservation for 8",
  "DTSTART:20260516T000000Z",
  "DTEND:20260516T020000Z",
  "LOCATION:232 Meeting St\\, Charleston\\, SC",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");
const icsBase64 = Buffer.from(icsBody, "utf8").toString("base64");

const resyFixture = {
  from: "Resy <noreply@resy.com>",
  to: "plan-sam-stag-weekend@mail.bestmanhq.com",
  subject: "Confirmed: FIG at 8:00 PM Sat May 16",
  text: [
    "You're booked at FIG for Saturday, May 16 at 8:00 PM.",
    "Party size: 8",
    "View or modify: https://resy.com/cities/chs/fig",
  ].join("\n"),
  attachments: [
    { filename: "reservation.ics", contentType: "text/calendar", content: icsBase64 },
  ],
};

// ────────────────────────────────────────────────────────────────────────
// LLM response parser
// ────────────────────────────────────────────────────────────────────────

const llmCases = [
  {
    label: "plain json",
    in: '{"category":"activities","title":"Helicopter tour","url":"https://x.com/t","price":"$600","providerName":"X","confidence":0.82}',
    want: { category: "activities", title: "Helicopter tour", confidence: 0.82 },
  },
  {
    label: "fenced json",
    in: '```json\n{"category":"dining","title":"Bar Crudo","url":null,"price":null,"providerName":null,"confidence":0.5}\n```',
    want: { category: "dining", title: "Bar Crudo", confidence: 0.5 },
  },
  { label: "null category rejected", in: '{"category":null,"title":null}', want: null },
  { label: "malformed rejected", in: "not json at all", want: null },
  { label: "bad category rejected", in: '{"category":"food","title":"x"}', want: null },
];

// ────────────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────────────

let failed = 0;
function assert(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error("FAIL:", label, "\n  got:", got, "\n want:", want); }
  else { console.log("ok:", label); }
}
function assertPartial(label, got, wantPartial) {
  if (got == null) { failed++; console.error("FAIL:", label, "got null"); return; }
  for (const [k, v] of Object.entries(wantPartial)) {
    const ok = JSON.stringify(got[k]) === JSON.stringify(v);
    if (!ok) { failed++; console.error("FAIL:", label, "field", k, "got:", got[k], "want:", v); return; }
  }
  console.log("ok:", label);
}

for (const c of addressCases) {
  assert(`recipient slug: ${JSON.stringify(c.in)}`, parseRecipientSlug(c.in), c.out);
}

for (const c of senderCases) {
  assert(`sender parse: ${JSON.stringify(c.in)}`, parseSenderAddress(c.in), c.out);
}

for (const c of providerCases) {
  assert(`provider from ${c.from}`, detectProvider({ from: c.from }), c.want);
}

// Airbnb fixture
{
  const slug = parseRecipientSlug(airbnbFixture.to);
  assert("airbnb slug extracted", slug, "sam-stag-weekend");
  const seed = parseInboundEmail(airbnbFixture, slug);
  assertPartial("airbnb seed", seed, {
    planSlug: "sam-stag-weekend",
    senderEmail: "automated@airbnb.com",
    category: "lodging",
    price: "$2,450.00",
    providerName: "Airbnb",
  });
  if (seed && !seed.title.toLowerCase().includes("charleston")) {
    failed++; console.error("FAIL: airbnb title missing venue:", seed.title);
  } else if (seed) console.log("ok: airbnb title includes venue");
  if (seed && !seed.url?.includes("airbnb.com/rooms/12345678")) {
    failed++; console.error("FAIL: airbnb url:", seed.url);
  } else console.log("ok: airbnb url extracted");
}

// Delta fixture
{
  const slug = parseRecipientSlug(deltaFixture.to);
  const seed = parseInboundEmail(deltaFixture, slug);
  assertPartial("delta seed", seed, {
    planSlug: "sam-stag-weekend",
    senderEmail: "delta@e.delta.com",
    category: "flights",
    price: "$312.40",
    providerName: "Delta",
  });
  if (seed && !seed.title.includes("ATL → CHS")) {
    failed++; console.error("FAIL: delta title missing route:", seed.title);
  } else if (seed) console.log("ok: delta title has route");
  if (seed && !seed.title.includes("ABC123")) {
    failed++; console.error("FAIL: delta title missing conf:", seed.title);
  } else if (seed) console.log("ok: delta title has confirmation");
}

// Resy fixture (ICS attachment path)
{
  const slug = parseRecipientSlug(resyFixture.to);
  const seed = parseInboundEmail(resyFixture, slug);
  assertPartial("resy seed", seed, {
    planSlug: "sam-stag-weekend",
    senderEmail: "noreply@resy.com",
    category: "dining",
    providerName: "Resy",
  });
  if (seed && !seed.title.toLowerCase().includes("fig")) {
    failed++; console.error("FAIL: resy title missing venue:", seed.title);
  } else if (seed) console.log("ok: resy title has venue from ICS");
  if (seed && !seed.title.includes("2026-05-16")) {
    failed++; console.error("FAIL: resy title missing ISO date:", seed.title);
  } else if (seed) console.log("ok: resy title has date from ICS DTSTART");
}

// Unknown provider → returns null (caller falls back to LLM)
{
  const unknown = {
    from: "Random Platform <hello@weird-bookings.example>",
    to: "plan-sam-stag-weekend@mail.bestmanhq.com",
    subject: "Booking confirmed",
    text: "Your booking at Random Place is confirmed.",
  };
  const slug = parseRecipientSlug(unknown.to);
  const seed = parseInboundEmail(unknown, slug);
  assert("unknown provider returns null", seed, null);
}

// LLM response parser
for (const c of llmCases) {
  const got = parseLLMResponse(c.in);
  if (c.want === null) assert(c.label, got, null);
  else assertPartial(c.label, got, c.want);
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
