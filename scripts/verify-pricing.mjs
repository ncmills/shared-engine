// Manual smoke test for parseCentsFromPriceString. Run:
//   npx tsx scripts/verify-pricing.mjs
// Expected: prints "ALL PASS" on exit 0.
import { parseCentsFromPriceString } from "../src/pricing.ts";

const cases = [
  { in: "$125",              out: { cents: 12500, perPersonHint: false } },
  { in: "$1,250.00",         out: { cents: 125000, perPersonHint: false } },
  { in: "from $320",         out: { cents: 32000, perPersonHint: false } },
  { in: "$125/pp",           out: { cents: 12500, perPersonHint: true } },
  { in: "$85 per person",    out: { cents: 8500, perPersonHint: true } },
  { in: "$40 each",          out: { cents: 4000, perPersonHint: true } },
  { in: "",                  out: null },
  { in: null,                out: null },
  { in: "TBD",               out: { cents: 0, perPersonHint: false } },
  { in: "approx. $1,500/person", out: { cents: 150000, perPersonHint: true } },
];

let failed = 0;
for (const c of cases) {
  const got = parseCentsFromPriceString(c.in);
  const ok = JSON.stringify(got) === JSON.stringify(c.out);
  if (!ok) { failed++; console.error("FAIL:", c.in, "→", got, "expected", c.out); }
  else { console.log("ok:", JSON.stringify(c.in), "→", JSON.stringify(got)); }
}
console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
