export type BrandId = 'bestman' | 'moh';

export type BudgetTier =
  | 'under-500'
  | '500-1000'
  | '1000-1500'
  | '1500-2000'
  | '2000-plus'
  | 'no-limit';

export type ActivityIntensityBestman = 'chill' | 'moderate' | 'send-it';
export type ActivityIntensityMoh = 'chill' | 'balanced' | 'unhinged';
export type ActivityIntensity = ActivityIntensityBestman | ActivityIntensityMoh;

export type ConsultedLevel = 'yes' | 'sort-of' | 'not-yet';

export interface PriceTargets {
  weekendWarrior: string;
  theLegend: string;
  theKing: string;
}

export interface PricingLodging {
  pricePerNight: readonly [number, number];
  perRoom?: boolean;
}

export interface PricingPriceBand {
  priceRange: string;
}

export interface PricingActivity {
  pricePerPerson: readonly [number, number];
}

export interface PricingTransport {
  type: string;
  priceRange: string;
}

export interface PricingDestination {
  lodging: readonly PricingLodging[];
  nightlife: readonly PricingPriceBand[];
  dining: readonly PricingPriceBand[];
  activities: readonly PricingActivity[];
  transport: readonly PricingTransport[];
}

export interface BrandEventProps {
  brand: BrandId;
  city?: string;
  budgetBand?: string;
  groupSizeBand?: string;
  source?: string;
  planId?: string;
  step?: string;
  [key: string]: unknown;
}
