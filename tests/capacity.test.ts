import { describe, expect, it } from "vitest";
import { evaluateUsage, nextUtcMidnight } from "../workers/edge/capacity.ts";

const NOW = Date.UTC(2026, 9, 7, 15, 30);

describe("capacity", () => {
  it("stays open below 90% of every free allowance", () => {
    expect(evaluateUsage({ workers: 89_999, durableObjects: 50_000, queues: 8_999 }, NOW)).toMatchObject({ paused: false });
  });

  it("pauses until the next UTC midnight when any allowance reaches 90%", () => {
    expect(evaluateUsage({ workers: 1_000, durableObjects: 1_000, queues: 9_000 }, NOW))
      .toMatchObject({ paused: true, reason: "queues", resumesAt: Date.UTC(2026, 9, 8) });
  });

  it("finds the next midnight across month ends", () => {
    expect(nextUtcMidnight(Date.UTC(2026, 9, 31, 23, 59))).toBe(Date.UTC(2026, 10, 1));
  });
});
