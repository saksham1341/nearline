import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { latLngToCanonicalLocation } from "../packages/geo/index.ts";
import { THREAD_TTL_MS } from "../packages/shared/constants.ts";
import { uuidv7 } from "../packages/shared/uuid.ts";
import { OUTBOX_RETRY_MS } from "../workers/edge/durable-objects/flush.ts";
import { ThreadStore } from "../workers/edge/durable-objects/thread-store.ts";
import { UserState } from "../workers/edge/durable-objects/user-state.ts";
import { fakeQueue, fakeStorage } from "./support/fake-cloudflare.ts";

const T = 1_700_000_000_000;
const location = latLngToCanonicalLocation(51.5074, -0.1278);
const actor = { userId: "user-1", author: "aaaa0001" };

function threadStore() {
  const storage = fakeStorage();
  const queue = fakeQueue();
  const store = new ThreadStore({ storage } as never, { FEED_EVENTS: queue } as never);
  return { storage, queue, store };
}

describe("ThreadStore Durable Object", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T); });
  afterEach(() => { vi.useRealTimers(); });

  it("sends the new thread's ref and wakes at its expiry", async () => {
    const { storage, queue, store } = threadStore();
    const id = uuidv7(T);
    const outcome = await store.create({ id, actor, roomTag: "", location, partition: "p", body: "hi", now: T });
    expect(outcome).toMatchObject({ ok: true });
    expect(queue.sent.map((event) => event.type)).toEqual(["ref.added"]);
    expect(storage.alarm).toBe(T + THREAD_TTL_MS);
  });

  it("keeps the post and retries its events when the queue is down", async () => {
    const { storage, queue, store } = threadStore();
    queue.fail(true);
    const id = uuidv7(T);
    expect(await store.create({ id, actor, roomTag: "", location, partition: "p", body: "hi", now: T })).toMatchObject({ ok: true });
    expect(queue.sent).toEqual([]);
    expect(storage.alarm).toBe(T + OUTBOX_RETRY_MS);
    queue.fail(false);
    await store.alarm();
    expect(queue.sent.map((event) => event.type)).toEqual(["ref.added"]);
    expect(storage.alarm).toBe(T + THREAD_TTL_MS);
  });

  it("stores nothing for an id that was only looked up", async () => {
    const { storage, store } = threadStore();
    expect(await store.summary(T)).toEqual({ ok: false, code: "THREAD_NOT_FOUND" });
    expect(await store.remove({ postId: uuidv7(T), actor, now: T })).toEqual({ ok: false, code: "THREAD_NOT_FOUND" });
    expect(storage.tables()).toEqual([]);
    expect(storage.alarm).toBeNull();
  });

  it("deletes all of its storage once it has expired and said so", async () => {
    const { storage, queue, store } = threadStore();
    const id = uuidv7(T);
    await store.create({ id, actor, roomTag: "", location, partition: "p", body: "hi", now: T });
    vi.setSystemTime(T + THREAD_TTL_MS);
    await store.alarm();
    expect(queue.sent.map((event) => event.type)).toEqual(["ref.added", "thread.expired"]);
    expect(storage.deletions).toBe(1);
    expect(storage.tables()).toEqual([]);
    expect(await store.summary(T + THREAD_TTL_MS)).toEqual({ ok: false, code: "THREAD_NOT_FOUND" });
  });

  it("prunes a quiet branch from its alarm", async () => {
    const { store } = threadStore();
    const id = uuidv7(T);
    await store.create({ id, actor, roomTag: "", location, partition: "p", body: "hi", now: T });
    const quiet = await store.reply({ postId: uuidv7(T), parentId: id, actor, body: "quiet", now: T });
    vi.setSystemTime(T + 10 * 60_000);
    await store.reply({ postId: uuidv7(T + 10 * 60_000), parentId: id, actor, body: "busy", now: T + 10 * 60_000 });
    vi.setSystemTime(T + 16 * 60_000);
    await store.alarm();
    const tree = await store.thread(T + 16 * 60_000);
    const ids = tree.ok ? tree.posts.map((post) => post.id) : [];
    expect(ids).not.toContain(quiet.ok ? quiet.post.id : "");
    expect(ids).toHaveLength(2);
  });
});

describe("UserState Durable Object", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T); });
  afterEach(() => { vi.useRealTimers(); });

  it("sends like events, and retries them by alarm when the queue is down", async () => {
    const storage = fakeStorage();
    const queue = fakeQueue();
    const state = new UserState({ storage } as never, { FEED_EVENTS: queue } as never);
    queue.fail(true);
    const thread = uuidv7(T);
    expect(await state.like({ userId: "u1", postId: thread, threadId: thread, on: true, now: T })).toMatchObject({ changed: true });
    expect(storage.alarm).toBe(T + OUTBOX_RETRY_MS);
    queue.fail(false);
    await state.alarm();
    expect(queue.sent).toMatchObject([{ type: "thread.liked", threadId: thread, delta: 1 }]);
  });
});
