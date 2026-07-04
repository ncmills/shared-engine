"use client";

/**
 * Leadgen A3 — first-pageview acquisition beacon.
 *
 * Fires `logAcquisition` once per browser session (guarded by a sessionStorage
 * flag) with the referrer, any UTM params, a coarse device class, and the
 * landing path. Fire-and-forget: never blocks or throws. Mounted high in the
 * tree (root layout) so it runs on every entry point.
 *
 * Ported from ~/handicap-hq/src/components/AcquisitionBeacon.tsx — the brand
 * was hardcoded there ("tdf"); here it's a prop so every brand can share this
 * one component. The `ACQ_SENT_KEY` sessionStorage guard and the
 * `logAcquisition` payload shape (`{ ref, utm, device, landing }`) are kept
 * byte-identical to HHQ's for fidelity.
 */

import { useEffect } from "react";
import { logAcquisition, type Brand } from "./signals";

const ACQ_SENT_KEY = "wp_acq_sent";

const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;

export interface ParsedAcquisition {
  source: string;
  medium?: string;
  campaign?: string;
  device: "mobile" | "desktop";
  /**
   * Extended beyond the brief's minimal signature so the component can build
   * HHQ's exact `logAcquisition` payload shape (`{ ref, utm, device, ... }`)
   * from this helper's output rather than re-deriving it inline. `source`/
   * `medium`/`campaign` are the derived/testable fields; `ref`/`utm` are the
   * raw values HHQ's original component logged verbatim.
   */
  ref?: string;
  utm?: Record<string, string>;
}

/**
 * Pure extraction of acquisition signal from the current pageview's search
 * params, referrer, and user agent. utm_* params win over the referrer host
 * for `source`/`medium`/`campaign`. No DOM access — safe to unit test.
 */
export function parseAcquisition(
  searchParams: URLSearchParams,
  referrer: string,
  ua: string
): ParsedAcquisition {
  const utm: Record<string, string> = {};
  for (const k of UTM_KEYS) {
    const v = searchParams.get(k);
    if (v) utm[k] = v;
  }

  const device: "mobile" | "desktop" = /Mobi|Android|iPhone|iPad|iPod/i.test(ua) ? "mobile" : "desktop";

  let source = utm.utm_source;
  if (!source && referrer) {
    try {
      source = new URL(referrer).hostname;
    } catch {
      source = referrer;
    }
  }

  return {
    source: source ?? "",
    medium: utm.utm_medium,
    campaign: utm.utm_campaign,
    device,
    ref: referrer || undefined,
    utm: Object.keys(utm).length ? utm : undefined,
  };
}

export function AcquisitionBeacon({ brand }: { brand: Brand }) {
  useEffect(() => {
    try {
      if (typeof window === "undefined") return;
      if (sessionStorage.getItem(ACQ_SENT_KEY)) return;
      sessionStorage.setItem(ACQ_SENT_KEY, "1");

      const parsed = parseAcquisition(
        new URLSearchParams(window.location.search),
        document.referrer,
        navigator.userAgent || ""
      );

      logAcquisition(brand, {
        ref: parsed.ref,
        utm: parsed.utm,
        device: parsed.device,
        landing: window.location.pathname,
      });
    } catch {
      // Never break the app for an analytics beacon.
    }
  }, []);

  return null;
}
