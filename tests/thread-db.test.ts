import { describe, expect, it } from "vitest";
import { latLngToCanonicalLocation } from "../packages/geo/index.ts";
import { THREAD_TTL_MS } from "../packages/shared/constants.ts";
import { uuidv7 } from "../packages/shared/uuid.ts";
import type { ThreadLikedEvent, ThreadRepostedEvent } from "../workers/edge/events.ts";
import { ThreadDb } from "../workers/edge/stores/thread-db.ts";
import { memorySql } from "./support/memory-sql.ts";

const location = latLngToCanonicalLocation(51.5074, -0.1278);
const elsewhere = latLngToCanonicalLocation(51.55, -0.05);
const author = { userId: "user-author", author: "aaaa0001" };
const alice = { userId: "user-alice", author: "bbbb0002" };
const bob = { userId: "user-bob", author: "cccc0003" };
const T = 1_000_000;
const threadId = uuidv7(T);

function fresh() {
  const db = new ThreadDb(memorySql());
  db.init();
  const created = db.create({ id: threadId, actor: author, roomTag: "", location, partition: "p-root", body: "hello", now: T });
  return { db, created };
}

function like(postId: string, userId: string, delta: 1 | -1, first: boolean, at: number, eventId = uuidv7(at)): ThreadLikedEvent {
  return { eventId, type: "thread.liked", threadId, postId, userId, delta, first, at };
}

function reply(db: ThreadDb, actor: typeof alice, parentId = threadId, now = T) {
  return db.reply({ postId: uuidv7(now), parentId, actor, body: "re", now });
}

function summaryOf(db: ThreadDb, now = T) {
  const result = db.summary(now);
  if (!result.ok) throw new Error(result.code);
  return result.summary;
}

describe("thread store", () => {
  it("creates a thread and emits its root ref", () => {
    const { created } = fresh();
    expect(created.outcome).toMatchObject({ ok: true, summary: { id: threadId, replyCount: 0, participantCount: 1, version: 1, expiresAt: T + THREAD_TTL_MS } });
    expect(created.events).toHaveLength(1);
    expect(created.events[0]).toMatchObject({ type: "ref.added", partition: "p-root", ref: { threadId, kind: "root", location, byAuthor: "aaaa0001" } });
  });

  it("scores each person's reply once and refreshes every ref partition", () => {
    const { db } = fresh();
    expect(db.reply({ postId: uuidv7(T), parentId: uuidv7(T), actor: alice, body: "x", now: T }).outcome).toEqual({ ok: false, code: "PARENT_NOT_FOUND" });
    const first = reply(db, alice);
    expect(first.outcome).toMatchObject({ ok: true, summary: { replyCount: 1, participantCount: 2, score: 27 } });
    expect(first.events.map((event) => [event.type, event.partition])).toEqual([["thread.updated", "p-root"]]);
    reply(db, alice);
    expect(summaryOf(db).score).toBe(27);
    expect(summaryOf(db).replyCount).toBe(2);
  });

  it("gives authors the reply bonus only after someone else replied", () => {
    const { db } = fresh();
    reply(db, author);
    expect(summaryOf(db).score).toBe(0);
    reply(db, alice);
    reply(db, author);
    expect(summaryOf(db).score).toBe(27 + 150);
  });

  it("refuses the 501st post", () => {
    const { db } = fresh();
    for (let i = 0; i < 499; i += 1) reply(db, alice);
    expect(reply(db, alice).outcome).toEqual({ ok: false, code: "THREAD_FULL" });
  });

  it("treats a thread past its expiry as gone before any alarm runs", () => {
    const { db } = fresh();
    const expiry = T + THREAD_TTL_MS;
    expect(db.reply({ postId: uuidv7(expiry), parentId: threadId, actor: alice, body: "late", now: expiry }).outcome)
      .toEqual({ ok: false, code: "THREAD_EXPIRED" });
    expect(db.summary(expiry)).toEqual({ ok: false, code: "THREAD_EXPIRED" });
    expect(db.applyLikes([like(threadId, alice.userId, 1, true, expiry)], expiry)).toEqual([]);
  });

  it("deletes leaves, keeps placeholders for posts with replies, and removes a lone root's thread", () => {
    const { db } = fresh();
    expect(db.remove({ postId: threadId, actor: bob, now: T }).outcome).toEqual({ ok: false, code: "NOT_AUTHOR" });
    const leaf = reply(db, alice);
    const leafId = leaf.outcome.ok ? leaf.outcome.post.id : "";
    expect(db.remove({ postId: leafId, actor: alice, now: T }).outcome).toEqual({ ok: true, outcome: "remove" });
    expect(summaryOf(db).replyCount).toBe(0);

    const parent = reply(db, alice);
    const parentId = parent.outcome.ok ? parent.outcome.post.id : "";
    reply(db, bob, parentId);
    expect(db.remove({ postId: parentId, actor: alice, now: T }).outcome).toEqual({ ok: true, outcome: "placeholder" });
    const tree = db.thread(T);
    const placeholder = tree.ok ? tree.posts.find((post) => post.id === parentId) : undefined;
    expect(placeholder).toMatchObject({ deleted: true, body: "" });
    expect(db.remove({ postId: parentId, actor: alice, now: T }).outcome).toEqual({ ok: false, code: "POST_NOT_FOUND" });

    const lone = fresh();
    const removed = lone.db.remove({ postId: threadId, actor: author, now: T });
    expect(removed.outcome).toEqual({ ok: true, outcome: "remove_thread" });
    expect(removed.events).toMatchObject([{ type: "thread.expired", partition: "p-root", threadId }]);
    expect(lone.db.summary(T)).toEqual({ ok: false, code: "THREAD_NOT_FOUND" });
  });

  it("applies likes idempotently and in any order", () => {
    const { db } = fresh();
    const later = T + 60_000;
    const events = db.applyLikes([like(threadId, alice.userId, 1, true, later, "e1")], later);
    expect(events.map((event) => event.type)).toEqual(["thread.updated"]);
    let summary = summaryOf(db, later);
    expect(summary.likeCount).toBe(1);
    expect(summary.participantCount).toBe(2);
    expect(summary.expiresAt).toBe(later + THREAD_TTL_MS);
    expect(summary.score).toBeCloseTo(1);

    expect(db.applyLikes([like(threadId, alice.userId, 1, true, later, "e1")], later)).toEqual([]);
    expect(summaryOf(db, later).likeCount).toBe(1);

    // Bob's unlike is delivered before his like: the count must still end at 1, never below 0 on screen.
    db.applyLikes([like(threadId, bob.userId, -1, false, later + 2, "e3")], later);
    expect(summaryOf(db, later).likeCount).toBe(0);
    db.applyLikes([like(threadId, bob.userId, 1, true, later + 1, "e2")], later);
    summary = summaryOf(db, later);
    expect(summary.likeCount).toBe(1);
    expect(summary.score).toBeCloseTo(2);
  });

  it("records a repost anchor in its partition and refreshes all partitions", () => {
    const { db } = fresh();
    const event: ThreadRepostedEvent = {
      eventId: "r1", type: "thread.reposted", threadId, userId: bob.userId, first: true,
      location: elsewhere, partition: "p-far", byAuthor: bob.author, at: T + 10,
    };
    const events = db.applyReposts([event], T + 10);
    expect(events.map((item) => [item.type, item.partition])).toEqual([
      ["ref.added", "p-far"],
      ["thread.updated", "p-root"],
      ["thread.updated", "p-far"],
    ]);
    expect(events[0]).toMatchObject({ ref: { kind: "repost", location: elsewhere, byAuthor: bob.author } });
    expect(summaryOf(db).repostCount).toBe(1);
    expect(summaryOf(db).score).toBeCloseTo(2);
    expect(db.applyReposts([event], T + 10)).toEqual([]);
  });

  it("expires only when due", () => {
    const { db } = fresh();
    expect(db.expireIfDue(T)).toBeNull();
    expect(db.expiresAt()).toBe(T + THREAD_TTL_MS);
    const events = db.expireIfDue(T + THREAD_TTL_MS);
    expect(events).toMatchObject([{ type: "thread.expired", partition: "p-root", threadId }]);
    expect(db.expiresAt()).toBeNull();
  });

  it("creates no storage for a thread that was never created", () => {
    const sql = memorySql();
    const db = new ThreadDb(sql);
    expect(db.summary(T)).toEqual({ ok: false, code: "THREAD_NOT_FOUND" });
    expect(db.remove({ postId: threadId, actor: author, now: T }).outcome).toEqual({ ok: false, code: "THREAD_NOT_FOUND" });
    expect(db.applyLikes([like(threadId, alice.userId, 1, true, T)], T)).toEqual([]);
    expect(db.expiresAt()).toBeNull();
    expect(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()).toEqual([]);
  });

  it("keeps every event in an outbox until it is acknowledged", () => {
    const { db } = fresh();
    expect(db.pendingEvents(100).map((event) => event.type)).toEqual(["ref.added"]);
    db.ackEvents(db.pendingEvents(100).map((event) => event.eventId));
    expect(db.pendingEvents(100)).toEqual([]);
    reply(db, alice);
    expect(db.pendingEvents(100).map((event) => event.type)).toEqual(["thread.updated"]);
  });

  it("is gone only once it has expired and its expiry events were sent", () => {
    const { db } = fresh();
    db.ackEvents(db.pendingEvents(100).map((event) => event.eventId));
    expect(db.isGone()).toBe(false);
    db.expireIfDue(T + THREAD_TTL_MS);
    expect(db.summary(T + THREAD_TTL_MS)).toEqual({ ok: false, code: "THREAD_NOT_FOUND" });
    expect(db.isGone()).toBe(false);
    expect(db.pendingEvents(100).map((event) => event.type)).toEqual(["thread.expired"]);
    db.ackEvents(db.pendingEvents(100).map((event) => event.eventId));
    expect(db.isGone()).toBe(true);
  });
});
