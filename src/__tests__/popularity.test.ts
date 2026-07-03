// src/__tests__/popularity.test.ts
import { describe, it, expect } from "vitest";
import { getAllPopularityScores, popularityBonus, type RedisLike } from "../popularity";

function fakeRedis(views: Record<string, number>, selects: Record<string, number>): RedisLike {
  return {
    async hincrby() { return 1; },
    async hget(key) {
      const id = key.replace(/^signal:(views|selects):/, "");
      const src = key.startsWith("signal:selects:") ? selects : views;
      return src[id] != null ? String(src[id]) : null;
    },
    async scan(_c, ..._a) { return ["0", Object.keys(views).map((id) => `signal:views:${id}`)]; },
    async expire() { return 1; },
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
});
