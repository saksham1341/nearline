# Nearline Local Feed — Design (v2)

**Date:** 2026-10-05
**Status:** v2, pending written-spec review
**Supersedes:** the live-only chat model in SPEC.md (§2.3, §2.4, §8–§16, §18, §20) and v1 of this document.

**v2 changes from v1:** pull-only delivery (no WebSockets); storage split into independently partitioned thread stores, location cell indexes and per-user state; cell indexes hold references, never copies; queue-driven propagation; adaptive cell partitions; signed session tokens. The goal is an architecture whose shape holds at a billion users, even though v1 traffic will be tiny.

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
| Delivery | Pull only. Clients poll; the server never pushes. |
| Architecture | Independent partitions for thread data, location indexes and user state, sized for a billion users. |
| Data duplication | Location indexes hold references to threads, not copies. Each thread has one source of truth. |
| UI | Agent's best attempt in the existing road-marking world; owner iterates after. |

Unchanged: passkey registration and login, anonymous 8-hex author labels, browser-side H3 conversion (raw coordinates never leave the browser), the three ranges (Close/Nearby/Wide at H3 resolutions 11/10/9 with a one-ring), text only, no profiles or follows.

## 2. Definitions

- **Thread:** a root post and its reply tree. The unit of visibility, scoring and expiry. Its id is the root post's id.
- **Post:** a root post or a reply. Has an optional parent post.
- **Anchor:** a location a thread is shown from. The root post creates the first anchor; each repost adds one at the reposter's location.
- **Reference (ref):** a row in a cell index saying "thread T is anchored at location L". Holds only what the index needs to filter and order, never post text.
- **Scope cell:** the viewer's location at their range's resolution (`cellToParent(location, scope)`).
- **Region:** the scope cell plus its one-ring (7 cells). A viewer sees an anchor exactly when the anchor's cell at the viewer's scope is in the viewer's region; this is the existing canonical predicate.
- **Partition:** the H3 cell a cell index Durable Object is responsible for. Resolution 5 to 9, chosen per area (section 6).
- **Activity:** a new reply, a like, or a repost. Creating the thread also counts. Unlikes, deletes and reads do not count.
- **Expiry:** `lastActivityAt + 15 minutes`.
- **Branch expiry** (added 2026-10-05): every post is the root of its own branch. A post fades 15 minutes after the latest activity anywhere in its subtree, where a post's own activity is its creation and any like on it, and a repost counts as activity on the root. Quiet branches are pruned while active ones stay. Each post stores only its own last activity; branch expiries are derived from the tree on demand (at most 500 posts), so no stored value can go stale. The root's branch is the whole thread, so the thread's expiry, feeds and cell indexes are unchanged. Replies to a faded branch fail with `PARENT_NOT_FOUND`.

## 3. Visibility

A viewer (scope cell `c` at scope `s`, room tag `r`) can see a thread when the thread's room tag equals `r` and at least one of its anchors has its resolution-`s` parent in the region of `c`. Anyone who can see a thread sees its whole reply tree.

Reading a thread by id requires only the matching room tag. Thread ids are UUIDv7 with 74 random bits, so they cannot be guessed. Actions (reply, like, repost) require visibility, checked against the viewer's region (section 8.3).

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

1. Each user contributes each event kind to a thread at most once. Ten replies from one user score as one reply. Unlike does not subtract, and re-liking does not add again.
2. The thread author's own replies count only as the "author replies" event, and only once the thread has at least one reply from someone else.
3. Exponential decay with a 5-minute half-life. Store `(score, scoreAt)`; the current value is `score × 2^(−(now − scoreAt) / 300000)`. Applying an event: decay to now, add the weight, set `scoreAt = now`.
4. Trending lists visible threads with at least two distinct participants (authors, repliers, likers, reposters), ordered by current score, ties broken by newest activity.
5. All weights, the half-life and the participant threshold live in `packages/shared/constants.ts`.

No negative signals exist yet because there is no reporting.

## 5. Architecture

```
            browser (polls)
                 │  HTTPS
                 ▼
   ┌──────────── Edge Worker (stateless) ─────────────┐
   │ auth (signed token) · validation · rate limits    │
   │ feed assembly · edge cache · action routing       │
   └──┬──────────────┬──────────────┬─────────────┬───┘
      │ sync         │ sync         │ read        │ read/write
      ▼              ▼              ▼             ▼
 ThreadStore DO   UserState DO   CellIndex DO   Cache API
 (one per thread) (by user hash) (per partition)
      │              │              ▲
      └──── events ──┴──► Queue ────┘ (consumer Worker)
```

| Component | Partitioned by | Source of truth for |
|---|---|---|
| Edge Worker | Stateless | Nothing. Authenticates, validates, rate-limits, assembles feeds, caches. |
| `ThreadStore` Durable Object | One per thread (`idFromName(threadId)`) | Posts, reply tree, counts, score, participants, expiry, the set of partitions holding its refs. |
| `CellIndex` Durable Object | One per partition cell | Refs anchored in its cell, with per-ref ordering data; its feed version. |
| `UserState` Durable Object | `idFromName("u:" + first 4 hex of SHA-256(userId))`, 65,536 buckets | Each user's likes and reposts, and first-engagement flags per thread and kind. |
| Queue `feed-events` | Consumer batches | Propagating changes: counts and scores into thread stores, refs and ordering data into cell indexes. |
| Edge cache (Cache API) | Request key | Feed responses (3 s), thread responses (2 s), summaries (2 s). |
| `PartitionMap` (Workers KV) | Global, cached in Worker memory for 30 s | Which cells are split into finer partitions. |
| D1 | Single database | Users, passkey credentials, refresh sessions, auth challenges. |

Data placement: each Durable Object is created with a location hint for its geography where one applies (cell indexes from their cell; thread stores from their root anchor), so a local product keeps its data near its users.

## 6. Location partitions

### 6.1 Partition lookup

Partitions are H3 cells at resolutions 5 to 9. The partition map lists **split** cells. The partition for a location is found by starting at its resolution-5 parent and descending while the current cell is split and its resolution is below 9.

Resolution 9 is the floor because it is the Wide scope's resolution: every region cell (resolution 9, 10 or 11) therefore lies inside exactly one partition, and a feed read touches at most 7 partitions (usually 1 or 2).

The initial map splits nothing below resolution 7: every area starts at resolution 7 (about 5 km²). That default is a constant.

### 6.2 Splitting and merging

- Each cell index counts its writes and reads per minute. When either exceeds its threshold (constants, initially 600 writes/min or 30,000 reads/min) for 5 consecutive minutes and its resolution is below 9, it adds itself to the partition map with `splitAt = now`.
- When a split cell's children have stayed below a quarter of the thresholds for 30 minutes, the parent's entry is removed with `mergedAt = now`.
- Repartitioning needs no data migration. Writers write only to the new partition. Readers read both the old and the new partitions until the old one reports itself drained (a `drain:<cell>` KV key written by its own alarm once it holds no refs), with a 16-minute minimum and a 24-hour cap. (Revised 2026-10-05: a fixed 16-minute window hid threads that stayed active past it, because their refs keep being refreshed in the old partition.)
- The map is versioned. Workers cache it for 30 seconds; the 16-minute dual-read window covers KV propagation delay.

## 7. Storage

### 7.1 ThreadStore (one Durable Object per thread)

```sql
CREATE TABLE thread (
  id TEXT PRIMARY KEY,
  room_tag TEXT NOT NULL,
  author TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  root_location TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  score REAL NOT NULL,
  score_at INTEGER NOT NULL,
  reply_count INTEGER NOT NULL,
  repost_count INTEGER NOT NULL,
  participant_count INTEGER NOT NULL,
  version INTEGER NOT NULL          -- bumps on every change; used for caching and conditional reads
);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,              -- UUIDv7
  parent_id TEXT,                   -- NULL for the root
  author TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  body TEXT NOT NULL,               -- emptied when deleted
  created_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE participants (user_id TEXT PRIMARY KEY);
CREATE TABLE repliers (user_id TEXT PRIMARY KEY);               -- distinct non-author repliers
CREATE TABLE ref_partitions (partition TEXT PRIMARY KEY);       -- where refs to this thread live
CREATE TABLE applied_events (event_id TEXT PRIMARY KEY, at INTEGER NOT NULL);  -- idempotency, kept 20 min
```

A thread store holds one thread. Its alarm is set to `expires_at`; when it fires and the thread is still expired, the store emits `thread.expired` for every partition in `ref_partitions` and calls `deleteAll()`. Reads of an expired thread return `THREAD_EXPIRED` even before the alarm runs.

Limits: 500 posts per thread; reply depth unbounded.

### 7.2 CellIndex (one Durable Object per partition)

```sql
CREATE TABLE refs (
  thread_id TEXT NOT NULL,
  anchor_at INTEGER NOT NULL,       -- anchor creation time
  anchor_kind TEXT NOT NULL,        -- 'root' | 'repost'
  by_author TEXT NOT NULL,
  cell9 TEXT NOT NULL,              -- anchor's parents at the three scope resolutions
  cell10 TEXT NOT NULL,
  cell11 TEXT NOT NULL,
  room_tag TEXT NOT NULL,
  expires_at INTEGER NOT NULL,      -- refreshed by thread.updated events
  score REAL NOT NULL,              -- ordering snapshot, refreshed by thread.updated events
  score_at INTEGER NOT NULL,
  trend_key REAL NOT NULL,          -- log2(score) + score_at / half-life; see below
  participant_count INTEGER NOT NULL,
  PRIMARY KEY (thread_id, anchor_at, by_author)
);
CREATE INDEX refs_cell9 ON refs(room_tag, cell9, anchor_at);
CREATE INDEX refs_cell10 ON refs(room_tag, cell10, anchor_at);
CREATE INDEX refs_cell11 ON refs(room_tag, cell11, anchor_at);
CREATE INDEX refs_expiry ON refs(expires_at);
CREATE INDEX refs_trend ON refs(room_tag, trend_key);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- feed version, load counters
CREATE TABLE applied_events (event_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE tombstones (thread_id TEXT PRIMARY KEY, at INTEGER NOT NULL);  -- expired threads, kept 20 min
```

Exponential decay with a shared half-life preserves order over time: `score · 2^(−(now − scoreAt)/H)` ranks the same as `log2(score) + scoreAt/H` at every `now`. Refs therefore store that time-invariant `trend_key` (−1e9 when the score is 0), and Trending is an indexed sort with no recomputation.

A ref carries ordering data only. Score, expiry and participant count are snapshots kept fresh by events, used to order and filter; the summary shown to users always comes from the thread store (through the cache). A `thread.updated` event for a tombstoned thread is ignored, so an out-of-order event cannot resurrect an expired thread.

The cell index sweeps expired refs and old idempotency rows in an alarm every minute while it holds any rows.

### 7.3 UserState (65,536 bucketed Durable Objects)

```sql
CREATE TABLE likes (user_id TEXT NOT NULL, post_id TEXT NOT NULL, thread_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id));
CREATE TABLE reposts (user_id TEXT NOT NULL, thread_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (user_id, thread_id));
CREATE TABLE engaged (user_id TEXT NOT NULL, thread_id TEXT NOT NULL, kind TEXT NOT NULL,
  PRIMARY KEY (user_id, thread_id, kind));                       -- 'like' | 'repost'
```

Rows older than 20 minutes are swept by a periodic alarm (threads are gone by then). UserState is the authority for "did I like this", which keeps per-viewer state out of the hot thread store and out of public caches.

## 8. Write path

All writes are `POST /api/actions` with a client-generated request `id` (UUID). The Edge Worker authenticates, validates the body, applies the per-user rate limit, then routes:

| Action | Synchronous call | Events emitted |
|---|---|---|
| `post` | ThreadStore (the Edge Worker generates the UUIDv7 thread id and addresses the store by it): create thread | `ref.added` to the root anchor's partition |
| `reply` | ThreadStore: insert post, update counts and score | `thread.updated` to each ref partition |
| `delete` | ThreadStore: remove or placeholder (section 8.4) | `thread.updated`, or `thread.expired` when the thread is removed |
| `like` / `unlike` | UserState: dedupe | `thread.liked` (delta, first-engagement flag) to the thread store |
| `repost` | UserState: dedupe (one per user per thread) | `thread.reposted` (with the new anchor and its partition) to the thread store |

The Edge Worker computes partitions from the partition map and passes them along, so the thread store never reads the map. Refs are only ever emitted by the thread store, which records every partition it emits to in `ref_partitions` and so always knows where its refs live.

The response is `{ id, ok: true, postId? }` or `{ id, ok: false, code }`.

### 8.1 Events

Events go on the `feed-events` queue as `{ eventId, type, ... }`. The consumer Worker groups each batch by target and makes one call per target Durable Object per batch, so a viral thread receiving 100,000 likes a second sees a few calls a second, each carrying aggregated deltas.

| Event | Target | Effect |
|---|---|---|
| `thread.liked` | ThreadStore | Adjust the post's like count; on a first like by that user, add a participant and the like score. A batch containing any added like counts as activity. Then emits `thread.updated`. |
| `thread.reposted` | ThreadStore | Increment repost count, add participant, add repost score (first only), activity; record the anchor's partition and emit `ref.added` to it. Then emits `thread.updated`. |
| `ref.added` | CellIndex | Insert a ref with the thread's current ordering data. |
| `thread.updated` | CellIndex | Refresh `expires_at`, `score`, `score_at`, `participant_count` on all refs for the thread; bump the feed version. |
| `thread.expired` | CellIndex | Delete the thread's refs, write a tombstone, bump the feed version. |

Delivery is at least once and unordered. Every handler is idempotent (`applied_events`), deltas commute, and tombstones stop late `thread.updated` events from resurrecting expired threads. A thread store emits at most one `thread.updated` per partition per consumer batch.

### 8.2 Ref partitions for an anchor

An anchor's ref is written to the partition containing the anchor's location. Readers find it because every region cell lies inside exactly one partition (section 6.1), and the anchor's resolution-9, 10 and 11 parents all lie inside the partition containing the anchor itself. During a repartitioning window, writers use the new partition.

### 8.3 Visibility check for actions

Reply, like and repost carry the viewer's scope cell, scope and room. The Edge Worker asks the viewer's region partitions whether a visible ref for the thread exists (`has-ref` call, one indexed lookup per partition, 1 to 7 parallel calls, cached for 3 s). If none does, the action fails with `NOT_VISIBLE`. The thread store does not repeat the check; Durable Objects are reachable only through bindings.

### 8.4 Deletion

The author can delete their own post. A deleted post with no replies is removed from the tree. A deleted post with replies stays as a `[deleted]` placeholder (empty body, `deleted = 1`) so the tree stays intact. Deleting the root of a thread with no replies removes the thread (`thread.expired`). Delete is not an activity.

## 9. Read path

### 9.1 Feed

`GET /api/feed?cell=<scope cell>&scope=<9|10|11>&room=<tag>&tab=<latest|trending>&cursor=<c>`

The client sends its scope cell, not its resolution-11 location: it is all the server needs, it is coarser, and it lets every viewer in the same scope cell share one cached response.

On a cache miss the Edge Worker:

1. Computes the 7 region cells and their partitions (section 6).
2. Calls each partition's `CellIndex.query({ cells, scope, room, tab, cursor, limit: 60 })`, which returns refs ordered for the tab, with expired refs filtered out.
3. Merges, keeps each thread once (its newest visible anchor), orders (Latest: anchor time; Trending: decayed score, `participant_count ≥ 2`), and takes 30.
4. Fetches the 30 summaries from the summary cache, falling back to the thread stores in parallel. Threads that answer `THREAD_EXPIRED` are dropped.
5. Responds with `{ version, serverTime, items: FeedItem[], nextCursor }` and caches it for 3 seconds.

`version` is a hash of the partition feed versions. Responses carry `ETag: version`; a request with a matching `If-None-Match` gets `304 Not Modified`.

### 9.2 Thread

`GET /api/threads/<id>?room=<tag>` returns `{ version, serverTime, summary, posts }`, cached for 2 seconds, with `ETag`/`304` the same way. The room must match. An expired thread returns `410 Gone` with `THREAD_EXPIRED`.

### 9.3 Per-user flags

`GET /api/me/engagement?threads=<id,id,…>` (at most 60 ids) returns `{ liked: string[] (post ids), reposted: string[] (thread ids) }` from the viewer's UserState bucket. Never cached publicly. The client calls it only for threads it has not seen before, and keeps flags for its own actions locally.

### 9.4 Polling

| Situation | Interval |
|---|---|
| Feed, page visible | 5 s |
| Open thread, page visible | 3 s |
| No change for 60 s | Doubles, up to 30 s; resets on any change or user action |
| Page hidden | Paused; one immediate poll on return |

Polls send `If-None-Match`. New threads at the top of Latest are not inserted while the user is scrolled down; a "N new posts" bar appears instead.

## 10. Sessions and authentication

Passkey registration and login are unchanged and stay in D1. Sessions change so that no poll touches D1:

- **Access token** (`pc_access` cookie, HttpOnly, Secure, SameSite=Strict, 1 hour): `base64url(payload) "." base64url(HMAC-SHA256(SESSION_KEY, payload))`, payload `{ uid, author, sid, exp }`. Verified in the Edge Worker with no storage access.
- **Refresh session** (`pc_session` cookie, 30 days): the existing opaque token hashed in D1. When the access token is missing or expired, the Worker verifies the refresh session in D1 and issues a new access token. That is at most one D1 read per user per hour.
- **Logout** deletes the refresh session and clears both cookies. An access token stays valid until its expiry (at most 1 hour); this is the accepted cost of stateless verification.
- `SESSION_KEY` is a Worker secret (`wrangler secret put SESSION_KEY`).

`/api/actions` and `/api/me/*` require the `Origin` header to equal `ORIGIN` (the check the socket endpoint used to do).

## 11. Rate limits

| Limit | Value | Key |
|---|---|---|
| Posts, replies, reposts, deletes | 20 per 10 s (`MESSAGE_LIMITER`) | user |
| Likes and unlikes | 30 per 10 s (new `LIKE_LIMITER`) | user |
| Reads (feed, thread, engagement) | 120 per 60 s (new `READ_LIMITER`) | user |
| Registration | 3 per 60 s (`REGISTER_LIMITER`) | IP |

`CONNECT_LIMITER` is removed with the sockets.

## 12. Protocol types

```ts
type FeedTab = "latest" | "trending";

interface Anchor { cell11: string; kind: "root" | "repost"; byAuthor: string; createdAt: number }

interface PostView {
  id: string; threadId: string; parentId: string | null;
  author: string; body: string; createdAt: number;
  deleted: boolean; likeCount: number;
}

interface ThreadSummary {
  id: string; roomTag: string; root: PostView;
  replyCount: number; likeCount: number; repostCount: number; participantCount: number;
  score: number; scoreAt: number; lastActivityAt: number; expiresAt: number;
  version: number;
}

interface FeedItem { summary: ThreadSummary; via: Anchor }

interface FeedResponse { version: string; serverTime: number; items: FeedItem[]; nextCursor: string | null }
interface ThreadResponse { version: number; serverTime: number; summary: ThreadSummary; posts: PostView[] }
interface EngagementResponse { liked: string[]; reposted: string[] }

type ActionRequest =
  | { id: string; type: "post"; cell: string; scope: ProximityScope; room: string; location: string; body: string }
  | { id: string; type: "reply"; cell: string; scope: ProximityScope; room: string; threadId: string; parentId: string; body: string }
  | { id: string; type: "like"; cell: string; scope: ProximityScope; room: string; threadId: string; postId: string; on: boolean }
  | { id: string; type: "repost"; cell: string; scope: ProximityScope; room: string; threadId: string; location: string }
  | { id: string; type: "delete"; threadId: string; postId: string };

type ActionResponse = { id: string; ok: true; postId?: string } | { id: string; ok: false; code: ErrorCode };
```

`location` (the resolution-11 cell) is sent only on `post` and `repost`, where it becomes an anchor. Feeds and other actions use the coarser scope cell.

Error codes: `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN_ORIGIN`, `INVALID_LOCATION`, `INVALID_SCOPE`, `INVALID_ROOM_TAG`, `INVALID_MESSAGE`, `RATE_LIMITED`, `THREAD_NOT_FOUND`, `THREAD_EXPIRED`, `NOT_VISIBLE`, `PARENT_NOT_FOUND`, `POST_NOT_FOUND`, `THREAD_FULL`, `ALREADY_REPOSTED`, `NOT_AUTHOR`, `UNAVAILABLE`.

## 13. Client

State:

- `feeds.latest` and `feeds.trending`: ordered thread ids, cursors and the last `version` (ETag).
- `threads`: id → summary and `via`, plus the user's own `likedByMe`/`repostedByMe` flags.
- `openThread`: id, posts, version, and the focused sub-root for deep chains.
- `pending`: request id → optimistic item.
- `clockOffset`: `serverTime − Date.now()` from the last response, used for every expiry and decay calculation.

Flow:

1. After location and session are ready, fetch Latest. Fetch Trending the first time its tab is shown.
2. Poll per section 9.4. Merge results; a thread already shown keeps its position in Latest unless its `via` anchor is newer.
3. On range, room or location change that changes the scope cell, fetch the active tab again and replace its list.
4. Optimistic actions: new posts and replies render immediately with a pending style; likes and reposts update counts immediately. The action response confirms or reverts. A confirmed post is matched to the server's thread by `postId`, so a poll that returns the real thread first does not create a duplicate.
5. Every 5 seconds, remove threads whose `expiresAt` has passed (using `clockOffset`).
6. If the viewer moves or narrows the range so an open thread is no longer visible, it stays open for reading; actions on it fail with `NOT_VISIBLE` and the composer explains why.

## 14. Interface

The road-marking visual world stays (direction contract in `.impeccable/surfaces/public-index-html.md`). The owner will iterate on the result.

### 14.1 Phone

- Header, range strip and lane line as today. The lane's "moves forward per message" behaviour now advances once per poll that brings new posts.
- **Latest / Trending tabs** below the lane, in the range-control style.
- **Feed post:** author stud and label, relative time; body; action row with reply, repost and like (SVG icons and counts); "reposted by @x" above when shown through a repost anchor.
- **Fading paint line:** a thin painted line under each post whose length is the thread's remaining lifetime out of 15 minutes. It recedes continuously, snaps back to full on activity, and uses no countdown text. With reduced motion it updates once a minute without animating.
- **"N new posts" bar** when polls bring new threads while scrolled down.
- **Composer:** pinned at the bottom for new posts ("Post nearby…"). A pending post has a dashed outline until confirmed.
- **Thread view:** slides over the feed with a back control. Root post at a larger size, then the reply tree indented per level with dashed guide lines. Past four visible levels, "Continue thread →" re-roots the view at that reply, and back steps up. The composer becomes "Replying to @x" with a cancel control.
- **Empty and ended states:**
  - Latest: "QUIET HERE / Start the line."
  - Trending: "Nothing trending / Threads trend once more than one person joins in."
  - An open thread that expires: "This thread has faded" and a way back to the feed.
- The connection status line becomes a sync line: "Updated just now" / "Offline — retrying".

### 14.2 Desktop

- The sidebar is unchanged apart from the sync line.
- At 1280 px and wider, an open thread shows in a right column beside the feed.
- Below 1280 px it replaces the feed column, as on phones.

## 15. Code organisation

Pure logic, unit tested in Node:

- `packages/feed/score.ts`: weights, decay, applying an event, reply engagement rules.
- `packages/feed/tree.ts`: building the reply tree, re-rooting, deletion outcomes.
- `packages/feed/region.ts`: region cells, ref cells for an anchor, visibility.
- `packages/feed/partition.ts`: partition lookup over a split map, dual-read windows.
- `packages/feed/order.ts`: merging partition results, Latest and Trending ordering, cursors.
- `packages/feed/session-token.ts`: signing and verifying access tokens.
- `packages/protocol`: request, response and event types and their validators.

Workers:

- `workers/edge/index.ts`: routing.
- `workers/edge/api/feed.ts`, `threads.ts`, `actions.ts`, `engagement.ts`: HTTP handlers.
- `workers/edge/auth/`: passkeys (unchanged), sessions rewritten for access and refresh tokens.
- `workers/edge/durable-objects/thread-store.ts`, `cell-index.ts`, `user-state.ts`: thin Durable Object classes over store modules (`*-db.ts`) that contain all SQL and take a `SqlRunner`, so they are tested against Node's built-in SQLite.
- `workers/edge/queue/consumer.ts`: batching and dispatch of events.
- The `GeoShardLive` class and its socket code are deleted (with a Durable Object migration that deletes the class).

Client: `apps/web/main.ts` (bootstrap, auth, location), `api.ts` (HTTP calls, ETags), `poller.ts` (intervals, backoff, visibility), `feed-state.ts` (pure state, unit tested), `render-post.ts`, `render-feed.ts`, `render-thread.ts`.

## 16. Testing

- **Unit (vitest, Node):** score decay and weights, once-per-person-per-kind, the author-reply rule, tree build and re-root, deletion outcomes, region and visibility, partition lookup including dual-read windows, feed merge and ordering and cursors, session token sign/verify/expiry/tamper, request validators, client feed state (optimistic confirm before and after the real thread arrives, clock offset, pruning).
- **Store tests (vitest with `node:sqlite`):** the `*-db.ts` modules against an in-memory SQLite through the same `SqlRunner` interface the Durable Objects use: thread lifecycle and limits, idempotent and out-of-order events, tombstones, ref queries per scope, UserState dedupe. (`@cloudflare/vitest-pool-workers` does not yet support vitest 5, which this project uses.)
- **Handler tests (vitest, Node):** the HTTP handlers with fake bindings (in-memory Durable Object stubs over the store modules, a fake queue that delivers synchronously, a fake cache): post → feed shows it → reply → like → repost into another partition → feed there shows it → expiry removes it everywhere.
- **Preview:** `wrangler versions upload` produces a preview URL for trying it on a phone before deploying to production.

## 17. Capacity sketch

Not a commitment; it shows where the limits are.

| Load | Mechanism |
|---|---|
| 20 M concurrent users polling | ~4 M requests/s, served mostly by the edge cache (one response per scope cell, room and tab per colo every 3 s); conditional requests return `304`. |
| 80,000 people in one stadium cell | Share a few cached responses; the cell index sees about one query per cache lifetime per colo. |
| A thread with 100,000 likes/s | Likes land in 65,536 UserState buckets; the thread store receives aggregated deltas a few times a second from queue batches. |
| A thread reposted 10,000 times in one city | 10,000 refs, mostly in the same few partitions; each `thread.updated` goes once per partition, not per repost. |
| Dense city cores | Partitions split down to resolution 9 under load and merge back when quiet, without migrating data. |

## 18. Migration and rollout

- The deploy replaces chat in one step: the client, the Worker and the Durable Object classes change together. The `GeoShardLive` class is deleted by a Durable Object migration.
- New bindings: `THREAD_STORE`, `CELL_INDEX`, `USER_STATE` (Durable Objects), `FEED_EVENTS` (queue producer and consumer), `PARTITION_MAP` (KV), `LIKE_LIMITER`, `READ_LIMITER`, and the `SESSION_KEY` secret. Queues and KV availability on the account's plan must be confirmed before the first deploy.
- D1: the `sessions` table stays (refresh sessions). No new D1 tables.
- SPEC.md is updated in the same change: the live-only principles, sharding, WebSocket and fanout sections are replaced by a summary of this design.

## 19. Out of scope

Reporting and moderation, quote posts, editing, media, notifications, search, profiles, follows, bookmarks, device attestation, multi-region failover, and automatic tuning of split thresholds.
