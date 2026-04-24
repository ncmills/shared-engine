/**
 * Brand-agnostic hook that tracks who's viewing a trip room via Supabase
 * Realtime Presence. Consumers render a FigJam-style avatar row from the
 * returned list.
 *
 * Call shape:
 *   const { presence } = usePresence(planId, { email, name });
 *
 * - First entry appears within ~500ms of the socket connect.
 * - Presence v2 handles heartbeats + stale pruning on the server; we do
 *   not run our own 25s/60s timers. Clients drop from the list within
 *   ~30s of tab close (Phoenix channel timeout).
 * - Passing a null planId or empty email no-ops the hook — safe to call
 *   inside components that may render before auth resolves.
 * - If NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are
 *   absent, the hook returns an empty presence list silently.
 */

"use client";

import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { useEffect, useState } from "react";

export interface PresenceUser {
  userId: string;
  email: string;
  name?: string;
  joinedAt: string;
  lastSeenAt: string;
}

export interface UsePresenceIdentity {
  email: string;
  name?: string;
}

export interface UsePresenceResult {
  presence: PresenceUser[];
}

interface PresenceMeta {
  email: string;
  name?: string;
  joinedAt: string;
  lastSeenAt: string;
}

let cachedClient: SupabaseClient | null | undefined;

function getBrowserClient(): SupabaseClient | null {
  if (typeof window === "undefined") return null;
  if (cachedClient !== undefined) return cachedClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  cachedClient = url && key
    ? createClient(url, key, { auth: { persistSession: false } })
    : null;
  return cachedClient;
}

export function usePresence(
  planId: string | null | undefined,
  me: UsePresenceIdentity | null | undefined
): UsePresenceResult {
  const [presence, setPresence] = useState<PresenceUser[]>([]);

  const email = me?.email ?? "";
  const name = me?.name ?? "";

  useEffect(() => {
    if (!planId || !email) {
      setPresence([]);
      return;
    }
    const sb = getBrowserClient();
    if (!sb) return;

    const joinedAt = new Date().toISOString();
    const channel: RealtimeChannel = sb.channel(
      `trip-room-presence-${planId}`,
      { config: { presence: { key: email } } }
    );

    function projectState() {
      const state = channel.presenceState() as Record<string, PresenceMeta[]>;
      const users: PresenceUser[] = [];
      for (const [userId, metas] of Object.entries(state)) {
        const meta = metas[metas.length - 1];
        if (!meta) continue;
        users.push({
          userId,
          email: meta.email,
          name: meta.name,
          joinedAt: meta.joinedAt,
          lastSeenAt: meta.lastSeenAt,
        });
      }
      setPresence(users);
    }

    channel
      .on("presence", { event: "sync" }, projectState)
      .on("presence", { event: "join" }, projectState)
      .on("presence", { event: "leave" }, projectState)
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({
            email,
            name: name || undefined,
            joinedAt,
            lastSeenAt: joinedAt,
          } satisfies PresenceMeta);
        }
      });

    return () => {
      try { void channel.untrack(); } catch { /* ignore — socket may already be closed */ }
      void sb.removeChannel(channel);
    };
  }, [planId, email, name]);

  return { presence };
}
