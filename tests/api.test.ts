import { cellToCenterChild, cellToParent, gridDisk } from "h3-js";
import { describe, expect, it } from "vitest";
import { latLngToCanonicalLocation, locationToScopeCell, messageVisibleTo } from "../packages/geo/index.ts";
import type { FeedResponse, ThreadResponse } from "../packages/protocol/index.ts";
import { THREAD_TTL_MS, type ProximityScope } from "../packages/shared/constants.ts";
import { handleAction } from "../workers/edge/api/actions.ts";
import type { ApiUser } from "../workers/edge/api/context.ts";
import { handleEngagement } from "../workers/edge/api/engagement.ts";
import { handleFeed } from "../workers/edge/api/feed.ts";
import { handleThread } from "../workers/edge/api/threads.ts";
import { createFakeServices, type FakeServices } from "./support/fake-services.ts";

const T = 1_700_000_000_000;
const root = latLngToCanonicalLocation(51.5074, -0.1278);
const paris = latLngToCanonicalLocation(48.8566, 2.3522);
const author: ApiUser = { id: "user-author", author: "aaaa0001" };
const alice: ApiUser = { id: "user-alice", author: "bbbb0002" };
const bob: ApiUser = { id: "user-bob", author: "cccc0003" };
const carol: ApiUser = { id: "user-carol", author: "dddd0004" };
const far: ApiUser = { id: "user-far", author: "eeee0005" };
let requestCounter = 0;
const requestId = () => `00000000-0000-4000-8000-${String(requestCounter += 1).padStart(12, "0")}`;

// Bob stands one Wide cell from the root; Carol one Wide cell further out: she can see Bob, not the root.
const root9 = cellToParent(root, 9);
const bob9 = gridDisk(root9, 1).find((cell) => cell !== root9)!;
const bobLocation = cellToCenterChild(bob9, 11);
const carol9 = gridDisk(bob9, 1).find((cell) => !gridDisk(root9, 1).includes(cell))!;
const carolLocation = cellToCenterChild(carol9, 11);

function viewer(location: string, scope: ProximityScope = 10, room = "") {
  return { cell: locationToScopeCell(location, scope), scope, room };
}

async function act(fake: FakeServices, user: ApiUser, now: number, body: Record<string, unknown>) {
  const response = await handleAction(
    new Request("https://nearline.test/api/actions", { method: "POST", body: JSON.stringify({ id: requestId(), ...body }) }),
    { services: fake.services, user, now },
  );
  return { status: response.status, body: await response.json() as { ok: boolean; postId?: string; code?: string } };
}

async function feed(fake: FakeServices, user: ApiUser, now: number, location: string, scope: ProximityScope = 10, tab = "latest", headers: HeadersInit = {}) {
  const url = new URL(`https://nearline.test/api/feed?${new URLSearchParams({ ...viewer(location, scope), scope: String(scope), tab })}`);
  return handleFeed(url, new Request(url, { headers }), { services: fake.services, user, now });
}

async function feedItems(fake: FakeServices, user: ApiUser, now: number, location: string, scope: ProximityScope = 10, tab = "latest") {
  return (await (await feed(fake, user, now, location, scope, tab)).json() as FeedResponse).items;
}

async function thread(fake: FakeServices, user: ApiUser, now: number, threadId: string, room = "") {
  const url = new URL(`https://nearline.test/api/threads/${threadId}?room=${room}`);
  return handleThread(threadId, url, new Request(url), { services: fake.services, user, now });
}

async function postFromRoot(fake: FakeServices, body = "hello") {
  const result = await act(fake, author, T, { type: "post", ...viewer(root), location: root, body });
  expect(result.body.ok).toBe(true);
  await fake.drain(T);
  return result.body.postId!;
}

describe("feed API", () => {
  it("shows a new post to nearby viewers and nobody far away", async () => {
    const fake = createFakeServices();
    const id = await postFromRoot(fake);
    const items = await feedItems(fake, alice, T + 1, root);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ summary: { id, root: { body: "hello" } }, via: { kind: "root", byAuthor: "aaaa0001", cell11: root } });
    expect(await feedItems(fake, far, T + 1, paris)).toEqual([]);
  });

  it("caches feeds and answers 304 for an unchanged version", async () => {
    const fake = createFakeServices({ cache: true });
    await postFromRoot(fake);
    const first = await feed(fake, alice, T + 1, root);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/u);
    const second = await feed(fake, alice, T + 2, root, 10, "latest", { "if-none-match": etag });
    expect(second.status).toBe(304);
  });

  it("serves replies in the thread view, only to the matching room", async () => {
    const fake = createFakeServices();
    const id = await postFromRoot(fake);
    const replied = await act(fake, alice, T + 1, { type: "reply", ...viewer(root), threadId: id, parentId: id, body: "yo" });
    expect(replied.body).toMatchObject({ ok: true });
    const response = await thread(fake, alice, T + 2, id);
    const body = await response.json() as ThreadResponse;
    expect(body.posts.map((post) => post.body)).toEqual(["hello", "yo"]);
    expect(body.summary.replyCount).toBe(1);
    expect((await thread(fake, alice, T + 2, id, "a".repeat(64))).status).toBe(404);
  });

  it("counts likes, reports them back to the liker, and lets the thread trend", async () => {
    const fake = createFakeServices();
    const id = await postFromRoot(fake);
    expect(await feedItems(fake, alice, T + 1, root, 10, "trending")).toEqual([]);
    expect((await act(fake, alice, T + 1, { type: "like", ...viewer(root), threadId: id, postId: id, on: true })).body.ok).toBe(true);
    await fake.drain(T + 1);
    const [item] = await feedItems(fake, alice, T + 2, root, 10, "trending");
    expect(item).toMatchObject({ summary: { id, likeCount: 1, participantCount: 2 } });
    const url = new URL(`https://nearline.test/api/me/engagement?threads=${id}`);
    const engagement = await (await handleEngagement(url, { services: fake.services, user: alice, now: T + 2 })).json();
    expect(engagement).toEqual({ liked: [id], reposted: [] });
  });

  it("carries a repost to people near the reposter, not near the original", async () => {
    expect(messageVisibleTo(root, bobLocation, 9)).toBe(true);
    expect(messageVisibleTo(root, carolLocation, 9)).toBe(false);
    expect(messageVisibleTo(bobLocation, carolLocation, 9)).toBe(true);

    const fake = createFakeServices();
    const id = await postFromRoot(fake);
    expect(await feedItems(fake, carol, T + 1, carolLocation, 9)).toEqual([]);
    const reposted = await act(fake, bob, T + 1, { type: "repost", ...viewer(bobLocation, 9), threadId: id, location: bobLocation });
    expect(reposted.body.ok).toBe(true);
    await fake.drain(T + 1);
    const [item] = await feedItems(fake, carol, T + 2, carolLocation, 9);
    expect(item).toMatchObject({ summary: { id, repostCount: 1 }, via: { kind: "repost", byAuthor: "cccc0003", cell11: bobLocation } });
    expect(await feedItems(fake, far, T + 2, paris, 9)).toEqual([]);
    const again = await act(fake, bob, T + 3, { type: "repost", ...viewer(bobLocation, 9), threadId: id, location: bobLocation });
    expect(again).toEqual({ status: 409, body: { id: expect.any(String), ok: false, code: "ALREADY_REPOSTED" } });
  });

  it("removes an expired thread everywhere at once, before any sweep", async () => {
    const fake = createFakeServices();
    const id = await postFromRoot(fake);
    const later = T + THREAD_TTL_MS;
    expect(await feedItems(fake, alice, later, root)).toEqual([]);
    expect((await thread(fake, alice, later, id)).status).toBe(410);
    const liked = await act(fake, alice, later, { type: "like", ...viewer(root), threadId: id, postId: id, on: true });
    expect(liked.body).toMatchObject({ ok: false, code: "NOT_VISIBLE" });
  });

  it("rejects actions on threads out of range, empty posts, and malformed bodies", async () => {
    const fake = createFakeServices();
    const id = await postFromRoot(fake);
    const remote = await act(fake, far, T + 1, { type: "like", ...viewer(paris), threadId: id, postId: id, on: true });
    expect(remote).toMatchObject({ status: 403, body: { ok: false, code: "NOT_VISIBLE" } });
    const empty = await act(fake, alice, T + 1, { type: "post", ...viewer(root), location: root, body: "   " });
    expect(empty).toMatchObject({ status: 400, body: { ok: false, code: "INVALID_MESSAGE" } });
    const junk = await act(fake, alice, T + 1, { type: "post" });
    expect(junk).toMatchObject({ status: 400, body: { ok: false, code: "BAD_REQUEST" } });
  });

  it("validates feed parameters", async () => {
    const fake = createFakeServices();
    const url = new URL(`https://nearline.test/api/feed?cell=${locationToScopeCell(root, 9)}&scope=10&room=&tab=latest`);
    const response = await handleFeed(url, new Request(url), { services: fake.services, user: alice, now: T });
    expect(response.status).toBe(400);
  });
});
