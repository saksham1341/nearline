import { describe, expect, it } from "vitest";
import { flushOutbox } from "../workers/edge/durable-objects/flush.ts";
import type { FeedEvent } from "../workers/edge/events.ts";

function source(count: number) {
  const pending: FeedEvent[] = Array.from({ length: count }, (_, i) => ({
    eventId: `e${i}`, type: "thread.expired", partition: "p", threadId: "t", at: i,
  }));
  return {
    pending,
    pendingEvents: (limit: number) => pending.slice(0, limit),
    ackEvents: (ids: readonly string[]) => {
      for (const id of ids) pending.splice(pending.findIndex((event) => event.eventId === id), 1);
    },
  };
}

describe("outbox flushing", () => {
  it("sends in batches the queue accepts and acknowledges each one", async () => {
    const outbox = source(250);
    const sizes: number[] = [];
    const queue = { sendBatch: async (messages: unknown[]) => { if (messages.length > 100) throw new Error("too many"); sizes.push(messages.length); } };
    expect(await flushOutbox(outbox, queue as never)).toBe(true);
    expect(sizes).toEqual([100, 100, 50]);
    expect(outbox.pending).toEqual([]);
  });

  it("keeps everything not yet sent when the queue fails", async () => {
    const outbox = source(150);
    let calls = 0;
    const queue = { sendBatch: async () => { calls += 1; if (calls === 2) throw new Error("queue down"); } };
    expect(await flushOutbox(outbox, queue as never)).toBe(false);
    expect(outbox.pending).toHaveLength(50);
  });
});
