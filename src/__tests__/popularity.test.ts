// src/__tests__/popularity.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  getAllPopularityScores,
  popularityBonus,
  recordDestinationView,
  type RedisLike,
} from "../popularity";

function fakeRedis(
  views: Record<string, number>,
  selects: Record<string, number>,
  opts?: { cache?: string | null }
): RedisLike {
  const cacheStore: { value: string | null } = { value: opts?.cache ?? null };
  return {
    async hincrby() { return 1; },
    async hget(key) {
      const id = key.replace(/^signal:(views|selects):/, "");
      const src = key.startsWith("signal:selects:") ? selects : views;
      return src[id] != null ? String(src[id]) : null;
    },
    async scan(_c, ..._a) { return ["0", Object.keys(views).map((id) => `signal:views:${id}`)]; },
    async expire() { return 1; },
    async get(key) { return key === "popularity:cache" ? cacheStore.value : null; },
    async set(key, value) {
      cacheStore.value = value;
      return "OK";
    },
    async mget() { return []; },
  };
}

describe("popularity", () => {
  it("computes select/view ratio scores", async () => {
    const r = fakeRedis({ austin: 100 }, { austin: 25 });
    const { scores } = await getAllPopularityScores(r);
    expect(scores.get("austin")).toBeGreaterThan(0);
  });
  it("caps the ranking bonus", () => {
    const scores = new Map([["austin", 999]]);
    expect(popularityBonus(scores, "austin", 10)).toBeLessThanOrEqual(10);
    expect(popularityBonus(scores, "unknown", 10)).toBe(0);
  });

  it("recordDestinationView increments total, region:*, and budget:* sub-counters", async () => {
    const calls: [string, string, number][] = [];
    const r: RedisLike = {
      async hincrby(key, field, n) {
        calls.push([key, field, n]);
        return 1;
      },
      async hget() { return null; },
      async scan() { return ["0", []]; },
      async expire() { return 1; },
      async get() { return null; },
      async set() { return "OK"; },
      async mget() { return []; },
    };
    await recordDestinationView(r, "austin", { region: "south", budget: "mid" });
    expect(calls).toContainEqual(["signal:views:austin", "total", 1]);
    expect(calls).toContainEqual(["signal:views:austin", "region:south", 1]);
    expect(calls).toContainEqual(["signal:views:austin", "budget:mid", 1]);
  });

  it("getAllPopularityScores returns the cached array without scanning on a cache hit", async () => {
    const cached = JSON.stringify([{ destId: "austin", score: 0.25, views: 100 }]);
    const r = fakeRedis({}, {}, { cache: cached });
    const scanSpy = vi.spyOn(r, "scan");
    const { scores, viewCounts } = await getAllPopularityScores(r);
    expect(scores.get("austin")).toBe(0.25);
    expect(viewCounts.get("austin")).toBe(100);
    expect(scanSpy).not.toHaveBeenCalled();
  });

  it("getAllPopularityScores computes selects/views and writes the cache on a cache miss", async () => {
    const r = fakeRedis({ austin: 100 }, { austin: 25 });
    const setSpy = vi.spyOn(r, "set");
    const { scores } = await getAllPopularityScores(r);
    expect(scores.get("austin")).toBe(0.25);
    // Cache write is fire-and-forget (.catch(() => {})) — flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    expect(setSpy).toHaveBeenCalledWith(
      "popularity:cache",
      expect.stringContaining("austin"),
      "EX",
      300
    );
  });
});
