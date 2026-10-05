# Nearline Local Feed — Design

**Date:** 2026-10-05
**Status:** Approved in conversation; pending written-spec review
**Supersedes:** the live-only chat model in SPEC.md §2.3, §2.4, §10, §11 and the "no message bodies in storage" rule in the Durable Object section.

## 1. Intent

Turn Nearline from a live-only proximity chat into a local, X-style feed: posts, likes, replies (a full tree) and reposts. Content persists only while it is active: a thread (the root post and everything under it) disappears 15 minutes after the last activity anywhere in it.

What the owner decided:

| Question | Decision |
|---|---|
| Chat | The feed replaces chat entirely. |
| Private rooms | Kept as private feeds: the same room tag filters threads. |
| Reposts | Carry the thread to the reposter's current location (a new anchor). |
| Reply depth | Full tree, any depth. |
| Feed tabs | Latest and Trending. |
| Trending | Decayed engagement score with one count per person per action kind. |
| Architecture | Each area shard owns the threads rooted in it (approach A). |
| UI | Agent's best attempt in the existing road-marking world; owner iterates after. |

Unchanged: passkey auth, anonymous 8-hex author labels, browser-side H3 conversion (raw coordinates never leave the browser), the three ranges (Close/Nearby/Wide at H3 resolutions 11/10/9 with a one-ring), text only, no profiles or follows.

## 2. Definitions

- **Thread:** a root post and its reply tree. The unit of visibility, scoring and expiry.
- **Post:** a root post or a reply. Has an optional parent post.
- **Anchor:** a location a thread is shown from. The root post creates the first anchor; each repost adds one at the reposter's location.
- **Owner shard:** the resolution-5 shard (`GeoShardLive` Durable Object) containing the root post's location. It holds the authoritative thread.
- **Mirror:** a summary copy of a thread held by another shard so that shard can serve feeds and live updates without contacting the owner.
- **Activity:** a new reply, a like, or a repost. Creating the thread also counts. Unlikes, deletes and views do not count.
- **Expiry:** `lastActivityAt + 15 minutes`.

## 3. Visibility

A viewer (location `v`, scope `s`, room tag `r`) can see a thread when the thread's room tag equals `r` and at least one of its anchors is visible to `v` at scope `s` under the existing canonical predicate (`messageVisibleTo(anchor.location, v, s)` in `packages/geo`). There is still exactly one definition of geographic visibility.

Anyone who can see a thread sees its whole reply tree. A viewer can reply to, like or repost only threads they can see; the owner shard verifies this for every action.

A repost of a private-room thread keeps the thread's room tag, so it spreads only inside that room.

## 4. Trending score

Weights are adapted from the relative engagement weights in X's open-sourced Heavy Ranker (reply 13.5, retweet 1.0, like 0.5, author-replied 75), normalized to like = 1:

| Event | Weight |
|---|---|
| Like | 1 |
| Repost | 2 |
| Reply | 27 |
| Thread author replies in their own thread | 150 |

Rules:

1. Each user contributes each event kind to a thread at most once (`engagements(thread_id, user_id, kind)` primary key). Ten replies from one user score as one reply. Unlike does not subtract, and re-liking does not add again.
2. The thread author's own replies count only as the "author replies" event, and only when the thread has at least one reply from someone else (so an author cannot score a monologue).
3. Exponential decay with a 5-minute half-life. Store `(score, scoreAt)`; the current value is `score × 2^(−(now − scoreAt) / 300000)`. Applying an event: decay to now, add the weight, set `scoreAt = now`.
4. The Trending tab lists visible threads with at least two distinct participants (authors, likers, reposters), ordered by current score, ties broken by newest activity.
5. All weights, the half-life and the participant threshold live in `packages/shared/constants.ts`.

No negative signals exist yet because there is no reporting.

## 5. Architecture

Approach A: each `GeoShardLive` Durable Object owns the threads rooted in its area and keeps mirrors of threads that are visible from its area but owned elsewhere.

### 5.1 Owner storage (Durable Object SQLite)

```sql
CREATE TABLE threads (
  id TEXT PRIMARY KEY,           -- equals the root post id
  room_tag TEXT NOT NULL,
  author TEXT NOT NULL,          -- root author label
  author_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  score REAL NOT NULL,
  score_at INTEGER NOT NULL,
  reply_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,   -- likes on the root post
  repost_count INTEGER NOT NULL DEFAULT 0,
  participant_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX threads_expires ON threads(expires_at);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,           -- UUIDv7
  thread_id TEXT NOT NULL,
  parent_id TEXT,                -- NULL for the root
  author TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  location TEXT NOT NULL,        -- r11 cell of the author when posting
  body TEXT NOT NULL,            -- emptied when deleted
  created_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX posts_thread ON posts(thread_id);

CREATE TABLE anchors (
  thread_id TEXT NOT NULL,
  location TEXT NOT NULL,        -- r11 cell
  kind TEXT NOT NULL,            -- 'root' | 'repost'
  by_author TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX anchors_thread ON anchors(thread_id);

CREATE TABLE likes (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE engagements (
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'like' | 'repost' | 'reply' | 'author_reply'
  PRIMARY KEY (thread_id, user_id, kind)
);

CREATE TABLE participants (
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);

CREATE TABLE reposts (
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);
```

A user reposts a given thread at most once.

### 5.2 Mirror storage

```sql
CREATE TABLE thread_mirrors (
  thread_id TEXT PRIMARY KEY,
  owner_shard TEXT NOT NULL,
  summary TEXT NOT NULL,         -- JSON ThreadSummary, replaced whole on update
  room_tag TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX thread_mirrors_expires ON thread_mirrors(expires_at);

CREATE TABLE mirror_engagements (
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'like_root' | 'repost'
  PRIMARY KEY (thread_id, user_id, kind)
);
```

`mirror_engagements` lets a mirror shard set the per-viewer `likedByMe` and `repostedByMe` flags in feed pages.

### 5.3 Which shards hold a thread

The set of shards that must hold a thread is the union, over its anchors, of `candidateShardsForMessage(anchor.location)` (the existing function: shards reachable at any scope from that location). The owner holds the full thread; every other shard in the set holds a mirror. When a repost adds an anchor, newly reached shards receive a mirror. A pure function `mirrorShardsFor(anchors, ownerShard)` computes the set.

Thread summaries carry their anchors, so a mirror shard can test visibility for its own sockets without contacting the owner.

### 5.4 Action flow

1. A client sends an action frame to its own shard (the shard of its current location).
2. If the action targets a thread the shard owns, it handles it locally. Otherwise it forwards it to the owner shard's internal endpoint with the actor's user id, author label, location, scope and room tag. New root posts are always local, because the root's location determines the owner.
3. The owner validates: the thread exists and has not expired, the actor can see it (section 3), the parent post exists in the thread, the thread has fewer than 500 posts, and per-action rules (one repost per user, delete only own posts).
4. The owner applies the change, updates counts, score, `lastActivityAt` and `expiresAt` when the action is an activity, and reschedules its alarm.
5. The owner sends `result` back (through the forwarding shard when there is one).
6. Fanout:
   - `thread` summary updates go to the owner's own eligible sockets and to every mirror shard, which delivers to its eligible sockets. Summary fanout is coalesced per thread to at most one per second; the first update in a window goes immediately and later ones are flushed at the window's end.
   - `postAdded` and `postDeleted` go immediately to sockets that have that thread open, on the owner and on mirror shards.

Mirror and owner calls use the existing `GEO_SHARD.getByName(shard).fetch()` internal-path pattern. Internal paths are reachable only through the binding, never from the public Worker routes.

### 5.5 Expiry

- The owner keeps one Durable Object alarm set to the earliest `expires_at` among its threads and mirrors.
- When the alarm fires, the owner deletes every expired thread (all of its rows in every owner table), sends `expired` to sockets that can see it, notifies mirror shards, then reschedules.
- Mirror shards delete their own expired mirrors in the same alarm pass and send `expired` to their sockets, so a lost notification never leaves a ghost thread.
- Clients also remove a thread when its `expiresAt` passes.

### 5.6 Deletion

The author can delete their own post. A deleted post with no replies is removed from the tree. A deleted post with replies stays as a `[deleted]` placeholder (empty body, `deleted = 1`) so the tree stays intact. Deleting the root post of a thread with no replies deletes the thread. Delete is not an activity.

### 5.7 Limits

| Limit | Value | Enforcement |
|---|---|---|
| Post body | 1,000 characters (existing `MAX_MESSAGE_CHARS`) | Owner and client |
| Posts per thread | 500 | Owner |
| Posts, replies, reposts | Existing per-shard token bucket plus `MESSAGE_LIMITER` (20 per 10 s per user) | Receiving shard |
| Likes and unlikes | New `LIKE_LIMITER` binding, 30 per 10 s per user | Receiving shard |
| Feed page size | 30 threads | Shard |

Reply depth is unbounded in storage.

## 6. Protocol

All frames are JSON over the existing WebSocket. The connect URL and the `position`, `scope` and `room` frames are unchanged. The `message` frame and the server `message` frame are removed.

### 6.1 Client → server

```ts
type ClientFrame =
  | { type: "position"; location: string }
  | { type: "scope"; scope: ProximityScope }
  | { type: "room"; tag: string }
  | { type: "feed"; tab: "latest" | "trending"; cursor?: string }
  | { type: "open"; threadId: string }
  | { type: "close" }
  | { type: "post"; id: string; body: string }
  | { type: "reply"; id: string; threadId: string; parentId: string; body: string }
  | { type: "like"; id: string; postId: string; threadId: string; on: boolean }
  | { type: "repost"; id: string; threadId: string }
  | { type: "delete"; id: string; postId: string; threadId: string };
```

`id` is a client-generated request id used only to correlate the `result`. Post ids are always assigned by the server.

### 6.2 Server → client

```ts
interface Anchor { location: string; kind: "root" | "repost"; byAuthor: string; createdAt: number }

interface PostView {
  id: string; threadId: string; parentId: string | null;
  author: string; body: string; createdAt: number;
  deleted: boolean; likeCount: number; likedByMe: boolean;
}

interface ThreadSummary {
  id: string; roomTag: string; root: PostView;
  replyCount: number; likeCount: number; repostCount: number; participantCount: number;
  score: number; scoreAt: number; lastActivityAt: number; expiresAt: number;
  anchors: Anchor[];
}

interface FeedItem {
  summary: ThreadSummary;
  via: Anchor;                 // the newest anchor visible to this viewer
  likedByMe: boolean; repostedByMe: boolean;
}

type ServerFrame =
  | { type: "ready"; author: string; scope: ProximityScope; roomTag: string }
  | { type: "feedPage"; tab: "latest" | "trending"; items: FeedItem[]; nextCursor: string | null }
  | { type: "thread"; summary: ThreadSummary }
  | { type: "threadTree"; summary: ThreadSummary; posts: PostView[] }
  | { type: "postAdded"; threadId: string; post: PostView }
  | { type: "postDeleted"; threadId: string; postId: string }
  | { type: "expired"; threadId: string }
  | { type: "result"; id: string; ok: true; postId?: string }
  | { type: "result"; id: string; ok: false; code: ErrorCode }
  | { type: "error"; code: ErrorCode };
```

`thread` frames are sent only to sockets whose viewer can see the thread. Anchors are included so the client can recompute `via` for its own location. `likedByMe` is not carried on `thread` updates; the client keeps its own flags from feed pages, thread trees and its own actions.

New error codes: `THREAD_NOT_FOUND`, `THREAD_EXPIRED`, `NOT_VISIBLE`, `PARENT_NOT_FOUND`, `THREAD_FULL`, `ALREADY_REPOSTED`, `NOT_AUTHOR`.

### 6.3 Feed queries

- **Latest:** visible threads ordered by their `via` anchor time, descending. Cursor = the `via` time and thread id of the last item.
- **Trending:** visible threads with `participantCount ≥ 2`, ordered by decayed score at query time. Cursor = page offset. A score snapshot can drift between pages; duplicates are dropped by the client.
- Each thread appears once per page, through its newest anchor visible to the viewer.

## 7. Client

The client state moves from a transcript to:

- `feeds.latest` and `feeds.trending`: ordered thread ids plus cursors.
- `threads`: id → summary, plus the client's own `likedByMe`/`repostedByMe` flags.
- `openThread`: id, its posts, and the focused sub-root for deep chains.
- `pending`: request id → optimistic item.

Flow:

1. On `ready`, request Latest. Request Trending the first time its tab is shown.
2. On range, room or location change, request the active tab again and replace its list.
3. Merge `thread` updates: a new thread, or a newer visible anchor, goes to the top of Latest. Trending re-sorts every 15 seconds from locally decayed scores.
4. Optimistic actions: new posts and replies render immediately with a pending style; likes and reposts update counts immediately. `result` confirms or reverts.
5. Every 5 seconds, remove threads whose `expiresAt` has passed.
6. Reconnects follow the existing lifecycle, then request the active feed again.
7. If the viewer moves or narrows the range so an open thread is no longer visible, the thread stays open for reading, but actions on it fail with `NOT_VISIBLE` and the composer explains why.

## 8. Interface

The road-marking visual world stays (DESIGN contract in `.impeccable/surfaces/public-index-html.md`). The owner will iterate on the result.

### 8.1 Phone

- Header, range strip and lane line unchanged.
- **Latest / Trending tabs** below the lane, in the range-control style.
- **Feed post:** author stud and label, relative time; body; action row with reply, repost and like (SVG icons and counts); "reposted by @x" above when shown through a repost anchor.
- **Fading paint line:** a thin painted line under each post whose length is the thread's remaining lifetime out of 15 minutes. It recedes continuously, snaps back to full on activity, and uses no countdown text. With reduced motion it updates once a minute without animating.
- **Composer:** pinned at the bottom for new posts ("Post nearby…"). A pending post has a dashed outline until confirmed.
- **Thread view:** slides over the feed with a back control. Root post at a larger size, then the reply tree indented per level with dashed guide lines. Past four visible levels, "Continue thread →" re-roots the view at that reply, and back steps up. The composer becomes "Replying to @x" with a cancel control.
- **Empty and ended states:**
  - Latest: "QUIET HERE / Start the line."
  - Trending: "Nothing trending / Threads trend once more than one person joins in."
  - An open thread that expires: "This thread has faded" and a way back to the feed.

### 8.2 Desktop

- The sidebar is unchanged.
- At 1280 px and wider, an open thread shows in a right column beside the feed.
- Below 1280 px it replaces the feed column, as on phones.

## 9. Code organisation

Pure logic stays outside the Durable Object so it can be unit tested:

- `packages/feed/score.ts`: weights, decay, applying an event.
- `packages/feed/tree.ts`: building the reply tree, re-rooting, deletion placeholders.
- `packages/feed/visibility.ts`: thread visibility from anchors, choosing the `via` anchor, `mirrorShardsFor`.
- `packages/feed/order.ts`: Latest and Trending ordering, cursors.
- `packages/protocol`: the new frame types and validators.
- `workers/edge/durable-objects/geo-shard.ts`: socket handling and routing only; storage moves into `workers/edge/durable-objects/thread-store.ts` (owner tables) and `mirror-store.ts`.
- `apps/web`: `main.ts` is split into `feed-state.ts`, `render-feed.ts`, `render-thread.ts`, `socket.ts` and the existing auth/location code, because a single 600-line file would double.

## 10. Testing

- **Unit (vitest):** score decay and weights, once-per-person-per-kind, the author-reply rule, expiry calculation, tree build and re-root, the deleted-post placeholder, visibility from anchors including a repost anchor, `mirrorShardsFor`, Latest and Trending ordering and cursors, frame validators.
- **Integration (`@cloudflare/vitest-pool-workers`, new dev dependency):** runs the Worker and Durable Objects in workerd under test:
  - post → reply → like → repost → expiry through the alarm, including deletion of all rows
  - a repost into another area creating a mirror there, and expiry clearing it
  - a forwarded action from a mirror shard, and rejection when the actor cannot see the thread
  - rate limits and validation errors returning `result` with the right code
- **Preview:** `wrangler versions upload` produces a preview URL for trying it on a phone before deploying to production.

## 11. Migration and rollout

- No D1 changes. Feed data lives only in Durable Object SQLite; the new tables are created in the shard constructor (`CREATE TABLE IF NOT EXISTS`).
- The deploy replaces chat in one step. Old clients still open will fail to parse new frames; the client is served from the same deploy, so a reload fixes it.
- SPEC.md is updated in the same change: §2.3, §2.4, §10, §11 and the Durable Object storage rule are rewritten to match this design.

## 12. Out of scope

Reporting and moderation, quote posts, editing, media, notifications, search, profiles, follows, bookmarks, and moving hot threads to their own Durable Objects (approach B), which remains the scale path if one shard becomes a bottleneck.
