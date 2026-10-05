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
    expect(store.like({ userId: "u1", postId: thread, threadId: thread, on: true, now: 1 })).toEqual({ changed: true, first: true });
    expect(store.like({ userId: "u1", postId: thread, threadId: thread, on: true, now: 2 })).toEqual({ changed: false, first: false });
    expect(store.like({ userId: "u1", postId: reply, threadId: thread, on: true, now: 3 })).toEqual({ changed: true, first: false });
    expect(store.like({ userId: "u1", postId: thread, threadId: thread, on: false, now: 4 })).toEqual({ changed: true, first: false });
    expect(store.like({ userId: "u1", postId: thread, threadId: thread, on: false, now: 5 })).toEqual({ changed: false, first: false });
    expect(store.like({ userId: "u1", postId: thread, threadId: thread, on: true, now: 6 })).toEqual({ changed: true, first: false });
  });

  it("allows one repost per user per thread", () => {
    const store = db();
    expect(store.repost({ userId: "u1", threadId: thread, now: 1 })).toEqual({ ok: true, first: true });
    expect(store.repost({ userId: "u1", threadId: thread, now: 2 })).toEqual({ ok: false, first: false });
    expect(store.repost({ userId: "u2", threadId: thread, now: 2 })).toEqual({ ok: true, first: true });
  });

  it("reports a user's engagement for the requested threads only", () => {
    const store = db();
    store.like({ userId: "u1", postId: reply, threadId: thread, on: true, now: 1 });
    store.repost({ userId: "u1", threadId: thread, now: 1 });
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
    expect(store.isEmpty()).toBe(true);
  });

  it("buckets users into 65,536 deterministic names", async () => {
    const name = await userStateName("user-1");
    expect(name).toMatch(/^u:[0-9a-f]{4}$/u);
    expect(await userStateName("user-1")).toBe(name);
  });
});
