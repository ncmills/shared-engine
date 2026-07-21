import type { QAGenerate, QAResult, QAConfig } from "./types";

export type { QAGenerate, QAResult, QAConfig };

/**
 * Brand-INVARIANT Q&A system prompt. The hardened bans (answer-only-from-data, no weather/forecast,
 * exact-price-no-estimates, no-mutation, plain-text) are shared. Brand slots: the trip noun and any
 * `extraGuardrails` (e.g. HHQ's Day-1/Day-2 labeling ban).
 */
export function buildQASystemPrompt<TStored, TPlan>(config: QAConfig<TStored, TPlan>): string {
  return [
    `You answer a guest's question about ONE specific, already-planned ${config.tripNoun}. You are a`,
    "helpful concierge for THIS trip only.",
    "",
    "Rules — follow exactly:",
    "1. Answer ONLY using the TRIP DATA provided. Every fact (venue, price, time, address, activity) must",
    "   come from that data verbatim. NEVER invent, guess, or add venues, prices, or details not present.",
    "2. If the answer isn't in the TRIP DATA, say so plainly (e.g. \"That's not spelled out in this plan\")",
    "   and, if useful, say where they'd find it or that the organizer can adjust the trip. Do NOT support",
    "   that by citing a pro tip, venue, or plan detail that isn't actually in the TRIP DATA — invent nothing.",
    "   NEVER describe weather, temperatures, or a forecast — that is never in the plan; say you don't have it.",
    "3. Do NOT change the trip. If asked to modify it (different city, drop a night, swap a venue), say you",
    "   can only answer questions — the organizer can use the “Tell us what to change” box (or Swap on a",
    "   stop) to edit it.",
    "4. PRICES/money: quote the EXACT figure from the TRIP DATA verbatim — never round, average, alter,",
    "   or invent a price. Use the per-item price when it's in the data (e.g. a dinner's cost); if a",
    "   specific price isn't there, say so — do not guess. Do NOT volunteer ballpark estimates or generic",
    "   advice not in the data (typical ride costs, what a guide might suggest). Be concise, warm, specific.",
    "5. Plain text only, no markdown headers. A few sentences at most.",
    ...(config.extraGuardrails ?? []),
  ].join("\n");
}

export async function answerTripQuestion<TStored, TPlan>(
  plan: TPlan,
  question: string,
  opts: { generate: QAGenerate; config: QAConfig<TStored, TPlan>; timing?: string },
): Promise<QAResult> {
  const raw = await opts.generate({
    system: opts.config.systemPrompt ?? buildQASystemPrompt(opts.config),
    prompt: ["TRIP DATA:", opts.config.serializePlan(plan, opts.timing), "", "QUESTION:", question.trim(), "", "Answer from the TRIP DATA only:"].join("\n"),
  });
  const answer = (raw ?? "").trim();
  // NOTE: this fallback string is intentionally INVARIANT, not brand-configurable — verified
  // byte-identical across MOH/BMHQ/HHQ 2026-07-21. Do not add a config slot for it.
  return { answer: answer || "Sorry — I couldn't find that in this plan. Try rephrasing, or the organizer can adjust the trip." };
}
