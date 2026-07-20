import type { ConciergeTenant } from "./types";

/** Guest-facing host per concierge tenant. OO/'tdf' are not concierge tenants (unrepresentable). */
export const LODGING_HOST: Record<ConciergeTenant, string> = {
  moh: "maidofhonorhq.com",
  bestman: "bestmanhq.com",
  handicaphq: "handicaphq.com",
};

export interface LodgingDeeplinkArgs {
  tenant: ConciergeTenant;
  railSlotId: string;
  checkIn?: string;
  checkOut?: string;
  partySize?: number;
}

/** Pure, deterministic, PII-free deep link to a tenant's lodging listing. Never embeds lead
 *  name/email — this URL is shareable in a group chat. Query params are emitted in sorted order so
 *  the same args always produce the same string (cache/idempotency friendly). */
export function buildLodgingDeeplink(args: LodgingDeeplinkArgs): string {
  if (!args.railSlotId) {
    throw new Error("buildLodgingDeeplink: empty railSlotId — refusing to build a link to nothing");
  }
  const base = `https://${LODGING_HOST[args.tenant]}/stay/${encodeURIComponent(args.railSlotId)}`;
  const params: [string, string][] = [];
  if (args.checkIn) params.push(["checkIn", args.checkIn]);
  if (args.checkOut) params.push(["checkOut", args.checkOut]);
  if (args.partySize != null) params.push(["partySize", String(args.partySize)]);
  if (params.length === 0) return base;
  const qs = params
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `${base}?${qs}`;
}
