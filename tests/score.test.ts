import { describe, expect, it } from "vitest";
import { addEngagement, decayedScore, replyEngagement, trendKey } from "../packages/feed/score.ts";
import { TREND_HALF_LIFE_MS } from "../packages/shared/constants.ts";

describe("trending score", () => {
  it("weights engagements with the X-derived ratios", () => {
    const start = { value: 0, at: 0 };
    expect(addEngagement(start, "like", 0).value).toBe(1);
    expect(addEngagement(start, "repost", 0).value).toBe(2);
    expect(addEngagement(start, "reply", 0).value).toBe(27);
    expect(addEngagement(start, "author_reply", 0).value).toBe(150);
  });

  it("halves every half-life", () => {
    expect(decayedScore({ value: 8, at: 0 }, TREND_HALF_LIFE_MS)).toBeCloseTo(4);
    expect(decayedScore({ value: 8, at: 0 }, 2 * TREND_HALF_LIFE_MS)).toBeCloseTo(2);
  });

  it("never grows when read before its timestamp", () => {
    expect(decayedScore({ value: 8, at: 1_000 }, 0)).toBe(8);
  });

  it("decays before adding", () => {
    const later = addEngagement({ value: 10, at: 0 }, "like", TREND_HALF_LIFE_MS);
    expect(later.value).toBeCloseTo(6);
    expect(later.at).toBe(TREND_HALF_LIFE_MS);
  });

  it("orders by trend key exactly as by decayed value at any instant", () => {
    const older = { value: 100, at: 0 };
    const newer = { value: 30, at: 2 * TREND_HALF_LIFE_MS };
    for (const now of [3 * TREND_HALF_LIFE_MS, 10 * TREND_HALF_LIFE_MS, 40 * TREND_HALF_LIFE_MS]) {
      const byValue = Math.sign(decayedScore(older, now) - decayedScore(newer, now));
      const byKey = Math.sign(trendKey(older) - trendKey(newer));
      expect(byKey).toBe(byValue);
    }
    expect(trendKey({ value: 0, at: 5 })).toBe(-1e9);
  });

  it("scores author replies only after someone else replied", () => {
    expect(replyEngagement(false, false)).toBe("reply");
    expect(replyEngagement(false, true)).toBe("reply");
    expect(replyEngagement(true, false)).toBeNull();
    expect(replyEngagement(true, true)).toBe("author_reply");
  });
});
