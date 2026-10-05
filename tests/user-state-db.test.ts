import { describe, expect, it } from "vitest";
import { USER_STATE_RETENTION_MS } from "../packages/shared/constants.ts";
import { UserStateDb, userStateName } from "../workers/edge/stores/user-state-db.ts";
import { memorySql } from "./support/memory-sql.ts";

const thread = "00000000-0000-7000-8000-000000000001";
const reply = "00000000-0000-7000-8000-000000000002";

function db() {
  const store = new UserStateDb(memorySql());
  store.init();
  return store;
}

describe("user state", () => {
  it("dedupes likes and reports the first like in a thread", () => {
    const store = db();
    expect(store.like({ userId: "u1", postId: thread, threadId: thread, on: true, now: 1 })).toMatchObject({ changed: true, first: true });
    expect(store.like({ userId: "u1", postId: thread, threadId: thread, on: true, now: 2 })).toMatchObject({ changed: false, first: false });
    expect(store.like({ userId: "u1", postId: reply, threadId: thread, on: true, now: 3 })).toMatchObject({ changed: true, first: false });
    expect(store.like({ userId: "u1", postId: thread, threadId: thread, on: false, now: 4 })).toMatchObject({ changed: true, first: false });
    expect(store.like({ userId: "u1", postId: thread, threadId: thread, on: false, now: 5 })).toMatchObject({ changed: false, first: false });
    expect(store.like({ userId: "u1", postId: thread, threadId: thread, on: true, now: 6 })).toMatchObject({ changed: true, first: false });
  });

  it("allows one repost per user per thread", () => {
    const store = db();
    expect(store.repost({ userId: "u1", threadId: thread, now: 1, location: "8b195da49b48fff", partition: "p", byAuthor: "aaaa0001" })).toEqual({ ok: true, first: true });
    expect(store.repost({ userId: "u1", threadId: thread, now: 2, location: "8b195da49b48fff", partition: "p", byAuthor: "aaaa0001" })).toEqual({ ok: false, first: false });
    expect(store.repost({ userId: "u2", threadId: thread, now: 2, location: "8b195da49b48fff", partition: "p", byAuthor: "aaaa0002" })).toEqual({ ok: true, first: true });
  });

  it("reports a user's engagement for the requested threads only", () => {
    const store = db();
    store.like({ userId: "u1", postId: reply, threadId: thread, on: true, now: 1 });
    store.repost({ userId: "u1", threadId: thread, now: 1, location: "8b195da49b48fff", partition: "p", byAuthor: "aaaa0001" });
    store.like({ userId: "u2", postId: thread, threadId: thread, on: true, now: 1 });
    expect(store.engagement("u1", [thread])).toEqual({ liked: [reply], reposted: [thread] });
    expect(store.engagement("u1", [])).toEqual({ liked: [], reposted: [] });
    expect(store.engagement("u1", ["00000000-0000-7000-8000-000000000009"])).toEqual({ liked: [], reposted: [] });
  });

  it("sweeps rows older than the retention window", () => {
    const store = db();
    store.like({ userId: "u1", postId: thread, threadId: thread, on: true, now: 0 });
    expect(store.isEmpty()).toBe(false);
    store.sweep(USER_STATE_RETENTION_MS + 1);
    expect(store.engagement("u1", [thread])).toEqual({ liked: [], reposted: [] });
    // Not empty while the like's event is still waiting to be sent.
    expect(store.isEmpty()).toBe(false);
    store.ackEvents(store.pendingEvents(100).map((event) => event.eventId));
    expect(store.isEmpty()).toBe(true);
  });

  it("buckets users into 65,536 deterministic names", async () => {
    const name = await userStateName("user-1");
    expect(name).toMatch(/^u:[0-9a-f]{4}$/u);
    expect(await userStateName("user-1")).toBe(name);
  });

  it("reports which thread an unlike belongs to, whatever thread the client names", () => {
    const store = db();
    const other = "00000000-0000-7000-8000-0000000000aa";
    store.like({ userId: "u1", postId: reply, threadId: thread, on: true, now: 1 });
    expect(store.like({ userId: "u1", postId: reply, threadId: other, on: false, now: 2 }))
      .toEqual({ changed: true, first: false, threadId: thread });
  });

  it("refuses a like that names a different thread than the one already recorded", () => {
    const store = db();
    const other = "00000000-0000-7000-8000-0000000000aa";
    store.like({ userId: "u1", postId: reply, threadId: thread, on: true, now: 1 });
    store.like({ userId: "u1", postId: reply, threadId: thread, on: false, now: 2 });
    expect(store.like({ userId: "u1", postId: reply, threadId: other, on: true, now: 3 }).changed).toBe(true);
  });

  it("queues each like change for the thread it is recorded under", () => {
    const store = db();
    store.like({ userId: "u1", postId: reply, threadId: thread, on: true, now: 1 });
    store.like({ userId: "u1", postId: reply, threadId: "00000000-0000-7000-8000-0000000000aa", on: false, now: 2 });
    store.like({ userId: "u1", postId: reply, threadId: thread, on: false, now: 3 });
    expect(store.pendingEvents(100)).toMatchObject([
      { type: "thread.liked", threadId: thread, postId: reply, userId: "u1", delta: 1, first: true, at: 1 },
      { type: "thread.liked", threadId: thread, postId: reply, userId: "u1", delta: -1, first: false, at: 2 },
    ]);
    store.ackEvents(store.pendingEvents(100).map((event) => event.eventId));
    expect(store.pendingEvents(100)).toEqual([]);
  });

  it("queues a repost with its anchor", () => {
    const store = db();
    store.repost({ userId: "u1", threadId: thread, now: 5, location: "8b195da49b48fff", partition: "p", byAuthor: "aaaa0001" });
    store.repost({ userId: "u1", threadId: thread, now: 6, location: "8b195da49b48fff", partition: "p", byAuthor: "aaaa0001" });
    expect(store.pendingEvents(100)).toMatchObject([
      { type: "thread.reposted", threadId: thread, userId: "u1", first: true, location: "8b195da49b48fff", partition: "p", byAuthor: "aaaa0001", at: 5 },
    ]);
  });
});
