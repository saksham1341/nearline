import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextDelay, Poller } from "../apps/web/poller.ts";
import { POLL_BACKOFF_AFTER_MS, POLL_FEED_MS, POLL_MAX_MS } from "../packages/shared/constants.ts";

describe("polling", () => {
  it("backs off only after a minute without change, up to the cap", () => {
    expect(nextDelay(POLL_FEED_MS, POLL_FEED_MS, POLL_BACKOFF_AFTER_MS - 1)).toBe(POLL_FEED_MS);
    expect(nextDelay(POLL_FEED_MS, POLL_FEED_MS, POLL_BACKOFF_AFTER_MS)).toBe(POLL_FEED_MS * 2);
    expect(nextDelay(POLL_FEED_MS, 20_000, POLL_BACKOFF_AFTER_MS)).toBe(POLL_MAX_MS);
  });

  describe("Poller", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("polls immediately, repeats, and stops", async () => {
      const task = vi.fn(async () => true);
      const poller = new Poller(1_000, task, () => Date.now());
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(task).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(task).toHaveBeenCalledTimes(2);
      poller.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(task).toHaveBeenCalledTimes(2);
    });

    it("runs at once when poked", async () => {
      const task = vi.fn(async () => false);
      const poller = new Poller(10_000, task, () => Date.now());
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      poller.poke();
      await vi.advanceTimersByTimeAsync(0);
      expect(task).toHaveBeenCalledTimes(2);
      poller.stop();
    });
  });
});
