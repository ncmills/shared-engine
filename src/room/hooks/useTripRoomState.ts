/**
 * Brand-agnostic hook that owns the /api/room/state lifecycle for a plan.
 *
 * Call shape:
 *   const { state, refresh } = useTripRoomState(planId, { pollMs: 5000 });
 *
 * - First refresh fires immediately after mount.
 * - Subsequent refreshes fire on the polling interval (default 5s). Pass
 *   `pollMs: 0` to disable polling for test environments.
 * - `refresh()` is a stable callback the caller can invoke after a
 *   mutation to pull the latest collaborative state.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TripRoomState } from "../types";
import { roomApi } from "./api";

export interface UseTripRoomStateOptions {
  /** Poll cadence in milliseconds. `0` disables polling. Default 5000. */
  pollMs?: number;
}

export interface UseTripRoomStateResult {
  state: TripRoomState | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function useTripRoomState(
  planId: string,
  opts: UseTripRoomStateOptions = {}
): UseTripRoomStateResult {
  const { pollMs = 5000 } = opts;
  const [state, setState] = useState<TripRoomState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const timerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await roomApi.fetchState(planId);
      setState(next);
    } catch {
      // polling is best-effort — swallow errors, we'll retry next tick
    } finally {
      setIsLoading(false);
    }
  }, [planId]);

  useEffect(() => {
    refresh();
    if (pollMs > 0) {
      timerRef.current = window.setInterval(refresh, pollMs);
      return () => {
        if (timerRef.current) window.clearInterval(timerRef.current);
      };
    }
  }, [refresh, pollMs]);

  return { state, isLoading, refresh };
}
