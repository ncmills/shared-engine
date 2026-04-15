/**
 * Parse model-emitted JSON defensively. Handles markdown fences, trailing
 * commentary, and bracket-truncated output. Returns null if unsalvageable.
 *
 * Extracted 2026-04-15 from identical copies in BESTMAN + MOH route.ts.
 */
export function tryParseJSON(jsonStr: string): unknown | null {
  // Strip markdown fences
  let s = jsonStr.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  // Direct parse
  try { return JSON.parse(s); } catch { /* fall through */ }

  // Strip trailing text after the last } (Haiku sometimes appends commentary)
  const lastBrace = s.lastIndexOf("}");
  if (lastBrace > 0 && lastBrace < s.length - 1) {
    const trimmed = s.slice(0, lastBrace + 1);
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }

  // Try to repair truncated JSON by closing open brackets/braces
  let repaired = s;
  repaired = repaired.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, "");
  repaired = repaired.replace(/,\s*$/, "");

  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (const ch of repaired) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (stack.length > 0) {
    repaired += stack.reverse().join("");
    try { return JSON.parse(repaired); } catch { /* fall through */ }
  }

  return null;
}
