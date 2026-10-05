import { describe, expect, it } from "vitest";
import { latLngToCanonicalLocation, locationToScopeCell, regionCells } from "../packages/geo/index.ts";
import { uuidv7 } from "../packages/shared/uuid.ts";
import { consumeEvents } from "../workers/edge/queue/consumer.ts";
import type { FeedEvent } from "../workers/edge/events.ts";
import { createFakeServices } from "./support/fake-services.ts";

const location = latLngToCanonicalLocation(51.5074, -0.1278);
const T = 1_000_000;

describe("queue consumer", () => {
  it("routes thread events to thread stores and cell events to cell indexes", async () => {
    const fake = createFakeServices();
    const id = uuidv7(T);
    await fake.services.thread(id).create({
      id, actor: { userId: "u1", author: "aaaa0001" }, roomTag: "", location, partition: "p", body: "hi", now: T,
    });
    expect(fake.queue.map((event) => event.type)).toEqual(["ref.added"]);

    await fake.services.sendEvents([
      { eventId: "l1", type: "thread.liked", threadId: id, postId: id, userId: "u2", delta: 1, first: true, at: T + 1 },
      { eventId: "l2", type: "thread.liked", threadId: id, postId: id, userId: "u3", delta: 1, first: true, at: T + 2 },
    ]);
    await fake.drain(T + 3);
    expect(fake.queue).toEqual([]);

    const summary = await fake.services.thread(id).summary(T + 3);
    expect(summary).toMatchObject({ ok: true, summary: { likeCount: 2, participantCount: 3 } });

    const cells = regionCells(locationToScopeCell(location, 10));
    const page = await fake.services.cell("p").query("p", { cells, scope: 10, room: "", tab: "trending", cursor: null, limit: 60, now: T + 3 });
    expect(page.refs).toHaveLength(1);
    expect(page.refs[0]).toMatchObject({ threadId: id, participantCount: 3 });
  });

  it("reports only the events whose target failed, and still applies the rest", async () => {
    const fake = createFakeServices();
    const healthy = uuidv7(T);
    const broken = uuidv7(T + 1);
    for (const id of [healthy, broken]) {
      await fake.services.thread(id).create({ id, actor: { userId: "u1", author: "aaaa0001" }, roomTag: "", location, partition: "p", body: "hi", now: T });
    }
    await fake.drain(T);
    const services = {
      ...fake.services,
      thread: (id: string) => id === broken
        ? { ...fake.services.thread(id), applyLikes: async () => { throw new Error("store down"); } }
        : fake.services.thread(id),
    };
    const events: FeedEvent[] = [healthy, broken].map((threadId, i) => ({
      eventId: `e${i}`, type: "thread.liked", threadId, postId: threadId, userId: "u2", delta: 1, first: true, at: T + 1,
    }));
    const failed = await consumeEvents(events, services, T + 1);
    expect(failed.map((event) => event.eventId)).toEqual(["e1"]);
    expect(await fake.services.thread(healthy).summary(T + 1)).toMatchObject({ ok: true, summary: { likeCount: 1 } });
  });
});
