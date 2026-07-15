import type { BookingCategory, CurrencyCode, ConciergeTenant } from "./types";

export type { ConciergeTenant } from "./types";

export interface ConciergeTenantConfig {
  tenant: ConciergeTenant;
  tripNoun: string;
  categories: BookingCategory[];
  /** category -> rail id used for this tenant */
  railConfig: Partial<Record<BookingCategory, string>>;
  feeAmountCents: number;
  currency: CurrencyCode;
  tosRef: string;
}

const CONFIGS: Record<ConciergeTenant, ConciergeTenantConfig> = {
  moh: {
    tenant: "moh",
    tripNoun: "bachelorette trip",
    categories: ["lodging", "activity", "dining"],
    railConfig: { lodging: "liteapi", activity: "getyourguide", dining: "opentable" },
    feeAmountCents: 7900,
    currency: "USD",
    tosRef: "moh-concierge-tos-v1",
  },
  bestman: {
    tenant: "bestman",
    tripNoun: "bachelor party",
    categories: ["lodging", "activity", "dining"],
    railConfig: { lodging: "liteapi", activity: "getyourguide", dining: "opentable" },
    feeAmountCents: 7900,
    currency: "USD",
    tosRef: "bestman-concierge-tos-v1",
  },
  handicaphq: {
    tenant: "handicaphq",
    tripNoun: "golf trip",
    categories: ["lodging", "activity", "dining", "golf"],
    railConfig: { lodging: "liteapi", activity: "getyourguide", dining: "opentable" },
    feeAmountCents: 9900,
    currency: "USD",
    tosRef: "handicaphq-concierge-tos-v1",
  },
};

export function getConciergeTenantConfig(tenant: ConciergeTenant): ConciergeTenantConfig {
  const cfg = CONFIGS[tenant];
  if (!cfg) throw new Error(`Unknown concierge tenant: ${tenant}`);
  return cfg;
}
