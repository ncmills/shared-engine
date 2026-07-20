export interface PriceDriftOpts {
  /** Absolute upward drift allowed, in cents. Default 0. */
  toleranceCents?: number;
  /** Upward drift allowed as a fraction of the quoted price (e.g. 0.02 = 2%). Default 0. */
  toleranceFraction?: number;
}

/** The §11 money-safety primitive. Compares the price QUOTED at search against the price LOCKED at
 *  prebook. Returns an error string when the locked price exceeds quoted beyond tolerance (we must not
 *  silently pay more than we showed), else null. Cheaper-than-quoted is always fine. Fails loud on any
 *  non-finite/negative input rather than passing — a missing price must never read as "no drift".
 *
 *  NOTE: 2b ships this primitive; wiring it into `executeStaged`'s cap gate (so the cap validates the
 *  locked price, not the quote) is deferred to 2c/live per the 2a review. */
export function checkPriceDrift(quotedCents: number, lockedCents: number, opts?: PriceDriftOpts): string | null {
  if (!Number.isFinite(quotedCents) || !Number.isFinite(lockedCents) || quotedCents < 0 || lockedCents < 0) {
    return `price-drift check received non-finite/negative amounts (quoted=${quotedCents}, locked=${lockedCents})`;
  }
  const absTol = Math.max(0, opts?.toleranceCents ?? 0);
  const fracTol = Math.ceil(quotedCents * Math.max(0, opts?.toleranceFraction ?? 0));
  const tolerance = Math.max(absTol, fracTol);
  if (lockedCents > quotedCents + tolerance) {
    return `locked price ${lockedCents} exceeds quoted ${quotedCents} beyond tolerance ${tolerance}`;
  }
  return null;
}
