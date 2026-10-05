import { describe, expect, it } from "vitest";
import type { Anchor, FeedItem, PostView, ThreadSummary } from "../packages/protocol/index.ts";
import { FeedState } from "../apps/web/feed-state.ts";

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const via = (createdAt: number, kind: Anchor["kind"] = "root"): Anchor => ({ cell11: "8b195da49b48fff", kind, byAuthor: "aaaa0001", createdAt });

function summary(n: number, extra: Partial<ThreadSummary> = {}): ThreadSummary {
  const root: PostView = { id: id(n), threadId: id(n), parentId: null, author: "aaaa0001", body: `post ${n}`, createdAt: n, deleted: false, likeCount: 0, expiresAt: 1_000_000 };
  return {
    id: id(n), roomTag: "", root, replyCount: 0, likeCount: 0, repostCount: 0, participantCount: 1,
    score: 0, scoreAt: 0, lastActivityAt: n, expiresAt: 1_000_000, version: 1, ...extra,
  };
}

const item = (n: number, extra: Partial<ThreadSummary> = {}, anchor = via(n)): FeedItem => ({ summary: summary(n, extra), via: anchor });

describe("client feed state", () => {
  it("takes a poll as the head of the list and reports what is new", () => {
    const state = new FeedState();
    expect(state.applyHead("latest", [item(2), item(1)], null, "\"a\"")).toEqual([id(2), id(1)]);
    expect(state.applyHead("latest", [item(3), item(2)], null, "\"b\"")).toEqual([id(3)]);
    expect(state.visibleIds("latest")).toEqual([id(3), id(2), id(1)]);
    expect(state.etags.latest).toBe("\"b\"");
  });

  it("keeps one entry when the poll brings the real post before the action confirms it", () => {
    const state = new FeedState();
    const temp = "11111111-1111-4111-8111-111111111111";
    state.addPendingThread({ ...summary(9), id: temp }, via(9));
    state.applyHead("latest", [item(9)], null, null);
    state.confirmPendingThread(temp, id(9));
    expect(state.visibleIds("latest")).toEqual([id(9)]);
    expect(state.threads.size).toBe(1);
  });

  it("renames the placeholder when the action confirms first", () => {
    const state = new FeedState();
    const temp = "11111111-1111-4111-8111-111111111111";
    state.addPendingThread({ ...summary(9), id: temp }, via(9));
    state.confirmPendingThread(temp, id(9));
    expect(state.visibleIds("latest")).toEqual([id(9)]);
    expect(state.threads.get(id(9))?.pending).toBe(false);
    state.applyHead("latest", [item(9)], null, null);
    expect(state.visibleIds("latest")).toEqual([id(9)]);
  });

  it("fades posts on the server's clock, not the phone's", () => {
    const state = new FeedState();
    // The phone is 10 minutes behind the server.
    state.setServerTime(1_000_000, 400_000);
    expect(state.now(400_500)).toBe(1_000_500);
    state.applyHead("latest", [item(1, { expiresAt: 1_000_100 }), item(2, { expiresAt: 2_000_000 })], null, null);
    expect(state.prune(state.now(400_500))).toEqual([id(1)]);
    expect(state.visibleIds("latest")).toEqual([id(2)]);
  });

  it("shows an optimistic like until the server count catches up", () => {
    const state = new FeedState();
    state.setLiked(id(1), true, 3, 0);
    expect(state.likedPosts.has(id(1))).toBe(true);
    expect(state.likeCount(id(1), 3, 1_000)).toBe(4);
    expect(state.likeCount(id(1), 4, 2_000)).toBe(4);
    expect(state.likeCount(id(1), 4, 3_000)).toBe(4);
    state.setLiked(id(1), false, 4, 4_000);
    expect(state.likeCount(id(1), 4, 4_000)).toBe(3);
    state.setLiked(id(1), true, 4, 5_000);
    expect(state.likeCount(id(1), 4, 5_000)).toBe(4);
  });

  it("orders Trending by decayed score and needs two participants", () => {
    const state = new FeedState();
    state.applyHead("latest", [
      item(1, { score: 10, scoreAt: 0, participantCount: 2 }),
      item(2, { score: 50, scoreAt: 0, participantCount: 1 }),
      item(3, { score: 30, scoreAt: 0, participantCount: 3 }),
    ], null, null);
    state.resortTrending(0);
    expect(state.visibleIds("trending")).toEqual([id(3), id(1)]);
  });

  it("applies deletions to the open thread the way the server does", () => {
    const state = new FeedState();
    state.applyHead("latest", [item(1)], null, null);
    state.beginOpen(id(1));
    const reply = (n: number, parentId: string): PostView => ({ id: id(n), threadId: id(1), parentId, author: "bbbb0002", body: "r", createdAt: n, deleted: false, likeCount: 0 });
    state.applyTree({ version: 2, serverTime: 0, summary: summary(1), posts: [summary(1).root, reply(2, id(1)), reply(3, id(2)), reply(4, id(1))] }, "\"t2\"");
    state.removePost(id(4));
    state.removePost(id(2));
    expect(state.open!.posts.map((post) => [post.id, post.deleted])).toEqual([[id(1), false], [id(2), true], [id(3), false]]);
  });

  it("keeps pending replies through a tree refresh and confirms them once", () => {
    const state = new FeedState();
    state.beginOpen(id(1));
    const temp = "22222222-2222-4222-8222-222222222222";
    state.addPendingReply({ id: temp, threadId: id(1), parentId: id(1), author: "bbbb0002", body: "hi", createdAt: 5, deleted: false, likeCount: 0 });
    state.applyTree({ version: 1, serverTime: 0, summary: summary(1), posts: [summary(1).root] }, null);
    expect(state.open!.posts.map((post) => post.id)).toEqual([id(1), temp]);
    state.confirmReply(temp, id(7));
    expect(state.open!.posts.map((post) => post.id)).toEqual([id(1), id(7)]);
    expect(state.pendingReplies.size).toBe(0);
  });

  it("asks about each thread's engagement once", () => {
    const state = new FeedState();
    state.applyHead("latest", [item(1), item(2)], null, null);
    const asked = state.takeUnflagged();
    expect(asked.sort()).toEqual([id(1), id(2)]);
    state.markFlagged(asked);
    expect(state.takeUnflagged()).toEqual([]);
    state.applyEngagement({ liked: [id(1)], reposted: [id(2)] });
    expect(state.likedPosts.has(id(1))).toBe(true);
    expect(state.repostedThreads.has(id(2))).toBe(true);
  });

  it("asks again about threads whose engagement fetch failed", () => {
    const state = new FeedState();
    state.applyHead("latest", [item(1)], null, null);
    expect(state.takeUnflagged()).toEqual([id(1)]);
    // The fetch failed, so nothing was marked.
    expect(state.takeUnflagged()).toEqual([id(1)]);
  });

  describe("faded branches", () => {
    const reply = (n: number, parentId: string, expiresAt: number): PostView => ({
      id: id(n), threadId: id(1), parentId, author: "bbbb0002", body: `r${n}`, createdAt: n, deleted: false, likeCount: 0, expiresAt,
    });

    it("moves the view to the nearest surviving parent when the server drops the focused branch", () => {
      const state = new FeedState();
      state.beginOpen(id(1));
      const before = [summary(1).root, reply(2, id(1), 900_000), reply(3, id(2), 500_000), reply(4, id(3), 500_000)];
      state.applyTree({ version: 1, serverTime: 0, summary: summary(1), posts: before }, null);
      state.focus(id(4));
      state.applyTree({ version: 2, serverTime: 0, summary: summary(1), posts: before.slice(0, 2) }, null);
      expect(state.open!.focusId).toBe(id(2));
      expect(state.open!.branchFaded).toBe(true);
    });

    it("fades replies on the server's clock and keeps the root until the thread expires", () => {
      const state = new FeedState();
      state.beginOpen(id(1));
      state.applyTree({ version: 1, serverTime: 0, summary: summary(1), posts: [summary(1).root, reply(2, id(1), 600_000), reply(3, id(1), 900_000)] }, null);
      state.focus(id(2));
      state.prune(700_000);
      expect(state.open!.posts.map((post) => post.id)).toEqual([id(1), id(3)]);
      expect(state.open!.focusId).toBeNull();
      expect(state.open!.branchFaded).toBe(true);
    });
  });
});
