# Nearline Local Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Nearline's live-only WebSocket chat with a pull-only, location-filtered feed of posts, replies, likes and reposts that expire 15 minutes after their last activity, partitioned so the design scales to a billion users. Add a public page that explains the whole system.

**Architecture:** A stateless Edge Worker serves HTTP polls and actions. Each thread lives in its own `ThreadStore` Durable Object (the single source of truth). Location `CellIndex` Durable Objects hold references to threads, partitioned by H3 cells that split under load. Per-user likes and reposts live in 65,536 bucketed `UserState` Durable Objects. A Cloudflare Queue carries follow-on changes between them. Feeds are cached at the edge per scope cell.

**Tech Stack:** TypeScript (strict), Cloudflare Workers, Durable Objects (SQLite), Queues, Workers KV, Cache API, D1, h3-js, @simplewebauthn, esbuild, vitest 5 with `node:sqlite` for store tests.

**Spec:** `docs/superpowers/specs/2026-10-05-local-feed-design.md` (v2). Read it before starting any task.

## Global Constraints

- Thread lifetime: expiry = `lastActivityAt + 15 minutes` (`THREAD_TTL_MS = 900000`). Activity = new reply, a like, a repost, or thread creation. Unlikes, deletes and reads are not activity.
- Trending weights: like 1, repost 2, reply 27, author reply 150. Half-life 5 minutes. Trending requires at least 2 participants.
- Each user contributes each engagement kind to a thread at most once. An author's reply scores only after someone else has replied.
- Limits: post body 1,000 characters (`MAX_MESSAGE_CHARS`), 500 posts per thread, feed page 30, per-partition query 60, engagement lookup at most 60 ids.
- Rate limits: posts/replies/reposts/deletes 20 per 10 s (`MESSAGE_LIMITER`), likes 30 per 10 s (`LIKE_LIMITER`), reads 120 per 60 s (`READ_LIMITER`), registration 3 per 60 s per IP (`REGISTER_LIMITER`).
- Edge cache: feed responses 3 s, thread and summary responses 2 s. ETag + `If-None-Match` → `304`.
- Polling: feed 5 s, open thread 3 s; after 60 s without change, double up to 30 s; paused while the page is hidden.
- Partitions: H3 resolution 7 (default) to 9. Split after 5 consecutive minutes above 600 writes/min or 30,000 reads/min; merge when all children stay below a quarter of both for 30 minutes. Dual-read window 16 minutes.
- Sessions: access token 1 hour (HMAC-SHA256 with `SESSION_KEY`), refresh session 30 days in D1.
- UserState: 65,536 buckets named `u:<first 4 hex of SHA-256(userId)>`.
- `POST` API requests must carry `Origin` equal to `ORIGIN`.
- `packages/geo` is the only module that imports `h3-js` (SPEC.md invariant).
- Raw coordinates never leave the browser. Feeds use the scope cell; only `post` and `repost` send the resolution-11 cell.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
  ```

### Deviations from the spec (decided while planning)

1. **UserState retention is 24 hours, not 20 minutes.** A thread can stay alive for longer than 20 minutes if people keep interacting, and sweeping a user's like after 20 minutes would let them like it again and double count. Constant `USER_STATE_RETENTION_MS`.
2. **Like counts are stored raw and clamped only when displayed.** Queue delivery is unordered; an unlike can arrive before its like. Clamping at write time would leave the count wrong.
3. **Visibility lookups for actions are not cached** in v1. Each action makes at most 7 indexed lookups; the 3-second cache is an optimisation for later.
4. **`GET /api/me/engagement` has no `Origin` check.** Browsers omit `Origin` on same-origin GETs. SameSite=Strict cookies and the absence of CORS headers already stop other sites from reading it.
5. **Thread store adds a `reply_engagements` table** to enforce once-per-person scoring for replies. The spec's schema did not list it.
6. **Region helpers live in `packages/geo`, and access tokens in `packages/shared`**, not in `packages/feed/region.ts` and `packages/feed/session-token.ts` as the spec's file list says. SPEC.md requires `packages/geo` to be the only module that imports H3, and tokens are not feed logic.
7. **Preview environment** uses `preview.nearline.sxm.li` with its own Worker, queue and KV, sharing D1. `wrangler versions upload` cannot apply Durable Object class changes, so a separate preview Worker is the only way to try this before production.

## Review Focus

1. **A thread past its expiry whose alarm has not fired yet.** A person would expect it to be gone everywhere at once: no feed, `410` for the thread, actions rejected. Tests: Task 8 (`THREAD_EXPIRED` from the store), Task 12 (feed and thread after the clock passes expiry).
2. **Queue events delivered twice or out of order.** A person would expect counts and feeds to come out the same. Tests: Task 8 (duplicate event ids; unlike processed before like), Task 9 (stale `thread.updated` after a newer one; `ref.added` after `thread.expired`).
3. **The poll returns the real thread before the action response confirms the optimistic post.** A person would expect one post, not two. Test: Task 16.
4. **A repost carried far from the original location.** A person standing near the reposter, far from the original poster, would expect to see it, and a person near neither would not. Test: Task 12.
5. **A phone whose clock is wrong by minutes.** A person would expect posts to fade on the server's schedule, not their phone's. Test: Task 16.

---

## File Structure

New pure logic (`packages/`):

| File | Responsibility |
|---|---|
| `packages/shared/constants.ts` | All tunable numbers (modified) |
| `packages/shared/session-token.ts` | Sign and verify access tokens |
| `packages/geo/index.ts` | All H3 calls: region cells, ref cells, parents, children, cell centres (modified) |
| `packages/feed/score.ts` | Trending weights, decay, time-invariant trend key, reply scoring rule |
| `packages/feed/tree.ts` | Reply tree build, find, ancestry, deletion outcome |
| `packages/feed/location-hint.ts` | Durable Object location hint for a cell |
| `packages/feed/partition.ts` | Partition lookup over the split map; split and merge decisions |
| `packages/feed/order.ts` | Ref records, cursors, merging partition results into a page |
| `packages/protocol/index.ts` | HTTP request/response types and validators (rewritten in Task 4, legacy removed in Task 17) |

Backend (`workers/edge/`):

| File | Responsibility |
|---|---|
| `events.ts` | Queue event types |
| `services.ts` | Interfaces the HTTP handlers and consumer depend on |
| `services-env.ts` | Production `Services` built from Cloudflare bindings |
| `stores/sql.ts` | `SqlRunner` interface and the Durable Object adapter |
| `stores/thread-db.ts` | All thread SQL |
| `stores/cell-index-db.ts` | All cell index SQL |
| `stores/user-state-db.ts` | All user state SQL |
| `durable-objects/thread-store.ts` | Thin Durable Object over `ThreadDb`: events out, alarm expiry |
| `durable-objects/cell-index.ts` | Thin Durable Object over `CellIndexDb`: sweeping, split/merge |
| `durable-objects/user-state.ts` | Thin Durable Object over `UserStateDb` |
| `queue/consumer.ts` | Groups a batch of events by target and dispatches them |
| `api/context.ts`, `api/respond.ts` | Handler context and shared response helpers |
| `api/feed.ts`, `api/threads.ts`, `api/engagement.ts`, `api/actions.ts` | HTTP handlers |
| `auth/session.ts` | Access and refresh sessions (rewritten) |
| `auth/routes.ts`, `http.ts`, `env.ts`, `index.ts` | Modified |
| `durable-objects/geo-shard.ts` | Deleted |

Client (`apps/web/`):

| File | Responsibility |
|---|---|
| `api.ts` | HTTP calls with ETags |
| `poller.ts` | Poll intervals, backoff |
| `feed-state.ts` | Pure client state (unit tested) |
| `render-post.ts` | One post card and icons |
| `render-feed.ts` | Keyed list rendering, time and life-line refresh |
| `render-thread.ts` | Thread tree view |
| `main.ts` | Bootstrap, auth, location, wiring (rewritten) |

Static: `public/index.html`, `public/styles.css` (modified), `public/how-it-works.html` (new).

Tests: `tests/support/memory-sql.ts`, `tests/support/fake-services.ts`, and one `*.test.ts` per module.

---
### Task 1: Feed constants and trending score

**Files:**
- Modify: `packages/shared/constants.ts`
- Create: `packages/feed/score.ts`
- Test: `tests/score.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - Constants (exact names): `THREAD_TTL_MS`, `MAX_POSTS_PER_THREAD`, `FEED_PAGE_SIZE`, `PARTITION_QUERY_LIMIT`, `MAX_ENGAGEMENT_IDS`, `TREND_HALF_LIFE_MS`, `TREND_MIN_PARTICIPANTS`, `ENGAGEMENT_WEIGHTS`, `type EngagementKind`, `FEED_CACHE_SECONDS`, `THREAD_CACHE_SECONDS`, `EVENT_RETENTION_MS`, `USER_STATE_RETENTION_MS`, `PARTITION_BASE_RESOLUTION`, `PARTITION_MAX_RESOLUTION`, `PARTITION_DUAL_READ_MS`, `PARTITION_MAP_CACHE_MS`, `SPLIT_WRITES_PER_MINUTE`, `SPLIT_READS_PER_MINUTE`, `SPLIT_SUSTAINED_MINUTES`, `MERGE_QUIET_MINUTES`, `ACCESS_TOKEN_TTL_MS`, `MAX_VISIBLE_REPLY_DEPTH`, `POLL_FEED_MS`, `POLL_THREAD_MS`, `POLL_MAX_MS`, `POLL_BACKOFF_AFTER_MS`.
  - `interface Score { value: number; at: number }`
  - `decayedScore(score: Score, now: number): number`
  - `addEngagement(score: Score, kind: EngagementKind, now: number): Score`
  - `trendKey(score: Score): number`
  - `replyEngagement(actorIsAuthor: boolean, othersHaveReplied: boolean): EngagementKind | null`

- [ ] **Step 1: Add the constants**

Append to `packages/shared/constants.ts` (keep everything already there):

```ts
// ---- Local feed (docs/superpowers/specs/2026-10-05-local-feed-design.md) ----
export const THREAD_TTL_MS = 15 * 60_000;
export const MAX_POSTS_PER_THREAD = 500;
export const FEED_PAGE_SIZE = 30;
export const PARTITION_QUERY_LIMIT = 60;
export const MAX_ENGAGEMENT_IDS = 60;

export const TREND_HALF_LIFE_MS = 5 * 60_000;
export const TREND_MIN_PARTICIPANTS = 2;
/** Relative weights adapted from X's open-sourced Heavy Ranker, normalized to like = 1. */
export const ENGAGEMENT_WEIGHTS = { like: 1, repost: 2, reply: 27, author_reply: 150 } as const;
export type EngagementKind = keyof typeof ENGAGEMENT_WEIGHTS;

export const FEED_CACHE_SECONDS = 3;
export const THREAD_CACHE_SECONDS = 2;
/** Idempotency rows and tombstones outlive any late queue retry. */
export const EVENT_RETENTION_MS = 20 * 60_000;
/** Threads can stay alive past 20 minutes, so per-user likes must outlive them. */
export const USER_STATE_RETENTION_MS = 24 * 60 * 60_000;

export const PARTITION_BASE_RESOLUTION = 7;
export const PARTITION_MAX_RESOLUTION = 9;
export const PARTITION_DUAL_READ_MS = 16 * 60_000;
export const PARTITION_MAP_CACHE_MS = 30_000;
export const SPLIT_WRITES_PER_MINUTE = 600;
export const SPLIT_READS_PER_MINUTE = 30_000;
export const SPLIT_SUSTAINED_MINUTES = 5;
export const MERGE_QUIET_MINUTES = 30;

export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
export const MAX_VISIBLE_REPLY_DEPTH = 4;

export const POLL_FEED_MS = 5_000;
export const POLL_THREAD_MS = 3_000;
export const POLL_MAX_MS = 30_000;
export const POLL_BACKOFF_AFTER_MS = 60_000;
```

- [ ] **Step 2: Write the failing test**

Create `tests/score.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { addEngagement, decayedScore, replyEngagement, trendKey } from "../packages/feed/score.ts";
import { TREND_HALF_LIFE_MS } from "../packages/shared/constants.ts";

describe("trending score", () => {
  it("weights engagements with the X-derived ratios", () => {
    const start = { value: 0, at: 0 };
    expect(addEngagement(start, "like", 0).value).toBe(1);
    expect(addEngagement(start, "repost", 0).value).toBe(2);
    expect(addEngagement(start, "reply", 0).value).toBe(27);
    expect(addEngagement(start, "author_reply", 0).value).toBe(150);
  });

  it("halves every half-life", () => {
    expect(decayedScore({ value: 8, at: 0 }, TREND_HALF_LIFE_MS)).toBeCloseTo(4);
    expect(decayedScore({ value: 8, at: 0 }, 2 * TREND_HALF_LIFE_MS)).toBeCloseTo(2);
  });

  it("never grows when read before its timestamp", () => {
    expect(decayedScore({ value: 8, at: 1_000 }, 0)).toBe(8);
  });

  it("decays before adding", () => {
    const later = addEngagement({ value: 10, at: 0 }, "like", TREND_HALF_LIFE_MS);
    expect(later.value).toBeCloseTo(6);
    expect(later.at).toBe(TREND_HALF_LIFE_MS);
  });

  it("orders by trend key exactly as by decayed value at any instant", () => {
    const older = { value: 100, at: 0 };
    const newer = { value: 30, at: 2 * TREND_HALF_LIFE_MS };
    for (const now of [3 * TREND_HALF_LIFE_MS, 10 * TREND_HALF_LIFE_MS, 40 * TREND_HALF_LIFE_MS]) {
      const byValue = Math.sign(decayedScore(older, now) - decayedScore(newer, now));
      const byKey = Math.sign(trendKey(older) - trendKey(newer));
      expect(byKey).toBe(byValue);
    }
    expect(trendKey({ value: 0, at: 5 })).toBe(-1e9);
  });

  it("scores author replies only after someone else replied", () => {
    expect(replyEngagement(false, false)).toBe("reply");
    expect(replyEngagement(false, true)).toBe("reply");
    expect(replyEngagement(true, false)).toBeNull();
    expect(replyEngagement(true, true)).toBe("author_reply");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/score.test.ts`
Expected: FAIL, `Failed to load url ../packages/feed/score.ts`.

- [ ] **Step 4: Implement**

Create `packages/feed/score.ts`:

```ts
import { ENGAGEMENT_WEIGHTS, TREND_HALF_LIFE_MS, type EngagementKind } from "../shared/constants.ts";

export interface Score {
  value: number;
  at: number;
}

/** Current value of a score that halves every TREND_HALF_LIFE_MS. Reading before `at` never inflates it. */
export function decayedScore(score: Score, now: number): number {
  const elapsed = Math.max(0, now - score.at);
  return score.value * 2 ** (-elapsed / TREND_HALF_LIFE_MS);
}

export function addEngagement(score: Score, kind: EngagementKind, now: number): Score {
  return { value: decayedScore(score, now) + ENGAGEMENT_WEIGHTS[kind], at: now };
}

/**
 * Time-invariant sort key. With one shared half-life H, value·2^(−(now−at)/H) ranks the same as
 * log2(value) + at/H at every instant, so an index on this key orders Trending without recomputation.
 */
export function trendKey(score: Score): number {
  return score.value > 0 ? Math.log2(score.value) + score.at / TREND_HALF_LIFE_MS : -1e9;
}

/** Authors earn the reply bonus only once someone else has replied, so a monologue cannot trend. */
export function replyEngagement(actorIsAuthor: boolean, othersHaveReplied: boolean): EngagementKind | null {
  if (!actorIsAuthor) return "reply";
  return othersHaveReplied ? "author_reply" : null;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/score.test.ts && npm run typecheck`
Expected: 6 tests pass; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/constants.ts packages/feed/score.ts tests/score.test.ts
git commit -F - <<'EOF'
feat(feed): add feed constants and trending score

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---

### Task 2: Geography helpers and location hints

**Files:**
- Modify: `packages/geo/index.ts`
- Create: `packages/feed/location-hint.ts`
- Test: `tests/geo-feed.test.ts`

**Interfaces:**
- Consumes: existing `locationToScopeCell`, `messageVisibleTo`, `latLngToCanonicalLocation`, `isCanonicalLocation` from `packages/geo`.
- Produces (in `packages/geo/index.ts`):
  - `isScopeCell(value: unknown, scope: ProximityScope): value is string`
  - `regionCells(scopeCell: string): string[]`
  - `interface RefCells { cell9: string; cell10: string; cell11: string }`
  - `refCells(location: string): RefCells`
  - `resolutionOf(cell: string): number`
  - `parentAt(cell: string, resolution: number): string`
  - `childrenOf(cell: string): string[]`
  - `cellCenter(cell: string): { latitude: number; longitude: number }`
- Produces (in `packages/feed/location-hint.ts`):
  - `type LocationHint = "wnam" | "enam" | "sam" | "weur" | "eeur" | "apac" | "oc" | "afr" | "me"`
  - `locationHintFor(cell: string): LocationHint`

- [ ] **Step 1: Write the failing test**

Create `tests/geo-feed.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  cellCenter,
  childrenOf,
  isScopeCell,
  latLngToCanonicalLocation,
  locationToScopeCell,
  messageVisibleTo,
  parentAt,
  refCells,
  regionCells,
  resolutionOf,
} from "../packages/geo/index.ts";
import { locationHintFor } from "../packages/feed/location-hint.ts";

const london = latLngToCanonicalLocation(51.5074, -0.1278);

describe("feed geography", () => {
  it("accepts a scope cell only at the scope's resolution", () => {
    expect(isScopeCell(locationToScopeCell(london, 10), 10)).toBe(true);
    expect(isScopeCell(locationToScopeCell(london, 10), 9)).toBe(false);
    expect(isScopeCell("not-a-cell", 10)).toBe(false);
    expect(isScopeCell(42, 10)).toBe(false);
  });

  it("derives the seven-cell region and the anchor's parents", () => {
    const scopeCell = locationToScopeCell(london, 9);
    expect(regionCells(scopeCell)).toHaveLength(7);
    expect(regionCells(scopeCell)).toContain(scopeCell);
    const cells = refCells(london);
    expect(cells.cell11).toBe(london);
    expect(cells.cell10).toBe(locationToScopeCell(london, 10));
    expect(cells.cell9).toBe(locationToScopeCell(london, 9));
  });

  it("region membership agrees with the canonical visibility predicate", () => {
    for (let i = 0; i < 300; i += 1) {
      const anchor = latLngToCanonicalLocation(51.5074 + (i % 15 - 7) * 0.0011, -0.1278 + (Math.floor(i / 15) - 10) * 0.0016);
      for (const scope of [9, 10, 11] as const) {
        const region = new Set(regionCells(locationToScopeCell(london, scope)));
        const anchorCell = refCells(anchor)[`cell${scope}`];
        expect(region.has(anchorCell)).toBe(messageVisibleTo(anchor, london, scope));
      }
    }
  });

  it("walks the hierarchy", () => {
    const r7 = parentAt(london, 7);
    expect(resolutionOf(r7)).toBe(7);
    expect(childrenOf(r7).map(resolutionOf)).toEqual(Array(childrenOf(r7).length).fill(8));
    expect(childrenOf(r7)).toContain(parentAt(london, 8));
    const center = cellCenter(r7);
    expect(center.latitude).toBeCloseTo(51.5, 0);
  });

  it("maps cells to Durable Object location hints", () => {
    const hint = (lat: number, lng: number) => locationHintFor(latLngToCanonicalLocation(lat, lng));
    expect(hint(51.5074, -0.1278)).toBe("weur");
    expect(hint(40.7128, -74.006)).toBe("enam");
    expect(hint(37.7749, -122.4194)).toBe("wnam");
    expect(hint(-23.5505, -46.6333)).toBe("sam");
    expect(hint(25.2048, 55.2708)).toBe("me");
    expect(hint(6.5244, 3.3792)).toBe("afr");
    expect(hint(55.7558, 37.6173)).toBe("eeur");
    expect(hint(35.6762, 139.6503)).toBe("apac");
    expect(hint(-33.8688, 151.2093)).toBe("oc");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/geo-feed.test.ts`
Expected: FAIL, `isScopeCell` is not exported (or the location-hint module is missing).

- [ ] **Step 3: Implement the geo helpers**

In `packages/geo/index.ts`, extend the `h3-js` import to:

```ts
import {
  cellToChildren,
  cellToLatLng,
  cellToParent,
  getResolution,
  gridDisk,
  isValidCell,
  latLngToCell,
} from "h3-js";
```

and the constants import to also bring in `isProximityScope` is not needed; keep the existing import. Then append:

```ts
/** A cell is a valid scope cell when it sits exactly at the scope's resolution. */
export function isScopeCell(value: unknown, scope: ProximityScope): value is string {
  return typeof value === "string" && isValidCell(value) && getResolution(value) === scope;
}

/** The scope cell plus its one-ring: everything a viewer with this scope cell can see. */
export function regionCells(scopeCell: string): string[] {
  return gridDisk(scopeCell, 1);
}

export interface RefCells {
  cell9: string;
  cell10: string;
  cell11: string;
}

/** An anchor's cell at each scope resolution, stored on refs so every scope is an indexed lookup. */
export function refCells(location: string): RefCells {
  assertCanonicalLocation(location);
  return { cell9: cellToParent(location, 9), cell10: cellToParent(location, 10), cell11: location };
}

export function resolutionOf(cell: string): number {
  return getResolution(cell);
}

export function parentAt(cell: string, resolution: number): string {
  return cellToParent(cell, resolution);
}

export function childrenOf(cell: string): string[] {
  return cellToChildren(cell, getResolution(cell) + 1);
}

export function cellCenter(cell: string): { latitude: number; longitude: number } {
  const [latitude, longitude] = cellToLatLng(cell);
  return { latitude, longitude };
}
```

- [ ] **Step 4: Implement location hints**

Create `packages/feed/location-hint.ts`:

```ts
import { cellCenter } from "../geo/index.ts";

/** A subset of Cloudflare's Durable Object location hints. */
export type LocationHint = "wnam" | "enam" | "sam" | "weur" | "eeur" | "apac" | "oc" | "afr" | "me";

/**
 * Coarse continent boxes. A Durable Object created with a hint lives near its users,
 * which keeps a local product's data local. Wrong guesses only cost latency.
 */
export function locationHintFor(cell: string): LocationHint {
  const { latitude, longitude } = cellCenter(cell);
  if (longitude < -30) {
    if (latitude < 13) return "sam";
    return longitude < -100 ? "wnam" : "enam";
  }
  if (longitude < 60) {
    if (latitude < 35) return longitude > 34 && latitude > 12 ? "me" : "afr";
    return longitude < 20 ? "weur" : "eeur";
  }
  return latitude < -10 ? "oc" : "apac";
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/geo-feed.test.ts && npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/geo/index.ts packages/feed/location-hint.ts tests/geo-feed.test.ts
git commit -F - <<'EOF'
feat(geo): add region, ref-cell and hierarchy helpers plus location hints

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---

### Task 3: Reply tree utilities

**Files:**
- Create: `packages/feed/tree.ts`
- Test: `tests/tree.test.ts`

**Interfaces:**
- Consumes: nothing new. Step 1 adds the `PostView` type to `packages/protocol/index.ts`; Task 4 builds on it unchanged.
- Produces:
  - `interface TreeNode { post: PostView; children: TreeNode[] }`
  - `buildTree(posts: readonly PostView[]): TreeNode | null`
  - `findNode(root: TreeNode, postId: string): TreeNode | null`
  - `ancestry(posts: readonly Pick<PostView, "id" | "parentId">[], postId: string): string[]` (root → post, inclusive)
  - `countDescendants(node: TreeNode): number`
  - `type DeletionOutcome = "remove" | "placeholder" | "remove_thread"`
  - `deletionOutcome(posts: readonly Pick<PostView, "id" | "parentId">[], postId: string): DeletionOutcome | null`

- [ ] **Step 1: Add `PostView` to the protocol package**

Append to `packages/protocol/index.ts`:

```ts
export interface PostView {
  id: string;
  threadId: string;
  parentId: string | null;
  author: string;
  body: string;
  createdAt: number;
  deleted: boolean;
  likeCount: number;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/tree.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ancestry, buildTree, countDescendants, deletionOutcome, findNode } from "../packages/feed/tree.ts";
import type { PostView } from "../packages/protocol/index.ts";

function post(id: string, parentId: string | null, createdAt: number): PostView {
  return { id, threadId: "root", parentId, author: "abcd1234", body: id, createdAt, deleted: false, likeCount: 0 };
}

const posts = [
  post("root", null, 0),
  post("b", "root", 2),
  post("a", "root", 1),
  post("a1", "a", 3),
  post("a1x", "a1", 4),
];

describe("reply tree", () => {
  it("builds children in time order", () => {
    const root = buildTree(posts)!;
    expect(root.post.id).toBe("root");
    expect(root.children.map((node) => node.post.id)).toEqual(["a", "b"]);
    expect(root.children[0]!.children[0]!.children[0]!.post.id).toBe("a1x");
  });

  it("drops orphans and returns null without a root", () => {
    expect(buildTree([post("x", "missing", 1)])).toBeNull();
    const root = buildTree([...posts, post("orphan", "missing", 9)])!;
    expect(findNode(root, "orphan")).toBeNull();
  });

  it("finds nodes, ancestry and descendant counts", () => {
    const root = buildTree(posts)!;
    expect(findNode(root, "a1")!.children).toHaveLength(1);
    expect(ancestry(posts, "a1x")).toEqual(["root", "a", "a1", "a1x"]);
    expect(ancestry(posts, "nope")).toEqual([]);
    expect(countDescendants(root)).toBe(4);
  });

  it("decides how a deletion changes the tree", () => {
    expect(deletionOutcome(posts, "b")).toBe("remove");
    expect(deletionOutcome(posts, "a")).toBe("placeholder");
    expect(deletionOutcome(posts, "root")).toBe("placeholder");
    expect(deletionOutcome([post("root", null, 0)], "root")).toBe("remove_thread");
    expect(deletionOutcome(posts, "missing")).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/tree.test.ts`
Expected: FAIL, cannot load `../packages/feed/tree.ts`.

- [ ] **Step 4: Implement**

Create `packages/feed/tree.ts`:

```ts
import type { PostView } from "../protocol/index.ts";

export interface TreeNode {
  post: PostView;
  children: TreeNode[];
}

/** Builds the reply tree. Children are in creation order; posts whose parent is missing are dropped. */
export function buildTree(posts: readonly PostView[]): TreeNode | null {
  const sorted = [...posts].sort((a, b) => a.createdAt - b.createdAt || compareIds(a.id, b.id));
  const nodes = new Map<string, TreeNode>(sorted.map((post) => [post.id, { post, children: [] }]));
  let root: TreeNode | null = null;
  for (const post of sorted) {
    const node = nodes.get(post.id)!;
    if (post.parentId === null) root ??= node;
    else nodes.get(post.parentId)?.children.push(node);
  }
  return root;
}

export function findNode(root: TreeNode, postId: string): TreeNode | null {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.post.id === postId) return node;
    stack.push(...node.children);
  }
  return null;
}

/** Ids from the root down to `postId`, inclusive. Empty when the post is unknown. */
export function ancestry(posts: readonly Pick<PostView, "id" | "parentId">[], postId: string): string[] {
  const byId = new Map(posts.map((post) => [post.id, post]));
  const chain: string[] = [];
  let current = byId.get(postId);
  while (current && chain.length <= posts.length) {
    chain.unshift(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return chain;
}

export function countDescendants(node: TreeNode): number {
  let count = 0;
  const stack = [...node.children];
  while (stack.length > 0) {
    const next = stack.pop()!;
    count += 1;
    stack.push(...next.children);
  }
  return count;
}

export type DeletionOutcome = "remove" | "placeholder" | "remove_thread";

/**
 * A post with replies stays as a placeholder so the tree keeps its shape.
 * A root with nothing under it takes the whole thread with it.
 */
export function deletionOutcome(
  posts: readonly Pick<PostView, "id" | "parentId">[],
  postId: string,
): DeletionOutcome | null {
  const target = posts.find((post) => post.id === postId);
  if (!target) return null;
  if (target.parentId === null) return posts.length === 1 ? "remove_thread" : "placeholder";
  return posts.some((post) => post.parentId === postId) ? "placeholder" : "remove";
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/tree.test.ts && npm run typecheck`
Expected: 4 tests pass; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/index.ts packages/feed/tree.ts tests/tree.test.ts
git commit -F - <<'EOF'
feat(feed): add reply tree utilities

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---

### Task 4: Feed protocol types and request validation

**Files:**
- Modify: `packages/protocol/index.ts`
- Test: `tests/protocol-feed.test.ts`

**Interfaces:**
- Consumes: `isScopeCell`, `isCanonicalLocation`, `locationToScopeCell` from `packages/geo`; `MAX_MESSAGE_CHARS`, `isProximityScope`, `ProximityScope` from constants; `PostView` (Task 3).
- Produces (all exported from `packages/protocol/index.ts`):
  - `type FeedTab = "latest" | "trending"`
  - `interface Anchor { cell11: string; kind: "root" | "repost"; byAuthor: string; createdAt: number }`
  - `interface ThreadSummary { id; roomTag; root: PostView; replyCount; likeCount; repostCount; participantCount; score; scoreAt; lastActivityAt; expiresAt; version }` (all numbers except `id`, `roomTag`, `root`)
  - `interface FeedItem { summary: ThreadSummary; via: Anchor }`
  - `interface FeedResponse { version: string; serverTime: number; items: FeedItem[]; nextCursor: string | null }`
  - `interface ThreadResponse { version: number; serverTime: number; summary: ThreadSummary; posts: PostView[] }`
  - `interface EngagementResponse { liked: string[]; reposted: string[] }`
  - `type ActionRequest` (union of `post`, `reply`, `like`, `repost`, `delete`, exactly as the spec's section 12)
  - `type ActionOutcome = { ok: true; postId?: string } | { ok: false; code: ErrorCode }`
  - `type ActionResponse = { id: string } & ActionOutcome`
  - `type ErrorCode` (union including both the legacy chat codes and the feed codes)
  - `isUuid(value: unknown): value is string`
  - `isValidPostBody(value: unknown): value is string`
  - `parseActionRequest(value: unknown): ActionRequest | null`
  - Existing `isRoomTag`, and the legacy chat exports, stay untouched until Task 17.

- [ ] **Step 1: Write the failing test**

Create `tests/protocol-feed.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { latLngToCanonicalLocation, locationToScopeCell } from "../packages/geo/index.ts";
import { isUuid, isValidPostBody, parseActionRequest } from "../packages/protocol/index.ts";
import { uuidv7 } from "../packages/shared/uuid.ts";

const location = latLngToCanonicalLocation(51.5074, -0.1278);
const cell = locationToScopeCell(location, 10);
const requestId = "3b2b0a6e-1d5c-4f9a-8c33-4c1f0f9f2d11";
const threadId = uuidv7();

describe("feed protocol", () => {
  it("recognises UUIDs of any version", () => {
    expect(isUuid(requestId)).toBe(true);
    expect(isUuid(threadId)).toBe(true);
    expect(isUuid("nope")).toBe(false);
    expect(isUuid(7)).toBe(false);
  });

  it("validates post bodies by visible content and character count", () => {
    expect(isValidPostBody("hello")).toBe(true);
    expect(isValidPostBody("   ")).toBe(false);
    expect(isValidPostBody("😀".repeat(1_000))).toBe(true);
    expect(isValidPostBody("a".repeat(1_001))).toBe(false);
    expect(isValidPostBody(null)).toBe(false);
  });

  it("parses a post whose location lies inside the stated scope cell", () => {
    const parsed = parseActionRequest({ id: requestId, type: "post", cell, scope: 10, room: "", location, body: "hi" });
    expect(parsed).toEqual({ id: requestId, type: "post", cell, scope: 10, room: "", location, body: "hi" });
    const elsewhere = latLngToCanonicalLocation(48.8566, 2.3522);
    expect(parseActionRequest({ id: requestId, type: "post", cell, scope: 10, room: "", location: elsewhere, body: "hi" })).toBeNull();
  });

  it("parses replies, likes, reposts and deletes", () => {
    const parentId = uuidv7();
    expect(parseActionRequest({ id: requestId, type: "reply", cell, scope: 10, room: "", threadId, parentId, body: "yo" }))
      .toMatchObject({ type: "reply", threadId, parentId });
    expect(parseActionRequest({ id: requestId, type: "like", cell, scope: 10, room: "", threadId, postId: parentId, on: true }))
      .toMatchObject({ type: "like", on: true });
    expect(parseActionRequest({ id: requestId, type: "repost", cell, scope: 10, room: "", threadId, location }))
      .toMatchObject({ type: "repost", location });
    expect(parseActionRequest({ id: requestId, type: "delete", threadId, postId: parentId }))
      .toEqual({ id: requestId, type: "delete", threadId, postId: parentId });
  });

  it("rejects malformed requests", () => {
    const base = { id: requestId, cell, scope: 10, room: "", threadId };
    for (const value of [
      null, [], "post", {},
      { ...base, type: "explode" },
      { ...base, type: "like", postId: threadId, on: "yes" },
      { ...base, type: "like", postId: threadId, on: true, scope: 8 },
      { ...base, type: "like", postId: threadId, on: true, room: "UPPER" },
      { ...base, type: "like", postId: threadId, on: true, cell: locationToScopeCell(location, 9) },
      { ...base, id: "x", type: "like", postId: threadId, on: true },
      { ...base, type: "reply", parentId: "x", body: "hi" },
    ]) {
      expect(parseActionRequest(value)).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/protocol-feed.test.ts`
Expected: FAIL, `isUuid` is not exported.

- [ ] **Step 3: Implement**

In `packages/protocol/index.ts`:

1. Replace the first import line with:

```ts
import { isCanonicalLocation, isScopeCell, locationToScopeCell } from "../geo/index.ts";
import { isProximityScope, MAX_MESSAGE_CHARS, type ProximityScope } from "../shared/constants.ts";
```

2. Replace the existing `ErrorCode` union with:

```ts
export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN_ORIGIN"
  | "INVALID_LOCATION"
  | "INVALID_SCOPE"
  | "INVALID_ROOM_TAG"
  | "INVALID_MESSAGE"
  | "RATE_LIMITED"
  | "THREAD_NOT_FOUND"
  | "THREAD_EXPIRED"
  | "NOT_VISIBLE"
  | "PARENT_NOT_FOUND"
  | "POST_NOT_FOUND"
  | "THREAD_FULL"
  | "ALREADY_REPOSTED"
  | "NOT_AUTHOR"
  | "UNAVAILABLE"
  // Legacy live chat, removed in Task 17.
  | "SHARD_CHANGED"
  | "MESSAGE_REJECTED";
```

3. Append below the `PostView` interface from Task 3:

```ts
export type FeedTab = "latest" | "trending";

export interface Anchor {
  cell11: string;
  kind: "root" | "repost";
  byAuthor: string;
  createdAt: number;
}

export interface ThreadSummary {
  id: string;
  roomTag: string;
  root: PostView;
  replyCount: number;
  likeCount: number;
  repostCount: number;
  participantCount: number;
  score: number;
  scoreAt: number;
  lastActivityAt: number;
  expiresAt: number;
  version: number;
}

export interface FeedItem {
  summary: ThreadSummary;
  via: Anchor;
}

export interface FeedResponse {
  version: string;
  serverTime: number;
  items: FeedItem[];
  nextCursor: string | null;
}

export interface ThreadResponse {
  version: number;
  serverTime: number;
  summary: ThreadSummary;
  posts: PostView[];
}

export interface EngagementResponse {
  liked: string[];
  reposted: string[];
}

interface ViewerFields {
  cell: string;
  scope: ProximityScope;
  room: string;
}

export type ActionRequest =
  | ({ id: string; type: "post"; location: string; body: string } & ViewerFields)
  | ({ id: string; type: "reply"; threadId: string; parentId: string; body: string } & ViewerFields)
  | ({ id: string; type: "like"; threadId: string; postId: string; on: boolean } & ViewerFields)
  | ({ id: string; type: "repost"; threadId: string; location: string } & ViewerFields)
  | { id: string; type: "delete"; threadId: string; postId: string };

export type ActionOutcome = { ok: true; postId?: string } | { ok: false; code: ErrorCode };
export type ActionResponse = { id: string } & ActionOutcome;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isValidPostBody(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= MAX_MESSAGE_CHARS;
}

/**
 * Shape and type validation for POST /api/actions. Body length is checked separately so the
 * caller can answer INVALID_MESSAGE instead of BAD_REQUEST.
 */
export function parseActionRequest(value: unknown): ActionRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!isUuid(input.id)) return null;
  const id = input.id;

  if (input.type === "delete") {
    return isUuid(input.threadId) && isUuid(input.postId)
      ? { id, type: "delete", threadId: input.threadId, postId: input.postId }
      : null;
  }

  const viewer = parseViewer(input);
  if (!viewer) return null;

  switch (input.type) {
    case "post":
      if (!isCanonicalLocation(input.location) || typeof input.body !== "string") return null;
      if (locationToScopeCell(input.location, viewer.scope) !== viewer.cell) return null;
      return { id, type: "post", ...viewer, location: input.location, body: input.body };
    case "reply":
      if (!isUuid(input.threadId) || !isUuid(input.parentId) || typeof input.body !== "string") return null;
      return { id, type: "reply", ...viewer, threadId: input.threadId, parentId: input.parentId, body: input.body };
    case "like":
      if (!isUuid(input.threadId) || !isUuid(input.postId) || typeof input.on !== "boolean") return null;
      return { id, type: "like", ...viewer, threadId: input.threadId, postId: input.postId, on: input.on };
    case "repost":
      if (!isUuid(input.threadId) || !isCanonicalLocation(input.location)) return null;
      if (locationToScopeCell(input.location, viewer.scope) !== viewer.cell) return null;
      return { id, type: "repost", ...viewer, threadId: input.threadId, location: input.location };
    default:
      return null;
  }
}

function parseViewer(input: Record<string, unknown>): ViewerFields | null {
  if (!isProximityScope(input.scope) || !isScopeCell(input.cell, input.scope) || !isRoomTag(input.room)) return null;
  return { cell: input.cell, scope: input.scope, room: input.room };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/protocol-feed.test.ts && npm test && npm run typecheck`
Expected: all pass. (The legacy chat client and worker still compile because their types are untouched.)

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/index.ts tests/protocol-feed.test.ts
git commit -F - <<'EOF'
feat(protocol): add feed request/response types and action validation

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---

### Task 5: Signed access tokens

**Files:**
- Create: `packages/shared/session-token.ts`
- Test: `tests/session-token.test.ts`

**Interfaces:**
- Consumes: `bytesToBase64url`, `base64urlToBytes` from `packages/shared/encoding.ts`.
- Produces:
  - `interface AccessPayload { uid: string; author: string; sid: string; exp: number }`
  - `signAccessToken(payload: AccessPayload, secret: string): Promise<string>`
  - `verifyAccessToken(token: string, secret: string, now: number): Promise<AccessPayload | null>`

- [ ] **Step 1: Write the failing test**

Create `tests/session-token.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { signAccessToken, verifyAccessToken } from "../packages/shared/session-token.ts";

const payload = { uid: "user-1", author: "abcd1234", sid: "0123456789abcdef", exp: 10_000 };

describe("access tokens", () => {
  it("round-trips a payload before expiry", async () => {
    const token = await signAccessToken(payload, "secret");
    expect(await verifyAccessToken(token, "secret", 9_999)).toEqual(payload);
  });

  it("rejects expired, tampered, re-keyed and malformed tokens", async () => {
    const token = await signAccessToken(payload, "secret");
    expect(await verifyAccessToken(token, "secret", 10_000)).toBeNull();
    expect(await verifyAccessToken(token, "other", 1)).toBeNull();
    const [body, signature] = token.split(".");
    const forged = btoa(JSON.stringify({ ...payload, uid: "admin" })).replaceAll("=", "");
    expect(await verifyAccessToken(`${forged}.${signature}`, "secret", 1)).toBeNull();
    expect(await verifyAccessToken(`${body}`, "secret", 1)).toBeNull();
    expect(await verifyAccessToken(`${token}.extra`, "secret", 1)).toBeNull();
    expect(await verifyAccessToken("!!!.???", "secret", 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/session-token.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `packages/shared/session-token.ts`:

```ts
import { base64urlToBytes, bytesToBase64url } from "./encoding.ts";

export interface AccessPayload {
  uid: string;
  author: string;
  sid: string;
  exp: number;
}

const encoder = new TextEncoder();

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** `base64url(json) "." base64url(HMAC-SHA256(secret, base64url(json)))` — verifiable with no storage access. */
export async function signAccessToken(payload: AccessPayload, secret: string): Promise<string> {
  const body = bytesToBase64url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body)));
  return `${body}.${bytesToBase64url(signature)}`;
}

export async function verifyAccessToken(token: string, secret: string, now: number): Promise<AccessPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts as [string, string];
  try {
    // crypto.subtle.verify compares in constant time.
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      new Uint8Array(base64urlToBytes(signature)),
      encoder.encode(body),
    );
    if (!valid) return null;
    const payload: unknown = JSON.parse(new TextDecoder().decode(base64urlToBytes(body)));
    return isPayload(payload) && payload.exp > now ? payload : null;
  } catch {
    return null;
  }
}

function isPayload(value: unknown): value is AccessPayload {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<AccessPayload>;
  return typeof item.uid === "string" && typeof item.author === "string"
    && typeof item.sid === "string" && typeof item.exp === "number";
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/session-token.test.ts && npm run typecheck`
Expected: 2 tests pass; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/session-token.ts tests/session-token.test.ts
git commit -F - <<'EOF'
feat(auth): add HMAC-signed access tokens

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---

### Task 6: Partition lookup, splitting and merging decisions

**Files:**
- Create: `packages/feed/partition.ts`
- Test: `tests/partition.test.ts`

**Interfaces:**
- Consumes: `parentAt`, `resolutionOf` from `packages/geo`; partition constants.
- Produces:
  - `interface SplitEntry { splitAt: number; mergedAt?: number }`
  - `interface PartitionMap { splits: Record<string, SplitEntry> }`
  - `EMPTY_PARTITION_MAP: PartitionMap`
  - `interface PartitionLookup { write: string; read: string[] }`
  - `partitionFor(cell: string, map: PartitionMap, now: number): PartitionLookup`
  - `regionPartitions(cells: readonly string[], map: PartitionMap, now: number): string[]`
  - `interface LoadSample { minute: number; writes: number; reads: number }`
  - `minuteOf(now: number): number`
  - `shouldSplit(samples: readonly LoadSample[], currentMinute: number, resolution: number): boolean`
  - `isQuiet(samples: readonly LoadSample[], currentMinute: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/partition.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { latLngToCanonicalLocation, parentAt, regionCells, locationToScopeCell } from "../packages/geo/index.ts";
import {
  EMPTY_PARTITION_MAP,
  isQuiet,
  minuteOf,
  partitionFor,
  regionPartitions,
  shouldSplit,
  type LoadSample,
} from "../packages/feed/partition.ts";
import { PARTITION_DUAL_READ_MS, SPLIT_WRITES_PER_MINUTE, SPLIT_READS_PER_MINUTE } from "../packages/shared/constants.ts";

const london = latLngToCanonicalLocation(51.5074, -0.1278);
const r7 = parentAt(london, 7);
const r8 = parentAt(london, 8);
const r9 = parentAt(london, 9);

describe("partition lookup", () => {
  it("defaults to the resolution-7 parent", () => {
    expect(partitionFor(london, EMPTY_PARTITION_MAP, 0)).toEqual({ write: r7, read: [r7] });
  });

  it("descends through settled splits", () => {
    const map = { splits: { [r7]: { splitAt: 0 } } };
    expect(partitionFor(london, map, PARTITION_DUAL_READ_MS)).toEqual({ write: r8, read: [r8] });
  });

  it("reads the old partition too while it drains", () => {
    const map = { splits: { [r7]: { splitAt: 1_000 } } };
    const lookup = partitionFor(london, map, 2_000);
    expect(lookup.write).toBe(r8);
    expect(lookup.read.sort()).toEqual([r7, r8].sort());
  });

  it("never descends past resolution 9 or below the cell itself", () => {
    const map = { splits: { [r7]: { splitAt: 0 }, [r8]: { splitAt: 0 }, [r9]: { splitAt: 0 } } };
    expect(partitionFor(london, map, PARTITION_DUAL_READ_MS).write).toBe(r9);
    expect(partitionFor(r8, map, PARTITION_DUAL_READ_MS).write).toBe(r8);
  });

  it("writes to the parent after a merge and keeps reading the drained child", () => {
    const map = { splits: { [r7]: { splitAt: 0, mergedAt: 5_000 } } };
    const during = partitionFor(london, map, 6_000);
    expect(during.write).toBe(r7);
    expect(during.read.sort()).toEqual([r7, r8].sort());
    expect(partitionFor(london, map, 5_000 + PARTITION_DUAL_READ_MS)).toEqual({ write: r7, read: [r7] });
  });

  it("collects the distinct partitions behind a region", () => {
    const region = regionCells(locationToScopeCell(london, 11));
    const partitions = regionPartitions(region, EMPTY_PARTITION_MAP, 0);
    expect(partitions.length).toBeGreaterThanOrEqual(1);
    expect(partitions.length).toBeLessThanOrEqual(7);
    expect(partitions).toContain(r7);
    expect(new Set(partitions).size).toBe(partitions.length);
  });
});

describe("split and merge decisions", () => {
  const busy = (minute: number): LoadSample => ({ minute, writes: SPLIT_WRITES_PER_MINUTE + 1, reads: 0 });
  const quiet = (minute: number): LoadSample => ({ minute, writes: 1, reads: 1 });

  it("splits only after five busy minutes in a row below resolution 9", () => {
    const now = minuteOf(10 * 60_000);
    const fiveBusy = [5, 6, 7, 8, 9].map(busy);
    expect(shouldSplit(fiveBusy, now, 7)).toBe(true);
    expect(shouldSplit(fiveBusy, now, 9)).toBe(false);
    expect(shouldSplit([5, 6, 8, 9].map(busy), now, 7)).toBe(false);
    expect(shouldSplit([5, 6, 7, 8, 9].map((m) => ({ minute: m, writes: 0, reads: SPLIT_READS_PER_MINUTE + 1 })), now, 7)).toBe(true);
  });

  it("is quiet when every one of the last 30 minutes stayed under a quarter of both thresholds", () => {
    const now = 100;
    const samples = Array.from({ length: 30 }, (_, i) => quiet(70 + i));
    expect(isQuiet(samples, now)).toBe(true);
    expect(isQuiet([], now)).toBe(true);
    expect(isQuiet([...samples, { minute: 99, writes: SPLIT_WRITES_PER_MINUTE, reads: 0 }], now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/partition.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `packages/feed/partition.ts`:

```ts
import { parentAt, resolutionOf } from "../geo/index.ts";
import {
  MERGE_QUIET_MINUTES,
  PARTITION_BASE_RESOLUTION,
  PARTITION_DUAL_READ_MS,
  PARTITION_MAX_RESOLUTION,
  SPLIT_READS_PER_MINUTE,
  SPLIT_SUSTAINED_MINUTES,
  SPLIT_WRITES_PER_MINUTE,
} from "../shared/constants.ts";

export interface SplitEntry {
  splitAt: number;
  mergedAt?: number;
}

/** Cells listed here are split into their children. Everything else is served at the base resolution. */
export interface PartitionMap {
  splits: Record<string, SplitEntry>;
}

export const EMPTY_PARTITION_MAP: PartitionMap = { splits: {} };

export interface PartitionLookup {
  /** Where new refs for this cell go. */
  write: string;
  /** Where refs for this cell may currently live (the write partition plus any still draining). */
  read: string[];
}

/**
 * Walks down from the base resolution through split cells. Because every ref expires within
 * 15 minutes of its last update, repartitioning needs no migration: during the dual-read window
 * readers also read the partition being drained, and writers use only the new one.
 */
export function partitionFor(cell: string, map: PartitionMap, now: number): PartitionLookup {
  const cellResolution = resolutionOf(cell);
  let current = parentAt(cell, PARTITION_BASE_RESOLUTION);
  const read = new Set<string>();
  while (resolutionOf(current) < PARTITION_MAX_RESOLUTION && resolutionOf(current) < cellResolution) {
    const entry = map.splits[current];
    if (!entry) break;
    const child = parentAt(cell, resolutionOf(current) + 1);
    if (entry.mergedAt !== undefined && entry.mergedAt <= now) {
      if (now - entry.mergedAt < PARTITION_DUAL_READ_MS) read.add(child);
      break;
    }
    if (now - entry.splitAt < PARTITION_DUAL_READ_MS) read.add(current);
    current = child;
  }
  read.add(current);
  return { write: current, read: [...read] };
}

export function regionPartitions(cells: readonly string[], map: PartitionMap, now: number): string[] {
  const partitions = new Set<string>();
  for (const cell of cells) for (const partition of partitionFor(cell, map, now).read) partitions.add(partition);
  return [...partitions];
}

export interface LoadSample {
  minute: number;
  writes: number;
  reads: number;
}

export function minuteOf(now: number): number {
  return Math.floor(now / 60_000);
}

/** True after SPLIT_SUSTAINED_MINUTES consecutive full minutes above either threshold. */
export function shouldSplit(samples: readonly LoadSample[], currentMinute: number, resolution: number): boolean {
  if (resolution >= PARTITION_MAX_RESOLUTION) return false;
  const byMinute = new Map(samples.map((sample) => [sample.minute, sample]));
  for (let minute = currentMinute - SPLIT_SUSTAINED_MINUTES; minute < currentMinute; minute += 1) {
    const sample = byMinute.get(minute);
    if (!sample || (sample.writes <= SPLIT_WRITES_PER_MINUTE && sample.reads <= SPLIT_READS_PER_MINUTE)) return false;
  }
  return true;
}

/** True when each of the last MERGE_QUIET_MINUTES full minutes stayed under a quarter of both thresholds. */
export function isQuiet(samples: readonly LoadSample[], currentMinute: number): boolean {
  return samples.every((sample) =>
    sample.minute < currentMinute - MERGE_QUIET_MINUTES
    || sample.minute >= currentMinute
    || (sample.writes <= SPLIT_WRITES_PER_MINUTE / 4 && sample.reads <= SPLIT_READS_PER_MINUTE / 4));
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/partition.test.ts && npm run typecheck`
Expected: 8 tests pass; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/feed/partition.ts tests/partition.test.ts
git commit -F - <<'EOF'
feat(feed): add adaptive partition lookup and split/merge decisions

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---

### Task 7: Merging partition results into feed pages

**Files:**
- Create: `packages/feed/order.ts`
- Test: `tests/order.test.ts`

**Interfaces:**
- Consumes: `FeedTab` (Task 4); `FEED_PAGE_SIZE`, `PARTITION_QUERY_LIMIT`.
- Produces:
  - `interface RefRecord { threadId: string; anchorAt: number; kind: "root" | "repost"; byAuthor: string; cell11: string; roomTag: string; expiresAt: number; score: number; scoreAt: number; trendKey: number; participantCount: number }`
  - `interface Cursor { key: number; threadId: string }`
  - `sortKey(ref: RefRecord, tab: FeedTab): number`
  - `encodeCursor(cursor: Cursor): string`, `decodeCursor(value: string | null | undefined): Cursor | null`
  - `compareRefs(a: RefRecord, b: RefRecord, tab: FeedTab): number` (descending)
  - `interface MergedPage { refs: RefRecord[]; nextCursor: string | null }`
  - `mergePage(lists: readonly (readonly RefRecord[])[], tab: FeedTab, limit?: number, partitionLimit?: number): MergedPage`

- [ ] **Step 1: Write the failing test**

Create `tests/order.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { compareRefs, decodeCursor, encodeCursor, mergePage, type RefRecord } from "../packages/feed/order.ts";

function ref(threadId: string, anchorAt: number, trendKey = 0, extra: Partial<RefRecord> = {}): RefRecord {
  return {
    threadId, anchorAt, kind: "root", byAuthor: "abcd1234", cell11: "8b195da49b48fff", roomTag: "",
    expiresAt: 10_000, score: 1, scoreAt: 0, trendKey, participantCount: 2, ...extra,
  };
}

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

describe("feed page merging", () => {
  it("keeps each thread once, through its newest anchor", () => {
    const page = mergePage([[ref(id(1), 100)], [ref(id(1), 300, 0, { kind: "repost", byAuthor: "ffff0000" })]], "latest");
    expect(page.refs).toHaveLength(1);
    expect(page.refs[0]!.anchorAt).toBe(300);
    expect(page.refs[0]!.kind).toBe("repost");
  });

  it("orders Latest by anchor time and Trending by trend key, newest id first on ties", () => {
    const refs = [ref(id(1), 100, 5), ref(id(2), 300, 1), ref(id(3), 300, 9)];
    expect(mergePage([refs], "latest").refs.map((r) => r.threadId)).toEqual([id(3), id(2), id(1)]);
    expect(mergePage([refs], "trending").refs.map((r) => r.threadId)).toEqual([id(3), id(1), id(2)]);
    expect(compareRefs(refs[1]!, refs[2]!, "latest")).toBeGreaterThan(0);
  });

  it("uses the highest trend key a thread has in any partition", () => {
    const page = mergePage([[ref(id(1), 100, 2)], [ref(id(1), 50, 7)]], "trending");
    expect(page.refs[0]!.trendKey).toBe(7);
    expect(page.refs[0]!.anchorAt).toBe(100);
  });

  it("emits a cursor only when more may exist", () => {
    const many = Array.from({ length: 5 }, (_, i) => ref(id(i + 1), 1_000 - i));
    expect(mergePage([many], "latest", 3).nextCursor).toBe(encodeCursor({ key: 998, threadId: id(3) }));
    expect(mergePage([many.slice(0, 2)], "latest", 3).nextCursor).toBeNull();
    expect(mergePage([many.slice(0, 2)], "latest", 3, 2).nextCursor).not.toBeNull();
  });

  it("round-trips cursors and rejects junk", () => {
    const cursor = { key: -12.5e3, threadId: id(4) };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    for (const junk of [null, undefined, "", "abc", "12~nope", "~" + id(1), "NaN~" + id(1)]) {
      expect(decodeCursor(junk)).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/order.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `packages/feed/order.ts`:

```ts
import type { FeedTab } from "../protocol/index.ts";
import { FEED_PAGE_SIZE, PARTITION_QUERY_LIMIT } from "../shared/constants.ts";

/** One anchor of one thread, as a cell index stores it. Ordering data only, never post text. */
export interface RefRecord {
  threadId: string;
  anchorAt: number;
  kind: "root" | "repost";
  byAuthor: string;
  cell11: string;
  roomTag: string;
  expiresAt: number;
  score: number;
  scoreAt: number;
  trendKey: number;
  participantCount: number;
}

export interface Cursor {
  key: number;
  threadId: string;
}

export function sortKey(ref: RefRecord, tab: FeedTab): number {
  return tab === "latest" ? ref.anchorAt : ref.trendKey;
}

export function encodeCursor(cursor: Cursor): string {
  return `${cursor.key}~${cursor.threadId}`;
}

export function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  const split = value.lastIndexOf("~");
  if (split <= 0) return null;
  const key = Number(value.slice(0, split));
  const threadId = value.slice(split + 1);
  return Number.isFinite(key) && /^[0-9a-f-]{36}$/u.test(threadId) ? { key, threadId } : null;
}

/** Descending by the tab's key, then by thread id (newest UUIDv7 first). */
export function compareRefs(a: RefRecord, b: RefRecord, tab: FeedTab): number {
  return sortKey(b, tab) - sortKey(a, tab) || (a.threadId < b.threadId ? 1 : a.threadId > b.threadId ? -1 : 0);
}

export interface MergedPage {
  refs: RefRecord[];
  nextCursor: string | null;
}

/**
 * Merges per-partition results. Each thread appears once, through its newest visible anchor; for
 * Trending it carries the freshest (highest) trend key any partition holds for it.
 */
export function mergePage(
  lists: readonly (readonly RefRecord[])[],
  tab: FeedTab,
  limit = FEED_PAGE_SIZE,
  partitionLimit = PARTITION_QUERY_LIMIT,
): MergedPage {
  const best = new Map<string, RefRecord>();
  for (const list of lists) {
    for (const ref of list) {
      const existing = best.get(ref.threadId);
      if (!existing) {
        best.set(ref.threadId, ref);
        continue;
      }
      const newest = ref.anchorAt > existing.anchorAt ? ref : existing;
      best.set(ref.threadId, { ...newest, trendKey: Math.max(ref.trendKey, existing.trendKey) });
    }
  }
  const sorted = [...best.values()].sort((a, b) => compareRefs(a, b, tab));
  const refs = sorted.slice(0, limit);
  const more = sorted.length > limit || lists.some((list) => list.length >= partitionLimit);
  const last = refs.at(-1);
  return { refs, nextCursor: more && last ? encodeCursor({ key: sortKey(last, tab), threadId: last.threadId }) : null };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/order.test.ts && npm run typecheck`
Expected: 5 tests pass; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/feed/order.ts tests/order.test.ts
git commit -F - <<'EOF'
feat(feed): merge partition results into ordered, paginated feed pages

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---
### Task 8: SQL runner, queue event types and the thread store database

**Files:**
- Create: `workers/edge/stores/sql.ts`, `workers/edge/stores/outcome.ts`, `workers/edge/events.ts`, `workers/edge/stores/thread-db.ts`
- Create: `tests/support/memory-sql.ts`
- Test: `tests/thread-db.test.ts`

**Interfaces:**
- Consumes: `addEngagement`, `replyEngagement` (Task 1); `deletionOutcome`, `DeletionOutcome` (Task 3); `PostView`, `ThreadSummary`, `ErrorCode` (Task 4); `uuidv7`.
- Produces:
  - `type SqlValue = string | number | null`; `interface SqlRunner { exec<T extends object = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): { toArray(): T[] } }`; `durableSql(sql: SqlStorage): SqlRunner`; `runAll(sql: SqlRunner, statements: readonly string[]): void`
  - `type Outcome<T> = ({ ok: true } & T) | { ok: false; code: ErrorCode }`; `fail(code: ErrorCode): { ok: false; code: ErrorCode }`
  - Event types: `RefPayload`, `ThreadLikedEvent`, `ThreadRepostedEvent`, `RefAddedEvent`, `ThreadUpdatedEvent`, `ThreadExpiredEvent`, `ThreadEvent`, `CellEvent`, `FeedEvent`
  - `interface Actor { userId: string; author: string }`
  - `interface Result<T> { outcome: Outcome<T>; events: CellEvent[] }`
  - `CreateThreadInput`, `ReplyInput`, `RemoveInput`
  - `class ThreadDb` with `init()`, `create(input): Result<{ summary }>`, `reply(input): Result<{ post; summary }>`, `remove(input): Result<{ outcome: DeletionOutcome }>`, `applyLikes(events, now): CellEvent[]`, `applyReposts(events, now): CellEvent[]`, `summary(now): Outcome<{ summary }>`, `thread(now): Outcome<{ summary; posts }>`, `expiresAt(): number | null`, `expireIfDue(now): CellEvent[] | null`
  - Test helper `memorySql(): SqlRunner`

- [ ] **Step 1: Create the SQL runner and outcome helper**

Create `workers/edge/stores/sql.ts`:

```ts
export type SqlValue = string | number | null;

/**
 * The slice of Durable Object SQLite the stores use. Tests implement it over node:sqlite,
 * so every query is exercised against a real SQLite engine.
 */
export interface SqlRunner {
  exec<T extends object = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): { toArray(): T[] };
}

export function durableSql(sql: SqlStorage): SqlRunner {
  return {
    exec<T extends object>(query: string, ...bindings: SqlValue[]) {
      return sql.exec(query, ...bindings) as unknown as { toArray(): T[] };
    },
  };
}

/** One statement per call: node:sqlite prepares a single statement at a time. */
export function runAll(sql: SqlRunner, statements: readonly string[]): void {
  for (const statement of statements) sql.exec(statement);
}
```

Create `workers/edge/stores/outcome.ts`:

```ts
import type { ErrorCode } from "../../../packages/protocol/index.ts";

export type Outcome<T> = ({ ok: true } & T) | { ok: false; code: ErrorCode };

export function fail(code: ErrorCode): { ok: false; code: ErrorCode } {
  return { ok: false, code };
}
```

- [ ] **Step 2: Create the queue event types**

Create `workers/edge/events.ts`:

```ts
/** What a cell index needs to place and order one anchor of a thread. */
export interface RefPayload {
  threadId: string;
  anchorAt: number;
  kind: "root" | "repost";
  byAuthor: string;
  location: string;
  roomTag: string;
  expiresAt: number;
  score: number;
  scoreAt: number;
  participantCount: number;
}

export interface ThreadLikedEvent {
  eventId: string;
  type: "thread.liked";
  threadId: string;
  postId: string;
  userId: string;
  delta: 1 | -1;
  /** True on this user's first like anywhere in the thread: only then does it score. */
  first: boolean;
  at: number;
}

export interface ThreadRepostedEvent {
  eventId: string;
  type: "thread.reposted";
  threadId: string;
  userId: string;
  first: boolean;
  location: string;
  partition: string;
  byAuthor: string;
  at: number;
}

export interface RefAddedEvent {
  eventId: string;
  type: "ref.added";
  partition: string;
  ref: RefPayload;
}

export interface ThreadUpdatedEvent {
  eventId: string;
  type: "thread.updated";
  partition: string;
  threadId: string;
  expiresAt: number;
  score: number;
  scoreAt: number;
  participantCount: number;
}

export interface ThreadExpiredEvent {
  eventId: string;
  type: "thread.expired";
  partition: string;
  threadId: string;
  at: number;
}

export type ThreadEvent = ThreadLikedEvent | ThreadRepostedEvent;
export type CellEvent = RefAddedEvent | ThreadUpdatedEvent | ThreadExpiredEvent;
export type FeedEvent = ThreadEvent | CellEvent;
```

- [ ] **Step 3: Create the in-memory SQLite helper for tests**

Create `tests/support/memory-sql.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import type { SqlRunner, SqlValue } from "../../workers/edge/stores/sql.ts";

/** A SqlRunner over an in-memory node:sqlite database, matching Durable Object SQLite semantics. */
export function memorySql(): SqlRunner {
  const db = new DatabaseSync(":memory:");
  return {
    exec<T extends object>(query: string, ...bindings: SqlValue[]) {
      const statement = db.prepare(query);
      const returnsRows = /^\s*(select|with)\b/iu.test(query) || /\breturning\b/iu.test(query);
      if (returnsRows) {
        const rows = statement.all(...bindings) as T[];
        return { toArray: () => rows };
      }
      statement.run(...bindings);
      return { toArray: () => [] as T[] };
    },
  };
}
```

- [ ] **Step 4: Write the failing test**

Create `tests/thread-db.test.ts`:

```ts
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
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run tests/thread-db.test.ts`
Expected: FAIL, cannot load `../workers/edge/stores/thread-db.ts`.

- [ ] **Step 6: Implement the thread store database**

Create `workers/edge/stores/thread-db.ts`:

```ts
import { addEngagement, replyEngagement } from "../../../packages/feed/score.ts";
import { deletionOutcome, type DeletionOutcome } from "../../../packages/feed/tree.ts";
import type { ErrorCode, PostView, ThreadSummary } from "../../../packages/protocol/index.ts";
import {
  EVENT_RETENTION_MS,
  MAX_POSTS_PER_THREAD,
  THREAD_TTL_MS,
  type EngagementKind,
} from "../../../packages/shared/constants.ts";
import { uuidv7 } from "../../../packages/shared/uuid.ts";
import type { CellEvent, ThreadLikedEvent, ThreadRepostedEvent } from "../events.ts";
import { fail, type Outcome } from "./outcome.ts";
import { runAll, type SqlRunner } from "./sql.ts";

export interface Actor {
  userId: string;
  author: string;
}

export interface Result<T> {
  outcome: Outcome<T>;
  events: CellEvent[];
}

export interface CreateThreadInput {
  id: string;
  actor: Actor;
  roomTag: string;
  location: string;
  partition: string;
  body: string;
  now: number;
}

export interface ReplyInput {
  postId: string;
  parentId: string;
  actor: Actor;
  body: string;
  now: number;
}

export interface RemoveInput {
  postId: string;
  actor: Actor;
  now: number;
}

interface AnchorInput {
  anchorAt: number;
  kind: "root" | "repost";
  byAuthor: string;
  location: string;
}

interface ThreadRow {
  id: string;
  room_tag: string;
  author: string;
  author_user_id: string;
  root_location: string;
  created_at: number;
  last_activity_at: number;
  expires_at: number;
  score: number;
  score_at: number;
  reply_count: number;
  repost_count: number;
  participant_count: number;
  version: number;
}

interface PostRow {
  id: string;
  parent_id: string | null;
  author: string;
  author_user_id: string;
  body: string;
  created_at: number;
  deleted: number;
  like_count: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS thread (
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
    version INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    author TEXT NOT NULL,
    author_user_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    like_count INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE TABLE IF NOT EXISTS participants (user_id TEXT PRIMARY KEY)",
  "CREATE TABLE IF NOT EXISTS repliers (user_id TEXT PRIMARY KEY)",
  "CREATE TABLE IF NOT EXISTS reply_engagements (user_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (user_id, kind))",
  "CREATE TABLE IF NOT EXISTS ref_partitions (partition TEXT PRIMARY KEY)",
  "CREATE TABLE IF NOT EXISTS applied_events (event_id TEXT PRIMARY KEY, at INTEGER NOT NULL)",
];

const TABLES = ["thread", "posts", "participants", "repliers", "reply_engagements", "ref_partitions", "applied_events"];

/**
 * One thread: the single source of truth for its posts, counts, score and expiry.
 * Every change that other components care about comes back as cell events for the queue.
 */
export class ThreadDb {
  constructor(private readonly sql: SqlRunner) {}

  init(): void {
    runAll(this.sql, SCHEMA);
  }

  create(input: CreateThreadInput): Result<{ summary: ThreadSummary }> {
    const { id, actor, roomTag, location, partition, body, now } = input;
    if (this.row()) return { outcome: fail("BAD_REQUEST"), events: [] };
    this.sql.exec(
      `INSERT INTO thread (id, room_tag, author, author_user_id, root_location, created_at, last_activity_at, expires_at,
         score, score_at, reply_count, repost_count, participant_count, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 1, 1)`,
      id, roomTag, actor.author, actor.userId, location, now, now, now + THREAD_TTL_MS, now,
    );
    this.sql.exec(
      "INSERT INTO posts (id, parent_id, author, author_user_id, body, created_at) VALUES (?, NULL, ?, ?, ?, ?)",
      id, actor.author, actor.userId, body, now,
    );
    this.sql.exec("INSERT INTO participants (user_id) VALUES (?)", actor.userId);
    const summary = this.requireSummary();
    const root: AnchorInput = { anchorAt: now, kind: "root", byAuthor: actor.author, location };
    return { outcome: { ok: true, summary }, events: [this.refAdded(partition, root, summary)] };
  }

  reply(input: ReplyInput): Result<{ post: PostView; summary: ThreadSummary }> {
    const live = this.live(input.now);
    if (!live.ok) return { outcome: live, events: [] };
    if (!this.post(input.parentId)) return { outcome: fail("PARENT_NOT_FOUND"), events: [] };
    if (this.count("SELECT COUNT(*) AS n FROM posts") >= MAX_POSTS_PER_THREAD) {
      return { outcome: fail("THREAD_FULL"), events: [] };
    }
    const { actor, now } = input;
    const isAuthor = actor.userId === live.row.author_user_id;
    const othersHaveReplied = this.count("SELECT COUNT(*) AS n FROM repliers") > 0;
    this.sql.exec(
      "INSERT INTO posts (id, parent_id, author, author_user_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      input.postId, input.parentId, actor.author, actor.userId, input.body, now,
    );
    this.sql.exec("UPDATE thread SET reply_count = reply_count + 1");
    if (!isAuthor) this.sql.exec("INSERT INTO repliers (user_id) VALUES (?) ON CONFLICT DO NOTHING", actor.userId);
    const kind = replyEngagement(isAuthor, othersHaveReplied);
    const firstOfKind = kind !== null && this.sql.exec(
      "INSERT INTO reply_engagements (user_id, kind) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING kind",
      actor.userId, kind,
    ).toArray().length > 0;
    this.engage(actor.userId, firstOfKind ? kind : null, now);
    this.touch(now);
    this.bump();
    const summary = this.requireSummary();
    const post = this.postView(this.post(input.postId)!, summary.id);
    return { outcome: { ok: true, post, summary }, events: this.updatedEvents(summary) };
  }

  remove(input: RemoveInput): Result<{ outcome: DeletionOutcome }> {
    const row = this.row();
    if (!row) return { outcome: fail("THREAD_NOT_FOUND"), events: [] };
    if (row.expires_at <= input.now) return { outcome: fail("THREAD_EXPIRED"), events: [] };
    const target = this.post(input.postId);
    if (!target || target.deleted === 1) return { outcome: fail("POST_NOT_FOUND"), events: [] };
    if (target.author_user_id !== input.actor.userId) return { outcome: fail("NOT_AUTHOR"), events: [] };
    const posts = this.sql.exec<{ id: string; parentId: string | null }>("SELECT id, parent_id AS parentId FROM posts").toArray();
    const outcome = deletionOutcome(posts, input.postId)!;
    if (outcome === "remove_thread") {
      const events = this.expiredEvents(input.now);
      this.clear();
      return { outcome: { ok: true, outcome }, events };
    }
    if (outcome === "remove") {
      this.sql.exec("DELETE FROM posts WHERE id = ?", input.postId);
      this.sql.exec("UPDATE thread SET reply_count = reply_count - 1");
    } else {
      this.sql.exec("UPDATE posts SET body = '', deleted = 1, like_count = 0 WHERE id = ?", input.postId);
    }
    this.bump();
    return { outcome: { ok: true, outcome }, events: this.updatedEvents(this.requireSummary()) };
  }

  applyLikes(events: readonly ThreadLikedEvent[], now: number): CellEvent[] {
    const row = this.row();
    if (!row || row.expires_at <= now) return [];
    let changed = false;
    let lastActivity: number | null = null;
    for (const event of events) {
      if (!this.markApplied(event.eventId, now)) continue;
      const target = this.post(event.postId);
      if (!target || target.deleted === 1) continue;
      // Stored raw so an unlike delivered before its like still sums correctly; clamped when displayed.
      this.sql.exec("UPDATE posts SET like_count = like_count + ? WHERE id = ?", event.delta, event.postId);
      changed = true;
      if (event.delta > 0) {
        this.engage(event.userId, event.first ? "like" : null, event.at);
        lastActivity = Math.max(lastActivity ?? 0, event.at);
      }
    }
    if (!changed) return [];
    if (lastActivity !== null) this.touch(lastActivity);
    this.bump();
    return this.updatedEvents(this.requireSummary());
  }

  applyReposts(events: readonly ThreadRepostedEvent[], now: number): CellEvent[] {
    const row = this.row();
    if (!row || row.expires_at <= now) return [];
    const anchors: { partition: string; anchor: AnchorInput }[] = [];
    for (const event of events) {
      if (!this.markApplied(event.eventId, now)) continue;
      this.sql.exec("UPDATE thread SET repost_count = repost_count + 1");
      this.engage(event.userId, event.first ? "repost" : null, event.at);
      this.touch(event.at);
      anchors.push({
        partition: event.partition,
        anchor: { anchorAt: event.at, kind: "repost", byAuthor: event.byAuthor, location: event.location },
      });
    }
    if (anchors.length === 0) return [];
    this.bump();
    const summary = this.requireSummary();
    const added = anchors.map(({ partition, anchor }) => this.refAdded(partition, anchor, summary));
    return [...added, ...this.updatedEvents(summary)];
  }

  summary(now: number): Outcome<{ summary: ThreadSummary }> {
    const live = this.live(now);
    return live.ok ? { ok: true, summary: this.summaryOf(live.row) } : live;
  }

  thread(now: number): Outcome<{ summary: ThreadSummary; posts: PostView[] }> {
    const live = this.live(now);
    if (!live.ok) return live;
    const rows = this.sql.exec<PostRow>("SELECT * FROM posts ORDER BY created_at, id").toArray();
    return { ok: true, summary: this.summaryOf(live.row), posts: rows.map((row) => this.postView(row, live.row.id)) };
  }

  expiresAt(): number | null {
    return this.row()?.expires_at ?? null;
  }

  /** Returns the expiry events and empties the store when the thread is due; null otherwise. */
  expireIfDue(now: number): CellEvent[] | null {
    const row = this.row();
    if (!row || row.expires_at > now) return null;
    const events = this.expiredEvents(now);
    this.clear();
    return events;
  }

  private live(now: number): { ok: true; row: ThreadRow } | { ok: false; code: ErrorCode } {
    const row = this.row();
    if (!row) return fail("THREAD_NOT_FOUND");
    if (row.expires_at <= now) return fail("THREAD_EXPIRED");
    return { ok: true, row };
  }

  private row(): ThreadRow | null {
    return this.sql.exec<ThreadRow>("SELECT * FROM thread LIMIT 1").toArray()[0] ?? null;
  }

  private requireSummary(): ThreadSummary {
    return this.summaryOf(this.row()!);
  }

  private post(id: string): PostRow | null {
    return this.sql.exec<PostRow>("SELECT * FROM posts WHERE id = ?", id).toArray()[0] ?? null;
  }

  private count(query: string): number {
    return Number(this.sql.exec<{ n: number }>(query).toArray()[0]?.n ?? 0);
  }

  private engage(userId: string, kind: EngagementKind | null, at: number): void {
    const joined = this.sql.exec(
      "INSERT INTO participants (user_id) VALUES (?) ON CONFLICT DO NOTHING RETURNING user_id",
      userId,
    ).toArray().length > 0;
    if (joined) this.sql.exec("UPDATE thread SET participant_count = participant_count + 1");
    if (kind === null) return;
    const row = this.row()!;
    // Late events never move the score's clock backwards.
    const next = addEngagement({ value: row.score, at: row.score_at }, kind, Math.max(at, row.score_at));
    this.sql.exec("UPDATE thread SET score = ?, score_at = ?", next.value, next.at);
  }

  private touch(at: number): void {
    this.sql.exec(
      "UPDATE thread SET last_activity_at = MAX(last_activity_at, ?), expires_at = MAX(expires_at, ?)",
      at, at + THREAD_TTL_MS,
    );
  }

  private bump(): void {
    this.sql.exec("UPDATE thread SET version = version + 1");
  }

  private markApplied(eventId: string, now: number): boolean {
    this.sql.exec("DELETE FROM applied_events WHERE at < ?", now - EVENT_RETENTION_MS);
    return this.sql.exec(
      "INSERT INTO applied_events (event_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING event_id",
      eventId, now,
    ).toArray().length > 0;
  }

  private partitions(): string[] {
    return this.sql.exec<{ partition: string }>("SELECT partition FROM ref_partitions").toArray().map((row) => row.partition);
  }

  private refAdded(partition: string, anchor: AnchorInput, summary: ThreadSummary): CellEvent {
    this.sql.exec("INSERT INTO ref_partitions (partition) VALUES (?) ON CONFLICT DO NOTHING", partition);
    return {
      eventId: uuidv7(),
      type: "ref.added",
      partition,
      ref: {
        threadId: summary.id,
        ...anchor,
        roomTag: summary.roomTag,
        expiresAt: summary.expiresAt,
        score: summary.score,
        scoreAt: summary.scoreAt,
        participantCount: summary.participantCount,
      },
    };
  }

  private updatedEvents(summary: ThreadSummary): CellEvent[] {
    return this.partitions().map((partition): CellEvent => ({
      eventId: uuidv7(),
      type: "thread.updated",
      partition,
      threadId: summary.id,
      expiresAt: summary.expiresAt,
      score: summary.score,
      scoreAt: summary.scoreAt,
      participantCount: summary.participantCount,
    }));
  }

  private expiredEvents(now: number): CellEvent[] {
    const threadId = this.row()!.id;
    return this.partitions().map((partition): CellEvent => ({
      eventId: uuidv7(),
      type: "thread.expired",
      partition,
      threadId,
      at: now,
    }));
  }

  private clear(): void {
    for (const table of TABLES) this.sql.exec(`DELETE FROM ${table}`);
  }

  private summaryOf(row: ThreadRow): ThreadSummary {
    const root = this.postView(this.post(row.id)!, row.id);
    return {
      id: row.id,
      roomTag: row.room_tag,
      root,
      replyCount: row.reply_count,
      likeCount: root.likeCount,
      repostCount: row.repost_count,
      participantCount: row.participant_count,
      score: row.score,
      scoreAt: row.score_at,
      lastActivityAt: row.last_activity_at,
      expiresAt: row.expires_at,
      version: row.version,
    };
  }

  private postView(row: PostRow, threadId: string): PostView {
    return {
      id: row.id,
      threadId,
      parentId: row.parent_id,
      author: row.author,
      body: row.deleted === 1 ? "" : row.body,
      createdAt: row.created_at,
      deleted: row.deleted === 1,
      likeCount: Math.max(0, row.like_count),
    };
  }
}
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/thread-db.test.ts && npm run typecheck`
Expected: 9 tests pass (a Node `ExperimentalWarning` about SQLite is expected); typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add workers/edge/stores workers/edge/events.ts tests/support/memory-sql.ts tests/thread-db.test.ts
git commit -F - <<'EOF'
feat(store): add thread store database and queue event types

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---

### Task 9: Cell index database

**Files:**
- Create: `workers/edge/stores/cell-index-db.ts`
- Test: `tests/cell-index-db.test.ts`

**Interfaces:**
- Consumes: `refCells` (Task 2); `trendKey` (Task 1); `decodeCursor`, `encodeCursor`, `RefRecord` (Task 7); `minuteOf`, `LoadSample` (Task 6); `CellEvent` (Task 8); `SqlRunner`, `runAll`, `SqlValue` (Task 8).
- Produces:
  - `interface RefQuery { cells: readonly string[]; scope: ProximityScope; room: string; tab: FeedTab; cursor: string | null; limit: number; now: number }`
  - `interface HasRefQuery { threadId: string; cells: readonly string[]; scope: ProximityScope; room: string; now: number }`
  - `interface RefPage { refs: RefRecord[]; version: number }`
  - `class CellIndexDb` with `init()`, `apply(events, now)`, `query(q): RefPage`, `hasRef(q): boolean`, `sweep(now)`, `isEmpty(): boolean`, `loadSamples(): LoadSample[]`, `version(): number`, `partition(): string | null`, `setPartition(partition: string)`

- [ ] **Step 1: Write the failing test**

Create `tests/cell-index-db.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { encodeCursor } from "../packages/feed/order.ts";
import { latLngToCanonicalLocation, locationToScopeCell, regionCells } from "../packages/geo/index.ts";
import type { ProximityScope } from "../packages/shared/constants.ts";
import type { CellEvent, RefPayload } from "../workers/edge/events.ts";
import { CellIndexDb } from "../workers/edge/stores/cell-index-db.ts";
import { memorySql } from "./support/memory-sql.ts";

const london = latLngToCanonicalLocation(51.5074, -0.1278);
const paris = latLngToCanonicalLocation(48.8566, 2.3522);
const T = 1_000_000;
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
let counter = 0;
const eventId = () => `ev-${counter += 1}`;

function db() {
  const store = new CellIndexDb(memorySql());
  store.init();
  return store;
}

function added(threadId: string, extra: Partial<RefPayload> = {}): CellEvent {
  return {
    eventId: eventId(), type: "ref.added", partition: "p",
    ref: { threadId, anchorAt: T, kind: "root", byAuthor: "aaaa0001", location: london, roomTag: "", expiresAt: T + 900_000, score: 0, scoreAt: T, participantCount: 1, ...extra },
  };
}

function query(store: CellIndexDb, viewer: string, scope: ProximityScope, tab: "latest" | "trending" = "latest", extra = {}) {
  return store.query({ cells: regionCells(locationToScopeCell(viewer, scope)), scope, room: "", tab, cursor: null, limit: 60, now: T, ...extra });
}

describe("cell index", () => {
  it("finds refs by region at every scope, and only in the right room", () => {
    const store = db();
    store.apply([added(id(1))], T);
    for (const scope of [9, 10, 11] as const) {
      expect(query(store, london, scope).refs.map((ref) => ref.threadId)).toEqual([id(1)]);
      expect(query(store, paris, scope).refs).toEqual([]);
    }
    expect(query(store, london, 10, "latest", { room: "a".repeat(64) }).refs).toEqual([]);
    expect(query(store, london, 10).refs[0]).toMatchObject({ cell11: london, kind: "root", byAuthor: "aaaa0001" });
  });

  it("lists Trending by trend key and only with two or more participants", () => {
    const store = db();
    store.apply([
      added(id(1), { score: 5, participantCount: 1 }),
      added(id(2), { score: 3, participantCount: 2 }),
      added(id(3), { score: 9, participantCount: 3 }),
    ], T);
    expect(query(store, london, 10, "trending").refs.map((ref) => ref.threadId)).toEqual([id(3), id(2)]);
  });

  it("pages with keyset cursors", () => {
    const store = db();
    store.apply([1, 2, 3].map((n) => added(id(n), { anchorAt: T + n })), T);
    const first = query(store, london, 10, "latest", { limit: 2 }).refs;
    expect(first.map((ref) => ref.threadId)).toEqual([id(3), id(2)]);
    const cursor = encodeCursor({ key: first[1]!.anchorAt, threadId: first[1]!.threadId });
    expect(query(store, london, 10, "latest", { cursor }).refs.map((ref) => ref.threadId)).toEqual([id(1)]);
  });

  it("applies each event once and bumps the version on change", () => {
    const store = db();
    const event = added(id(1));
    store.apply([event], T);
    store.apply([event], T);
    expect(store.version()).toBe(1);
    expect(query(store, london, 10).refs).toHaveLength(1);
  });

  it("ignores stale score snapshots but always keeps the latest expiry", () => {
    const store = db();
    store.apply([added(id(1))], T);
    const update = (score: number, scoreAt: number, expiresAt: number): CellEvent => ({
      eventId: eventId(), type: "thread.updated", partition: "p", threadId: id(1), expiresAt, score, scoreAt, participantCount: 2,
    });
    store.apply([update(10, T + 100, T + 2_000_000)], T);
    store.apply([update(4, T + 50, T + 1_500_000)], T);
    const [ref] = query(store, london, 10).refs;
    expect(ref).toMatchObject({ score: 10, scoreAt: T + 100, expiresAt: T + 2_000_000, participantCount: 2 });
  });

  it("does not let late events resurrect an expired thread", () => {
    const store = db();
    store.apply([added(id(1))], T);
    store.apply([{ eventId: eventId(), type: "thread.expired", partition: "p", threadId: id(1), at: T }], T);
    store.apply([added(id(1), { anchorAt: T + 5 })], T);
    store.apply([{ eventId: eventId(), type: "thread.updated", partition: "p", threadId: id(1), expiresAt: T + 5_000_000, score: 1, scoreAt: T + 9, participantCount: 2 }], T);
    expect(query(store, london, 10).refs).toEqual([]);
  });

  it("answers visibility lookups", () => {
    const store = db();
    store.apply([added(id(1))], T);
    const region = (viewer: string) => regionCells(locationToScopeCell(viewer, 10));
    expect(store.hasRef({ threadId: id(1), cells: region(london), scope: 10, room: "", now: T })).toBe(true);
    expect(store.hasRef({ threadId: id(1), cells: region(paris), scope: 10, room: "", now: T })).toBe(false);
    expect(store.hasRef({ threadId: id(2), cells: region(london), scope: 10, room: "", now: T })).toBe(false);
  });

  it("hides expired refs immediately and sweeps them later", () => {
    const store = db();
    store.apply([added(id(1), { expiresAt: T + 10 })], T);
    expect(query(store, london, 10, "latest", { now: T + 10 }).refs).toEqual([]);
    expect(store.isEmpty()).toBe(false);
    store.sweep(T + 30 * 60_000);
    expect(store.isEmpty()).toBe(true);
  });

  it("records load per minute and remembers its partition", () => {
    const store = db();
    store.setPartition("p");
    store.setPartition("ignored");
    store.apply([added(id(1)), added(id(2))], T);
    query(store, london, 10);
    expect(store.partition()).toBe("p");
    expect(store.loadSamples()).toEqual([{ minute: Math.floor(T / 60_000), writes: 2, reads: 1 }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/cell-index-db.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `workers/edge/stores/cell-index-db.ts`:

```ts
import { decodeCursor, type RefRecord } from "../../../packages/feed/order.ts";
import { minuteOf, type LoadSample } from "../../../packages/feed/partition.ts";
import { trendKey } from "../../../packages/feed/score.ts";
import { refCells } from "../../../packages/geo/index.ts";
import type { FeedTab } from "../../../packages/protocol/index.ts";
import { EVENT_RETENTION_MS, TREND_MIN_PARTICIPANTS, type ProximityScope } from "../../../packages/shared/constants.ts";
import type { CellEvent } from "../events.ts";
import { runAll, type SqlRunner, type SqlValue } from "./sql.ts";

export interface RefQuery {
  cells: readonly string[];
  scope: ProximityScope;
  room: string;
  tab: FeedTab;
  cursor: string | null;
  limit: number;
  now: number;
}

export interface HasRefQuery {
  threadId: string;
  cells: readonly string[];
  scope: ProximityScope;
  room: string;
  now: number;
}

export interface RefPage {
  refs: RefRecord[];
  version: number;
}

interface RefRow {
  thread_id: string;
  anchor_at: number;
  anchor_kind: "root" | "repost";
  by_author: string;
  cell11: string;
  room_tag: string;
  expires_at: number;
  score: number;
  score_at: number;
  trend_key: number;
  participant_count: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS refs (
    thread_id TEXT NOT NULL,
    anchor_at INTEGER NOT NULL,
    anchor_kind TEXT NOT NULL,
    by_author TEXT NOT NULL,
    cell9 TEXT NOT NULL,
    cell10 TEXT NOT NULL,
    cell11 TEXT NOT NULL,
    room_tag TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    score REAL NOT NULL,
    score_at INTEGER NOT NULL,
    trend_key REAL NOT NULL,
    participant_count INTEGER NOT NULL,
    PRIMARY KEY (thread_id, anchor_at, by_author)
  )`,
  "CREATE INDEX IF NOT EXISTS refs_cell9 ON refs(room_tag, cell9, anchor_at)",
  "CREATE INDEX IF NOT EXISTS refs_cell10 ON refs(room_tag, cell10, anchor_at)",
  "CREATE INDEX IF NOT EXISTS refs_cell11 ON refs(room_tag, cell11, anchor_at)",
  "CREATE INDEX IF NOT EXISTS refs_expiry ON refs(expires_at)",
  "CREATE INDEX IF NOT EXISTS refs_trend ON refs(room_tag, trend_key)",
  "CREATE INDEX IF NOT EXISTS refs_thread ON refs(thread_id)",
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS applied_events (event_id TEXT PRIMARY KEY, at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS tombstones (thread_id TEXT PRIMARY KEY, at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS load (minute INTEGER PRIMARY KEY, writes INTEGER NOT NULL, reads INTEGER NOT NULL)",
];

const CELL_COLUMN: Record<ProximityScope, "cell9" | "cell10" | "cell11"> = { 9: "cell9", 10: "cell10", 11: "cell11" };

/**
 * References to threads anchored inside one partition cell. Holds ordering data only; the summary
 * a person reads always comes from the thread's own store.
 */
export class CellIndexDb {
  constructor(private readonly sql: SqlRunner) {}

  init(): void {
    runAll(this.sql, SCHEMA);
  }

  apply(events: readonly CellEvent[], now: number): void {
    let changed = false;
    for (const event of events) {
      if (!this.markApplied(event.eventId, now)) continue;
      changed = this.applyOne(event) || changed;
    }
    if (changed) this.bumpVersion();
    this.recordLoad(now, events.length, 0);
  }

  query(q: RefQuery): RefPage {
    this.recordLoad(q.now, 0, 1);
    const column = CELL_COLUMN[q.scope];
    const order = q.tab === "latest" ? "anchor_at" : "trend_key";
    const filters = ["room_tag = ?", `${column} IN (${placeholders(q.cells)})`, "expires_at > ?"];
    const bindings: SqlValue[] = [q.room, ...q.cells, q.now];
    if (q.tab === "trending") {
      filters.push("participant_count >= ?");
      bindings.push(TREND_MIN_PARTICIPANTS);
    }
    const cursor = decodeCursor(q.cursor);
    if (cursor) {
      filters.push(`(${order} < ? OR (${order} = ? AND thread_id < ?))`);
      bindings.push(cursor.key, cursor.key, cursor.threadId);
    }
    bindings.push(q.limit);
    const rows = this.sql.exec<RefRow>(
      `SELECT thread_id, anchor_at, anchor_kind, by_author, cell11, room_tag, expires_at, score, score_at, trend_key, participant_count
         FROM refs WHERE ${filters.join(" AND ")} ORDER BY ${order} DESC, thread_id DESC LIMIT ?`,
      ...bindings,
    ).toArray();
    return { refs: rows.map(toRecord), version: this.version() };
  }

  hasRef(q: HasRefQuery): boolean {
    const column = CELL_COLUMN[q.scope];
    return this.sql.exec(
      `SELECT 1 AS found FROM refs
        WHERE thread_id = ? AND room_tag = ? AND ${column} IN (${placeholders(q.cells)}) AND expires_at > ? LIMIT 1`,
      q.threadId, q.room, ...q.cells, q.now,
    ).toArray().length > 0;
  }

  sweep(now: number): void {
    this.sql.exec("DELETE FROM refs WHERE expires_at <= ?", now);
    this.sql.exec("DELETE FROM applied_events WHERE at < ?", now - EVENT_RETENTION_MS);
    this.sql.exec("DELETE FROM tombstones WHERE at < ?", now - EVENT_RETENTION_MS);
    this.sql.exec("DELETE FROM load WHERE minute < ?", minuteOf(now) - 60);
  }

  isEmpty(): boolean {
    const refs = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM refs").toArray()[0]?.n ?? 0;
    const tombstones = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tombstones").toArray()[0]?.n ?? 0;
    return Number(refs) + Number(tombstones) === 0;
  }

  loadSamples(): LoadSample[] {
    return this.sql.exec<LoadSample>("SELECT minute, writes, reads FROM load ORDER BY minute").toArray()
      .map((row) => ({ minute: Number(row.minute), writes: Number(row.writes), reads: Number(row.reads) }));
  }

  version(): number {
    return Number(this.meta("version") ?? 0);
  }

  partition(): string | null {
    return this.meta("partition");
  }

  setPartition(partition: string): void {
    this.sql.exec("INSERT INTO meta (key, value) VALUES ('partition', ?) ON CONFLICT DO NOTHING", partition);
  }

  private applyOne(event: CellEvent): boolean {
    switch (event.type) {
      case "ref.added": {
        const ref = event.ref;
        if (this.isTombstoned(ref.threadId)) return false;
        const cells = refCells(ref.location);
        this.sql.exec(
          `INSERT INTO refs (thread_id, anchor_at, anchor_kind, by_author, cell9, cell10, cell11, room_tag,
             expires_at, score, score_at, trend_key, participant_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          ref.threadId, ref.anchorAt, ref.kind, ref.byAuthor, cells.cell9, cells.cell10, cells.cell11, ref.roomTag,
          ref.expiresAt, ref.score, ref.scoreAt, trendKey({ value: ref.score, at: ref.scoreAt }), ref.participantCount,
        );
        return true;
      }
      case "thread.updated": {
        if (this.isTombstoned(event.threadId)) return false;
        this.sql.exec(
          "UPDATE refs SET expires_at = MAX(expires_at, ?), participant_count = MAX(participant_count, ?) WHERE thread_id = ?",
          event.expiresAt, event.participantCount, event.threadId,
        );
        // An older snapshot delivered late must not overwrite a newer one.
        this.sql.exec(
          "UPDATE refs SET score = ?, score_at = ?, trend_key = ? WHERE thread_id = ? AND score_at <= ?",
          event.score, event.scoreAt, trendKey({ value: event.score, at: event.scoreAt }), event.threadId, event.scoreAt,
        );
        return true;
      }
      case "thread.expired": {
        this.sql.exec("DELETE FROM refs WHERE thread_id = ?", event.threadId);
        this.sql.exec(
          "INSERT INTO tombstones (thread_id, at) VALUES (?, ?) ON CONFLICT DO UPDATE SET at = excluded.at",
          event.threadId, event.at,
        );
        return true;
      }
    }
  }

  private isTombstoned(threadId: string): boolean {
    return this.sql.exec("SELECT 1 AS found FROM tombstones WHERE thread_id = ?", threadId).toArray().length > 0;
  }

  private markApplied(eventId: string, now: number): boolean {
    return this.sql.exec(
      "INSERT INTO applied_events (event_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING event_id",
      eventId, now,
    ).toArray().length > 0;
  }

  private bumpVersion(): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('version', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
    );
  }

  private recordLoad(now: number, writes: number, reads: number): void {
    this.sql.exec(
      `INSERT INTO load (minute, writes, reads) VALUES (?, ?, ?)
       ON CONFLICT(minute) DO UPDATE SET writes = writes + excluded.writes, reads = reads + excluded.reads`,
      minuteOf(now), writes, reads,
    );
  }

  private meta(key: string): string | null {
    return this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
  }
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function toRecord(row: RefRow): RefRecord {
  return {
    threadId: row.thread_id,
    anchorAt: Number(row.anchor_at),
    kind: row.anchor_kind,
    byAuthor: row.by_author,
    cell11: row.cell11,
    roomTag: row.room_tag,
    expiresAt: Number(row.expires_at),
    score: Number(row.score),
    scoreAt: Number(row.score_at),
    trendKey: Number(row.trend_key),
    participantCount: Number(row.participant_count),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/cell-index-db.test.ts && npm run typecheck`
Expected: 9 tests pass; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add workers/edge/stores/cell-index-db.ts tests/cell-index-db.test.ts
git commit -F - <<'EOF'
feat(store): add cell index database of thread references

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---

### Task 10: User state database

**Files:**
- Create: `workers/edge/stores/user-state-db.ts`
- Test: `tests/user-state-db.test.ts`

**Interfaces:**
- Consumes: `SqlRunner`, `runAll` (Task 8); `EngagementResponse` (Task 4); `USER_STATE_RETENTION_MS`; `sha256`, `bytesToHex`.
- Produces:
  - `interface LikeInput { userId: string; postId: string; threadId: string; on: boolean; now: number }`
  - `interface RepostInput { userId: string; threadId: string; now: number }`
  - `class UserStateDb` with `init()`, `like(input): { changed: boolean; first: boolean }`, `repost(input): { ok: boolean; first: boolean }`, `engagement(userId: string, threadIds: readonly string[]): EngagementResponse`, `sweep(now: number): void`, `isEmpty(): boolean`
  - `userStateName(userId: string): Promise<string>` → `"u:" + first 4 hex chars of SHA-256(userId)`

- [ ] **Step 1: Write the failing test**

Create `tests/user-state-db.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/user-state-db.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `workers/edge/stores/user-state-db.ts`:

```ts
import type { EngagementResponse } from "../../../packages/protocol/index.ts";
import { USER_STATE_RETENTION_MS } from "../../../packages/shared/constants.ts";
import { bytesToHex, sha256 } from "../../../packages/shared/encoding.ts";
import { runAll, type SqlRunner } from "./sql.ts";

export interface LikeInput {
  userId: string;
  postId: string;
  threadId: string;
  on: boolean;
  now: number;
}

export interface RepostInput {
  userId: string;
  threadId: string;
  now: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS likes (
    user_id TEXT NOT NULL, post_id TEXT NOT NULL, thread_id TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (user_id, post_id)
  )`,
  "CREATE INDEX IF NOT EXISTS likes_thread ON likes(user_id, thread_id)",
  `CREATE TABLE IF NOT EXISTS reposts (
    user_id TEXT NOT NULL, thread_id TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (user_id, thread_id)
  )`,
  `CREATE TABLE IF NOT EXISTS engaged (
    user_id TEXT NOT NULL, thread_id TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (user_id, thread_id, kind)
  )`,
];

/** "Did I like this" lives with the user, so a viral thread never answers per-viewer questions. */
export class UserStateDb {
  constructor(private readonly sql: SqlRunner) {}

  init(): void {
    runAll(this.sql, SCHEMA);
  }

  like(input: LikeInput): { changed: boolean; first: boolean } {
    if (!input.on) {
      const removed = this.sql.exec(
        "DELETE FROM likes WHERE user_id = ? AND post_id = ? RETURNING post_id",
        input.userId, input.postId,
      ).toArray().length > 0;
      return { changed: removed, first: false };
    }
    const inserted = this.sql.exec(
      "INSERT INTO likes (user_id, post_id, thread_id, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING post_id",
      input.userId, input.postId, input.threadId, input.now,
    ).toArray().length > 0;
    if (!inserted) return { changed: false, first: false };
    return { changed: true, first: this.firstEngagement(input.userId, input.threadId, "like", input.now) };
  }

  repost(input: RepostInput): { ok: boolean; first: boolean } {
    const inserted = this.sql.exec(
      "INSERT INTO reposts (user_id, thread_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING thread_id",
      input.userId, input.threadId, input.now,
    ).toArray().length > 0;
    if (!inserted) return { ok: false, first: false };
    return { ok: true, first: this.firstEngagement(input.userId, input.threadId, "repost", input.now) };
  }

  engagement(userId: string, threadIds: readonly string[]): EngagementResponse {
    if (threadIds.length === 0) return { liked: [], reposted: [] };
    const list = threadIds.map(() => "?").join(", ");
    const liked = this.sql.exec<{ post_id: string }>(
      `SELECT post_id FROM likes WHERE user_id = ? AND thread_id IN (${list}) ORDER BY post_id`,
      userId, ...threadIds,
    ).toArray().map((row) => row.post_id);
    const reposted = this.sql.exec<{ thread_id: string }>(
      `SELECT thread_id FROM reposts WHERE user_id = ? AND thread_id IN (${list}) ORDER BY thread_id`,
      userId, ...threadIds,
    ).toArray().map((row) => row.thread_id);
    return { liked, reposted };
  }

  sweep(now: number): void {
    const cutoff = now - USER_STATE_RETENTION_MS;
    this.sql.exec("DELETE FROM likes WHERE at < ?", cutoff);
    this.sql.exec("DELETE FROM reposts WHERE at < ?", cutoff);
    this.sql.exec("DELETE FROM engaged WHERE at < ?", cutoff);
  }

  isEmpty(): boolean {
    const rows = this.sql.exec<{ n: number }>(
      "SELECT (SELECT COUNT(*) FROM likes) + (SELECT COUNT(*) FROM reposts) + (SELECT COUNT(*) FROM engaged) AS n",
    ).toArray()[0];
    return Number(rows?.n ?? 0) === 0;
  }

  private firstEngagement(userId: string, threadId: string, kind: "like" | "repost", now: number): boolean {
    return this.sql.exec(
      "INSERT INTO engaged (user_id, thread_id, kind, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING kind",
      userId, threadId, kind, now,
    ).toArray().length > 0;
  }
}

/** 65,536 buckets: enough to spread any load, few enough to stay cheap. */
export async function userStateName(userId: string): Promise<string> {
  return `u:${bytesToHex(await sha256(userId)).slice(0, 4)}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/user-state-db.test.ts && npm run typecheck`
Expected: 5 tests pass; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add workers/edge/stores/user-state-db.ts tests/user-state-db.test.ts
git commit -F - <<'EOF'
feat(store): add bucketed per-user like and repost state

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---

### Task 11: Service interfaces, queue consumer and the in-memory test harness

**Files:**
- Create: `workers/edge/services.ts`, `workers/edge/queue/consumer.ts`
- Create: `tests/support/fake-services.ts`
- Test: `tests/consumer.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 6–10.
- Produces:
  - In `services.ts`: `ThreadStoreApi`, `CellIndexApi`, `UserStateApi`, `EdgeCache`, `LimitKind = "message" | "like" | "read"`, `Services` (exact shapes below).
  - `consumeEvents(events: readonly FeedEvent[], services: Services, now: number): Promise<void>`
  - Test harness `createFakeServices(options?: { cache?: boolean }): FakeServices` with `services`, `queue: FeedEvent[]`, `drain(now: number): Promise<void>`, `setPartitionMap(map: PartitionMap): void`.

- [ ] **Step 1: Define the service interfaces**

Create `workers/edge/services.ts`:

```ts
import type { RefRecord } from "../../packages/feed/order.ts";
import type { LocationHint } from "../../packages/feed/location-hint.ts";
import type { PartitionMap } from "../../packages/feed/partition.ts";
import type { DeletionOutcome } from "../../packages/feed/tree.ts";
import type { EngagementResponse, PostView, ThreadSummary } from "../../packages/protocol/index.ts";
import type { CellEvent, FeedEvent, ThreadLikedEvent, ThreadRepostedEvent } from "./events.ts";
import type { HasRefQuery, RefQuery } from "./stores/cell-index-db.ts";
import type { Outcome } from "./stores/outcome.ts";
import type { CreateThreadInput, RemoveInput, ReplyInput } from "./stores/thread-db.ts";
import type { LikeInput, RepostInput } from "./stores/user-state-db.ts";

/** One thread's store. In production a Durable Object stub; in tests an in-memory ThreadDb. */
export interface ThreadStoreApi {
  create(input: CreateThreadInput): Promise<Outcome<{ summary: ThreadSummary }>>;
  reply(input: ReplyInput): Promise<Outcome<{ post: PostView; summary: ThreadSummary }>>;
  remove(input: RemoveInput): Promise<Outcome<{ outcome: DeletionOutcome }>>;
  summary(now: number): Promise<Outcome<{ summary: ThreadSummary }>>;
  thread(now: number): Promise<Outcome<{ summary: ThreadSummary; posts: PostView[] }>>;
  applyLikes(events: ThreadLikedEvent[], now: number): Promise<void>;
  applyReposts(events: ThreadRepostedEvent[], now: number): Promise<void>;
}

export interface CellIndexApi {
  apply(partition: string, events: CellEvent[], now: number): Promise<void>;
  query(partition: string, query: RefQuery): Promise<{ refs: RefRecord[]; version: number }>;
  hasRef(partition: string, query: HasRefQuery): Promise<boolean>;
}

export interface UserStateApi {
  like(input: LikeInput): Promise<{ changed: boolean; first: boolean }>;
  repost(input: RepostInput): Promise<{ ok: boolean; first: boolean }>;
  engagement(userId: string, threadIds: string[]): Promise<EngagementResponse>;
}

export interface EdgeCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

export type LimitKind = "message" | "like" | "read";

/** Everything the HTTP handlers and the queue consumer touch, so both run against fakes in tests. */
export interface Services {
  thread(id: string, hint?: LocationHint): ThreadStoreApi;
  cell(partition: string): CellIndexApi;
  user(userId: string): Promise<UserStateApi>;
  sendEvents(events: FeedEvent[]): Promise<void>;
  partitionMap(now: number): Promise<PartitionMap>;
  limit(kind: LimitKind, key: string): Promise<boolean>;
  cache: EdgeCache;
}
```

- [ ] **Step 2: Write the consumer**

Create `workers/edge/queue/consumer.ts`:

```ts
import type { CellEvent, FeedEvent, ThreadLikedEvent, ThreadRepostedEvent } from "../events.ts";
import type { Services } from "../services.ts";

/**
 * Groups a batch by target and makes one call per target, so a viral thread receives a few
 * aggregated calls per second instead of one per like. Throwing makes the queue retry the batch;
 * every handler is idempotent, so retries are safe.
 */
export async function consumeEvents(events: readonly FeedEvent[], services: Services, now: number): Promise<void> {
  const likes = new Map<string, ThreadLikedEvent[]>();
  const reposts = new Map<string, ThreadRepostedEvent[]>();
  const cells = new Map<string, CellEvent[]>();
  for (const event of events) {
    switch (event.type) {
      case "thread.liked":
        push(likes, event.threadId, event);
        break;
      case "thread.reposted":
        push(reposts, event.threadId, event);
        break;
      default:
        push(cells, event.partition, event);
    }
  }
  await Promise.all([
    ...[...likes].map(([threadId, batch]) => services.thread(threadId).applyLikes(batch, now)),
    ...[...reposts].map(([threadId, batch]) => services.thread(threadId).applyReposts(batch, now)),
    ...[...cells].map(([partition, batch]) => services.cell(partition).apply(partition, batch, now)),
  ]);
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
```

- [ ] **Step 3: Write the in-memory harness**

Create `tests/support/fake-services.ts`:

```ts
import { EMPTY_PARTITION_MAP, type PartitionMap } from "../../packages/feed/partition.ts";
import type { FeedEvent } from "../../workers/edge/events.ts";
import { consumeEvents } from "../../workers/edge/queue/consumer.ts";
import type { Services } from "../../workers/edge/services.ts";
import { CellIndexDb } from "../../workers/edge/stores/cell-index-db.ts";
import { ThreadDb } from "../../workers/edge/stores/thread-db.ts";
import { UserStateDb } from "../../workers/edge/stores/user-state-db.ts";
import { memorySql } from "./memory-sql.ts";

export interface FakeServices {
  services: Services;
  queue: FeedEvent[];
  drain(now: number): Promise<void>;
  setPartitionMap(map: PartitionMap): void;
}

/** Real store modules over in-memory SQLite, a synchronous queue, and an optional in-memory cache. */
export function createFakeServices(options: { cache?: boolean } = {}): FakeServices {
  const threads = new Map<string, ThreadDb>();
  const cells = new Map<string, CellIndexDb>();
  const users = new Map<string, UserStateDb>();
  const queue: FeedEvent[] = [];
  const cache = new Map<string, Response>();
  let partitionMap = EMPTY_PARTITION_MAP;

  const get = <T extends { init(): void }>(map: Map<string, T>, key: string, make: () => T): T => {
    let value = map.get(key);
    if (!value) {
      value = make();
      value.init();
      map.set(key, value);
    }
    return value;
  };
  const thread = (id: string) => get(threads, id, () => new ThreadDb(memorySql()));
  const cell = (partition: string) => get(cells, partition, () => new CellIndexDb(memorySql()));
  const user = (userId: string) => get(users, userId, () => new UserStateDb(memorySql()));

  const services: Services = {
    thread: (id) => ({
      create: async (input) => { const result = thread(id).create(input); queue.push(...result.events); return result.outcome; },
      reply: async (input) => { const result = thread(id).reply(input); queue.push(...result.events); return result.outcome; },
      remove: async (input) => { const result = thread(id).remove(input); queue.push(...result.events); return result.outcome; },
      summary: async (now) => thread(id).summary(now),
      thread: async (now) => thread(id).thread(now),
      applyLikes: async (events, now) => { queue.push(...thread(id).applyLikes(events, now)); },
      applyReposts: async (events, now) => { queue.push(...thread(id).applyReposts(events, now)); },
    }),
    cell: () => ({
      apply: async (partition, events, now) => { const db = cell(partition); db.setPartition(partition); db.apply(events, now); },
      query: async (partition, query) => cell(partition).query(query),
      hasRef: async (partition, query) => cell(partition).hasRef(query),
    }),
    user: async (userId) => ({
      like: async (input) => user(userId).like(input),
      repost: async (input) => user(userId).repost(input),
      engagement: async (id, threadIds) => user(userId).engagement(id, threadIds),
    }),
    sendEvents: async (events) => { queue.push(...events); },
    partitionMap: async () => partitionMap,
    limit: async () => true,
    cache: {
      match: async (key) => (options.cache ? cache.get(key)?.clone() : undefined),
      put: async (key, response) => { if (options.cache) cache.set(key, response.clone()); },
    },
  };

  return {
    services,
    queue,
    async drain(now) {
      for (let round = 0; round < 20 && queue.length > 0; round += 1) {
        await consumeEvents(queue.splice(0), services, now);
      }
    },
    setPartitionMap(map) {
      partitionMap = map;
    },
  };
}
```

- [ ] **Step 4: Write the failing consumer test**

Create `tests/consumer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { latLngToCanonicalLocation, locationToScopeCell, regionCells } from "../packages/geo/index.ts";
import { uuidv7 } from "../packages/shared/uuid.ts";
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
});
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/consumer.test.ts && npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add workers/edge/services.ts workers/edge/queue/consumer.ts tests/support/fake-services.ts tests/consumer.test.ts
git commit -F - <<'EOF'
feat(worker): add service interfaces, batched queue consumer and test harness

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---

### Task 12: HTTP handlers for feeds, threads, engagement and actions

**Files:**
- Modify: `workers/edge/http.ts`
- Create: `workers/edge/api/context.ts`, `workers/edge/api/respond.ts`, `workers/edge/api/feed.ts`, `workers/edge/api/threads.ts`, `workers/edge/api/engagement.ts`, `workers/edge/api/actions.ts`
- Test: `tests/api.test.ts`

**Interfaces:**
- Consumes: `Services` (Task 11); `regionPartitions`, `partitionFor` (Task 6); `mergePage` (Task 7); `locationHintFor` (Task 2); protocol validators (Task 4).
- Produces:
  - `interface ApiUser { id: string; author: string }`, `interface ApiContext { services: Services; user: ApiUser; now: number }`
  - `handleFeed(url: URL, request: Request, ctx: ApiContext): Promise<Response>`
  - `handleThread(threadId: string, url: URL, request: Request, ctx: ApiContext): Promise<Response>`
  - `handleEngagement(url: URL, ctx: ApiContext): Promise<Response>`
  - `handleAction(request: Request, ctx: ApiContext): Promise<Response>`
  - In `http.ts`: `json()` keeps a caller-supplied `cache-control`; new `appendCookies(response: Response, cookies: readonly string[]): Response`.

- [ ] **Step 1: Update the HTTP helpers**

In `workers/edge/http.ts`, replace `json` and add `appendCookies`:

```ts
export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

/** Adds Set-Cookie headers. Copies the response because cached responses have immutable headers. */
export function appendCookies(response: Response, cookies: readonly string[]): Response {
  if (cookies.length === 0) return response;
  const copy = new Response(response.body, response);
  for (const cookie of cookies) copy.headers.append("set-cookie", cookie);
  return copy;
}
```

- [ ] **Step 2: Create the handler context and response helpers**

Create `workers/edge/api/context.ts`:

```ts
import type { Services } from "../services.ts";

export interface ApiUser {
  id: string;
  /** The public 8-hex author label. */
  author: string;
}

export interface ApiContext {
  services: Services;
  user: ApiUser;
  now: number;
}
```

Create `workers/edge/api/respond.ts`:

```ts
import type { ErrorCode } from "../../../packages/protocol/index.ts";
import { bytesToHex, sha256 } from "../../../packages/shared/encoding.ts";
import { json } from "../http.ts";

/** Cache API keys live on a private origin so they can never collide with real URLs. */
export const CACHE_ORIGIN = "https://cache.nearline.internal";

export function errorJson(status: number, code: ErrorCode): Response {
  return json({ error: code }, { status });
}

export function statusFor(code: ErrorCode): number {
  switch (code) {
    case "UNAUTHORIZED": return 401;
    case "FORBIDDEN_ORIGIN":
    case "NOT_VISIBLE":
    case "NOT_AUTHOR": return 403;
    case "THREAD_NOT_FOUND":
    case "PARENT_NOT_FOUND":
    case "POST_NOT_FOUND": return 404;
    case "ALREADY_REPOSTED":
    case "THREAD_FULL": return 409;
    case "THREAD_EXPIRED": return 410;
    case "RATE_LIMITED": return 429;
    case "UNAVAILABLE": return 503;
    default: return 400;
  }
}

export function sharedCacheControl(seconds: number): string {
  return `public, max-age=0, s-maxage=${seconds}`;
}

/** Answers 304 when the client already has this version. */
export function conditional(request: Request, response: Response): Response {
  const etag = response.headers.get("etag");
  if (etag && request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": response.headers.get("cache-control") ?? "no-store" } });
  }
  return response;
}

export async function versionHash(parts: readonly (string | number)[]): Promise<string> {
  return bytesToHex(await sha256(parts.join("|"))).slice(0, 16);
}
```

- [ ] **Step 3: Write the failing handler tests**

Create `tests/api.test.ts`:

```ts
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
```

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run tests/api.test.ts`
Expected: FAIL, cannot load `../workers/edge/api/actions.ts`.

- [ ] **Step 5: Implement the feed handler**

Create `workers/edge/api/feed.ts`:

```ts
import { mergePage } from "../../../packages/feed/order.ts";
import { regionPartitions } from "../../../packages/feed/partition.ts";
import { isScopeCell, regionCells } from "../../../packages/geo/index.ts";
import { isRoomTag, type FeedItem, type FeedResponse, type FeedTab, type ThreadSummary } from "../../../packages/protocol/index.ts";
import {
  FEED_CACHE_SECONDS,
  isProximityScope,
  PARTITION_QUERY_LIMIT,
  THREAD_CACHE_SECONDS,
  type ProximityScope,
} from "../../../packages/shared/constants.ts";
import { json } from "../http.ts";
import type { ApiContext } from "./context.ts";
import { CACHE_ORIGIN, conditional, errorJson, sharedCacheControl, versionHash } from "./respond.ts";

interface FeedParams {
  cell: string;
  scope: ProximityScope;
  room: string;
  tab: FeedTab;
  cursor: string | null;
}

export async function handleFeed(url: URL, request: Request, ctx: ApiContext): Promise<Response> {
  const scope = Number(url.searchParams.get("scope"));
  const cell = url.searchParams.get("cell");
  const room = url.searchParams.get("room") ?? "";
  const tab = url.searchParams.get("tab");
  const cursor = url.searchParams.get("cursor") || null;
  if (!isProximityScope(scope)) return errorJson(400, "INVALID_SCOPE");
  if (!isScopeCell(cell, scope)) return errorJson(400, "INVALID_LOCATION");
  if (!isRoomTag(room)) return errorJson(400, "INVALID_ROOM_TAG");
  if (tab !== "latest" && tab !== "trending") return errorJson(400, "BAD_REQUEST");
  if (cursor !== null && cursor.length > 120) return errorJson(400, "BAD_REQUEST");
  if (!await ctx.services.limit("read", ctx.user.id)) return errorJson(429, "RATE_LIMITED");

  const params: FeedParams = { cell, scope, room, tab, cursor };
  // Everyone in the same scope cell, room and tab sees the same feed, so one cached copy serves them all.
  const key = `${CACHE_ORIGIN}/feed?${new URLSearchParams({ cell, scope: String(scope), room, tab, cursor: cursor ?? "" })}`;
  const cached = await ctx.services.cache.match(key);
  if (cached) return conditional(request, cached);
  const response = await buildFeed(params, ctx);
  await ctx.services.cache.put(key, response.clone());
  return conditional(request, response);
}

async function buildFeed(params: FeedParams, ctx: ApiContext): Promise<Response> {
  const region = regionCells(params.cell);
  const map = await ctx.services.partitionMap(ctx.now);
  const partitions = regionPartitions(region, map, ctx.now);
  const pages = await Promise.all(partitions.map((partition) => ctx.services.cell(partition).query(partition, {
    cells: region,
    scope: params.scope,
    room: params.room,
    tab: params.tab,
    cursor: params.cursor,
    limit: PARTITION_QUERY_LIMIT,
    now: ctx.now,
  })));
  const page = mergePage(pages.map((result) => result.refs), params.tab);
  const summaries = await Promise.all(page.refs.map((ref) => summaryFor(ref.threadId, ctx)));
  const items: FeedItem[] = [];
  page.refs.forEach((ref, index) => {
    const summary = summaries[index];
    if (!summary || summary.roomTag !== params.room || summary.expiresAt <= ctx.now) return;
    items.push({ summary, via: { cell11: ref.cell11, kind: ref.kind, byAuthor: ref.byAuthor, createdAt: ref.anchorAt } });
  });
  const version = await versionHash([
    ...partitions.map((partition, index) => `${partition}:${pages[index]!.version}`),
    ...items.map((item) => `${item.summary.id}:${item.summary.version}:${item.via.createdAt}`),
  ]);
  const body: FeedResponse = { version, serverTime: ctx.now, items, nextCursor: page.nextCursor };
  return json(body, { headers: { etag: `"${version}"`, "cache-control": sharedCacheControl(FEED_CACHE_SECONDS) } });
}

/** Summaries come from the thread's own store, through a 2-second shared cache. */
async function summaryFor(threadId: string, ctx: ApiContext): Promise<ThreadSummary | null> {
  const key = `${CACHE_ORIGIN}/summary/${threadId}`;
  const hit = await ctx.services.cache.match(key);
  if (hit) return (await hit.json() as { summary: ThreadSummary }).summary;
  const outcome = await ctx.services.thread(threadId).summary(ctx.now);
  if (!outcome.ok) return null;
  await ctx.services.cache.put(
    key,
    json({ summary: outcome.summary }, { headers: { "cache-control": sharedCacheControl(THREAD_CACHE_SECONDS) } }),
  );
  return outcome.summary;
}
```

- [ ] **Step 6: Implement the thread and engagement handlers**

Create `workers/edge/api/threads.ts`:

```ts
import { isRoomTag, isUuid, type ThreadResponse } from "../../../packages/protocol/index.ts";
import { THREAD_CACHE_SECONDS } from "../../../packages/shared/constants.ts";
import { json } from "../http.ts";
import type { ApiContext } from "./context.ts";
import { CACHE_ORIGIN, conditional, errorJson, sharedCacheControl, statusFor } from "./respond.ts";

/** Reading a thread needs only its id (74 random bits, unguessable) and the matching room. */
export async function handleThread(threadId: string, url: URL, request: Request, ctx: ApiContext): Promise<Response> {
  const room = url.searchParams.get("room") ?? "";
  if (!isUuid(threadId)) return errorJson(400, "BAD_REQUEST");
  if (!isRoomTag(room)) return errorJson(400, "INVALID_ROOM_TAG");
  if (!await ctx.services.limit("read", ctx.user.id)) return errorJson(429, "RATE_LIMITED");

  const key = `${CACHE_ORIGIN}/thread/${threadId}?room=${room}`;
  const cached = await ctx.services.cache.match(key);
  if (cached) return conditional(request, cached);

  const outcome = await ctx.services.thread(threadId).thread(ctx.now);
  if (!outcome.ok) return errorJson(statusFor(outcome.code), outcome.code);
  // A wrong room answers exactly like a missing thread, so rooms cannot be probed.
  if (outcome.summary.roomTag !== room) return errorJson(404, "THREAD_NOT_FOUND");
  const body: ThreadResponse = { version: outcome.summary.version, serverTime: ctx.now, summary: outcome.summary, posts: outcome.posts };
  const response = json(body, {
    headers: { etag: `"t${outcome.summary.version}"`, "cache-control": sharedCacheControl(THREAD_CACHE_SECONDS) },
  });
  await ctx.services.cache.put(key, response.clone());
  return conditional(request, response);
}
```

Create `workers/edge/api/engagement.ts`:

```ts
import { isUuid } from "../../../packages/protocol/index.ts";
import { MAX_ENGAGEMENT_IDS } from "../../../packages/shared/constants.ts";
import { json } from "../http.ts";
import type { ApiContext } from "./context.ts";
import { errorJson } from "./respond.ts";

/** Per-viewer flags. Never cached: it is private to the signed-in user. */
export async function handleEngagement(url: URL, ctx: ApiContext): Promise<Response> {
  const ids = (url.searchParams.get("threads") ?? "").split(",").filter(Boolean);
  if (ids.length > MAX_ENGAGEMENT_IDS || !ids.every(isUuid)) return errorJson(400, "BAD_REQUEST");
  if (!await ctx.services.limit("read", ctx.user.id)) return errorJson(429, "RATE_LIMITED");
  const state = await ctx.services.user(ctx.user.id);
  return json(await state.engagement(ctx.user.id, ids));
}
```

- [ ] **Step 7: Implement the action handler**

Create `workers/edge/api/actions.ts`:

```ts
import { locationHintFor } from "../../../packages/feed/location-hint.ts";
import { partitionFor, regionPartitions } from "../../../packages/feed/partition.ts";
import { regionCells } from "../../../packages/geo/index.ts";
import {
  isValidPostBody,
  parseActionRequest,
  type ActionOutcome,
  type ActionResponse,
} from "../../../packages/protocol/index.ts";
import type { ProximityScope } from "../../../packages/shared/constants.ts";
import { uuidv7 } from "../../../packages/shared/uuid.ts";
import { json } from "../http.ts";
import type { ApiContext } from "./context.ts";
import { statusFor } from "./respond.ts";

export async function handleAction(request: Request, ctx: ApiContext): Promise<Response> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    input = null;
  }
  const action = parseActionRequest(input);
  if (!action) {
    const id = typeof (input as { id?: unknown } | null)?.id === "string" ? (input as { id: string }).id : "";
    return json({ id, ok: false, code: "BAD_REQUEST" } satisfies ActionResponse, { status: 400 });
  }
  const respond = (outcome: ActionOutcome): Response =>
    json({ id: action.id, ...outcome } satisfies ActionResponse, { status: outcome.ok ? 200 : statusFor(outcome.code) });

  if ((action.type === "post" || action.type === "reply") && !isValidPostBody(action.body)) {
    return respond({ ok: false, code: "INVALID_MESSAGE" });
  }
  if (!await ctx.services.limit(action.type === "like" ? "like" : "message", ctx.user.id)) {
    return respond({ ok: false, code: "RATE_LIMITED" });
  }
  if (action.type === "reply" || action.type === "like" || action.type === "repost") {
    if (!await isVisible(action.threadId, action.cell, action.scope, action.room, ctx)) {
      return respond({ ok: false, code: "NOT_VISIBLE" });
    }
  }

  const actor = { userId: ctx.user.id, author: ctx.user.author };
  const now = ctx.now;
  switch (action.type) {
    case "post": {
      const id = uuidv7(now);
      const partition = partitionFor(action.location, await ctx.services.partitionMap(now), now).write;
      const outcome = await ctx.services.thread(id, locationHintFor(action.location)).create({
        id, actor, roomTag: action.room, location: action.location, partition, body: action.body, now,
      });
      return respond(outcome.ok ? { ok: true, postId: id } : outcome);
    }
    case "reply": {
      const postId = uuidv7(now);
      const outcome = await ctx.services.thread(action.threadId).reply({ postId, parentId: action.parentId, actor, body: action.body, now });
      return respond(outcome.ok ? { ok: true, postId } : outcome);
    }
    case "delete": {
      const outcome = await ctx.services.thread(action.threadId).remove({ postId: action.postId, actor, now });
      return respond(outcome.ok ? { ok: true } : outcome);
    }
    case "like": {
      const state = await ctx.services.user(ctx.user.id);
      const result = await state.like({ userId: ctx.user.id, postId: action.postId, threadId: action.threadId, on: action.on, now });
      if (result.changed) {
        await ctx.services.sendEvents([{
          eventId: uuidv7(now), type: "thread.liked", threadId: action.threadId, postId: action.postId,
          userId: ctx.user.id, delta: action.on ? 1 : -1, first: result.first, at: now,
        }]);
      }
      return respond({ ok: true });
    }
    case "repost": {
      const state = await ctx.services.user(ctx.user.id);
      const result = await state.repost({ userId: ctx.user.id, threadId: action.threadId, now });
      if (!result.ok) return respond({ ok: false, code: "ALREADY_REPOSTED" });
      const partition = partitionFor(action.location, await ctx.services.partitionMap(now), now).write;
      await ctx.services.sendEvents([{
        eventId: uuidv7(now), type: "thread.reposted", threadId: action.threadId, userId: ctx.user.id,
        first: result.first, location: action.location, partition, byAuthor: actor.author, at: now,
      }]);
      return respond({ ok: true });
    }
  }
}

/** A viewer may act on a thread only if one of its anchors is inside their region. */
async function isVisible(threadId: string, cell: string, scope: ProximityScope, room: string, ctx: ApiContext): Promise<boolean> {
  const cells = regionCells(cell);
  const partitions = regionPartitions(cells, await ctx.services.partitionMap(ctx.now), ctx.now);
  const answers = await Promise.all(partitions.map((partition) =>
    ctx.services.cell(partition).hasRef(partition, { threadId, cells, scope, room, now: ctx.now })));
  return answers.some(Boolean);
}
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run tests/api.test.ts && npm test && npm run typecheck`
Expected: 8 handler tests pass; whole suite passes; typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add workers/edge/http.ts workers/edge/api tests/api.test.ts
git commit -F - <<'EOF'
feat(api): add feed, thread, engagement and action handlers

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---
### Task 13: Access-token sessions

**Files:**
- Modify: `workers/edge/auth/session.ts` (rewrite), `workers/edge/auth/routes.ts`, `workers/edge/env.ts`, `workers/edge/index.ts`
- Test: `tests/session.test.ts`

**Interfaces:**
- Consumes: `signAccessToken`, `verifyAccessToken` (Task 5); `ApiUser` (Task 12); `appendCookies` (Task 12); `ACCESS_TOKEN_TTL_MS`.
- Produces:
  - `interface AuthResult { user: ApiUser; setCookies: string[] }`
  - `createSession(env: Pick<Env, "DB" | "SESSION_KEY">, userId: string, author: string, now?: number): Promise<string[]>`
  - `authenticate(request: Request, env: Pick<Env, "DB" | "SESSION_KEY">, now?: number): Promise<AuthResult | null>`
  - `destroySession(request: Request, env: Pick<Env, "DB">): Promise<string[]>`
  - `Env.SESSION_KEY: string`; `AuthenticatedUser` is removed from `env.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/session.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ACCESS_TOKEN_TTL_MS } from "../packages/shared/constants.ts";
import { authenticate, createSession, destroySession } from "../workers/edge/auth/session.ts";

interface FakeRow { id: string; author_hash: string }

function fakeEnv(session: FakeRow | null = null) {
  const calls: string[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind: () => ({
          first: async () => { calls.push(sql); return sql.includes("FROM sessions") ? session : null; },
          run: async () => { calls.push(sql); return {}; },
        }),
      };
    },
  };
  return { env: { DB: DB as never, SESSION_KEY: "test-key" }, calls };
}

const valueOf = (setCookie: string) => setCookie.split(";")[0]!.split("=").slice(1).join("=");
const nameOf = (setCookie: string) => setCookie.split("=")[0];
const request = (cookie: string) => new Request("https://nearline.test/", { headers: { cookie } });

describe("sessions", () => {
  it("issues a refresh cookie and an access cookie at sign-in", async () => {
    const { env, calls } = fakeEnv();
    const cookies = await createSession(env, "user-1", "abcd1234", 1_000);
    expect(cookies.map(nameOf)).toEqual(["pc_session", "pc_access"]);
    expect(calls).toHaveLength(1);
  });

  it("authenticates from the access token without touching the database", async () => {
    const { env, calls } = fakeEnv();
    const [, access] = await createSession(env, "user-1", "abcd1234", 1_000);
    calls.length = 0;
    const result = await authenticate(request(`pc_access=${valueOf(access!)}`), env, 2_000);
    expect(result).toEqual({ user: { id: "user-1", author: "abcd1234" }, setCookies: [] });
    expect(calls).toEqual([]);
  });

  it("falls back to the refresh session and re-issues an access token", async () => {
    const { env, calls } = fakeEnv({ id: "user-1", author_hash: "abcd1234ffffffff" });
    const [refresh, access] = await createSession(env, "user-1", "abcd1234", 1_000);
    calls.length = 0;
    const expired = 1_000 + ACCESS_TOKEN_TTL_MS;
    const result = await authenticate(request(`pc_access=${valueOf(access!)}; pc_session=${valueOf(refresh!)}`), env, expired);
    expect(result?.user).toEqual({ id: "user-1", author: "abcd1234" });
    expect(result?.setCookies.map(nameOf)).toEqual(["pc_access"]);
    expect(calls).toHaveLength(1);
  });

  it("rejects missing, tampered and unknown sessions", async () => {
    const { env } = fakeEnv(null);
    expect(await authenticate(request(""), env, 1)).toBeNull();
    expect(await authenticate(request("pc_access=forged.token"), env, 1)).toBeNull();
    expect(await authenticate(request("pc_session=unknown"), env, 1)).toBeNull();
  });

  it("clears both cookies at sign-out", async () => {
    const { env } = fakeEnv();
    const cookies = await destroySession(request("pc_session=abc"), env);
    expect(cookies.map(nameOf)).toEqual(["pc_session", "pc_access"]);
    expect(cookies.every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/session.test.ts`
Expected: FAIL; `createSession` returns a single string and `authenticate` returns a different shape.

- [ ] **Step 3: Rewrite `workers/edge/auth/session.ts`**

```ts
import { ACCESS_TOKEN_TTL_MS, SESSION_TTL_MS } from "../../../packages/shared/constants.ts";
import { bytesToHex, randomToken, sha256 } from "../../../packages/shared/encoding.ts";
import { signAccessToken, verifyAccessToken } from "../../../packages/shared/session-token.ts";
import type { ApiUser } from "../api/context.ts";
import type { Env } from "../env.ts";
import { cookie, parseCookies } from "../http.ts";

const SESSION_COOKIE = "pc_session";
const ACCESS_COOKIE = "pc_access";

export interface AuthResult {
  user: ApiUser;
  /** Set-Cookie values the response must carry (a refreshed access token). */
  setCookies: string[];
}

export async function createSession(
  env: Pick<Env, "DB" | "SESSION_KEY">,
  userId: string,
  author: string,
  now = Date.now(),
): Promise<string[]> {
  const token = randomToken();
  const tokenHash = bytesToHex(await sha256(token));
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  ).bind(tokenHash, userId, now + SESSION_TTL_MS, now).run();
  return [
    cookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1_000),
    await accessCookie(env, { id: userId, author }, tokenHash, now),
  ];
}

/**
 * The access token is checked with no storage access, so polls never touch D1. When it is missing
 * or expired, the refresh session in D1 is checked and a new access token issued: at most one D1
 * read per user per hour.
 */
export async function authenticate(
  request: Request,
  env: Pick<Env, "DB" | "SESSION_KEY">,
  now = Date.now(),
): Promise<AuthResult | null> {
  const cookies = parseCookies(request);
  const access = cookies.get(ACCESS_COOKIE);
  if (access) {
    const payload = await verifyAccessToken(access, env.SESSION_KEY, now);
    if (payload) return { user: { id: payload.uid, author: payload.author }, setCookies: [] };
  }
  const token = cookies.get(SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = bytesToHex(await sha256(token));
  const row = await env.DB.prepare(
    `SELECT users.id, users.author_hash
       FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
  ).bind(tokenHash, now).first<{ id: string; author_hash: string }>();
  if (!row) return null;
  const user = { id: row.id, author: row.author_hash.slice(0, 8) };
  return { user, setCookies: [await accessCookie(env, user, tokenHash, now)] };
}

/** An access token stays valid until it expires (at most an hour): the cost of stateless checks. */
export async function destroySession(request: Request, env: Pick<Env, "DB">): Promise<string[]> {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (token) {
    const tokenHash = bytesToHex(await sha256(token));
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }
  return [cookie(SESSION_COOKIE, "", 0), cookie(ACCESS_COOKIE, "", 0)];
}

async function accessCookie(env: Pick<Env, "SESSION_KEY">, user: ApiUser, tokenHash: string, now: number): Promise<string> {
  const token = await signAccessToken(
    { uid: user.id, author: user.author, sid: tokenHash.slice(0, 16), exp: now + ACCESS_TOKEN_TTL_MS },
    env.SESSION_KEY,
  );
  return cookie(ACCESS_COOKIE, token, ACCESS_TOKEN_TTL_MS / 1_000);
}
```

- [ ] **Step 4: Update `env.ts`**

In `workers/edge/env.ts`, add `SESSION_KEY: string;` to `Env` and delete the `AuthenticatedUser` interface.

- [ ] **Step 5: Update the auth routes**

In `workers/edge/auth/routes.ts`:

1. Change the `http.ts` import to `import { appendCookies, cookie, HttpError, json, parseCookies, readJson } from "../http.ts";`
2. Replace the session branch with:

```ts
  if (request.method === "GET" && pathname === "/api/auth/session") {
    const auth = await authenticate(request, env);
    const body = auth ? { authenticated: true, author: auth.user.author } : { authenticated: false };
    return appendCookies(json(body), auth?.setCookies ?? []);
  }
```

3. Replace the logout branch's return with:

```ts
    return appendCookies(json({ ok: true }), await destroySession(request, env));
```

4. Replace the register-verify return with:

```ts
    const author = authorHash.slice(0, 8);
    return appendCookies(json({ verified: true, author }), await createSession(env, flow.user_id, author));
```

5. Replace the login-verify return (after the `UPDATE credentials` statement) with:

```ts
    const owner = await env.DB.prepare("SELECT author_hash FROM users WHERE id = ?")
      .bind(stored.user_id).first<{ author_hash: string }>();
    if (!owner) throw new HttpError(401, "UNKNOWN_CREDENTIAL");
    return appendCookies(json({ verified: true }), await createSession(env, stored.user_id, owner.author_hash.slice(0, 8)));
```

- [ ] **Step 6: Keep the soon-to-be-deleted socket route compiling**

In `workers/edge/index.ts`, inside `openSocket`, replace:

```ts
  const user = await authenticate(request, env);
  if (!user) throw new HttpError(401, "UNAUTHORIZED");
```

with:

```ts
  const auth = await authenticate(request, env);
  if (!auth) throw new HttpError(401, "UNAUTHORIZED");
  const user = { id: auth.user.id, authorHash: auth.user.author };
```

(Task 14 deletes this route entirely.)

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/session.test.ts && npm test && npm run typecheck`
Expected: 5 session tests pass; whole suite passes; typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add workers/edge/auth workers/edge/env.ts workers/edge/index.ts tests/session.test.ts
git commit -F - <<'EOF'
feat(auth): stateless access tokens with D1 refresh sessions

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---

### Task 14: Durable Objects, Worker wiring and Cloudflare configuration

**Files:**
- Create: `workers/edge/durable-objects/thread-store.ts`, `workers/edge/durable-objects/cell-index.ts`, `workers/edge/durable-objects/user-state.ts`, `workers/edge/services-env.ts`
- Rewrite: `workers/edge/index.ts`, `workers/edge/env.ts`, `wrangler.jsonc`
- Delete: `workers/edge/durable-objects/geo-shard.ts`

**Interfaces:**
- Consumes: the store modules (Tasks 8–10), `Services` (Task 11), handlers (Task 12), `authenticate` (Task 13), `consumeEvents` (Task 11).
- Produces: `ThreadStore`, `CellIndex`, `UserState` Durable Object classes; `createServices(env: Env): Services`; the Worker's `fetch`, `queue` and `scheduled` handlers.

- [ ] **Step 1: Provision the queue and KV namespace**

These commands create resources on the Cloudflare account. Confirm with the user before running them.

```bash
npx wrangler queues create nearline-feed-events
npx wrangler kv namespace create PARTITION_MAP
```

Expected: the queue is created; the KV command prints an `id`. Keep that id for Step 8. If either command reports that the feature is not available on the account's plan, stop and tell the user: the design needs Queues and KV.

- [ ] **Step 2: Thread store Durable Object**

Create `workers/edge/durable-objects/thread-store.ts`:

```ts
import { DurableObject } from "cloudflare:workers";
import type { DeletionOutcome } from "../../../packages/feed/tree.ts";
import type { PostView, ThreadSummary } from "../../../packages/protocol/index.ts";
import type { Env } from "../env.ts";
import type { CellEvent, ThreadLikedEvent, ThreadRepostedEvent } from "../events.ts";
import type { ThreadStoreApi } from "../services.ts";
import type { Outcome } from "../stores/outcome.ts";
import { durableSql } from "../stores/sql.ts";
import { ThreadDb, type CreateThreadInput, type RemoveInput, type ReplyInput, type Result } from "../stores/thread-db.ts";

/** One thread per object. Sends follow-on events to the queue and deletes itself when it expires. */
export class ThreadStore extends DurableObject<Env> implements ThreadStoreApi {
  private readonly db: ThreadDb;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new ThreadDb(durableSql(ctx.storage.sql));
    this.db.init();
  }

  async create(input: CreateThreadInput): Promise<Outcome<{ summary: ThreadSummary }>> {
    return this.finish(this.db.create(input));
  }

  async reply(input: ReplyInput): Promise<Outcome<{ post: PostView; summary: ThreadSummary }>> {
    return this.finish(this.db.reply(input));
  }

  async remove(input: RemoveInput): Promise<Outcome<{ outcome: DeletionOutcome }>> {
    const result = this.db.remove(input);
    if (result.outcome.ok && result.outcome.outcome === "remove_thread") {
      await this.send(result.events);
      await this.wipe();
      return result.outcome;
    }
    return this.finish(result);
  }

  async summary(now: number): Promise<Outcome<{ summary: ThreadSummary }>> {
    return this.db.summary(now);
  }

  async thread(now: number): Promise<Outcome<{ summary: ThreadSummary; posts: PostView[] }>> {
    return this.db.thread(now);
  }

  async applyLikes(events: ThreadLikedEvent[], now: number): Promise<void> {
    await this.send(this.db.applyLikes(events, now));
    await this.schedule();
  }

  async applyReposts(events: ThreadRepostedEvent[], now: number): Promise<void> {
    await this.send(this.db.applyReposts(events, now));
    await this.schedule();
  }

  async alarm(): Promise<void> {
    const events = this.db.expireIfDue(Date.now());
    if (events) {
      await this.send(events);
      await this.wipe();
      return;
    }
    await this.schedule();
  }

  private async finish<T>(result: Result<T>): Promise<Outcome<T>> {
    await this.send(result.events);
    await this.schedule();
    return result.outcome;
  }

  private async send(events: CellEvent[]): Promise<void> {
    if (events.length > 0) await this.env.FEED_EVENTS.sendBatch(events.map((body) => ({ body })));
  }

  private async schedule(): Promise<void> {
    const at = this.db.expiresAt();
    if (at !== null) await this.ctx.storage.setAlarm(at);
  }

  /** deleteAll drops every table, so recreate them for any late call this instance still receives. */
  private async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.db.init();
  }
}
```

- [ ] **Step 3: Cell index Durable Object**

Create `workers/edge/durable-objects/cell-index.ts`:

```ts
import { DurableObject } from "cloudflare:workers";
import { minuteOf } from "../../../packages/feed/partition.ts";
import { MERGE_QUIET_MINUTES } from "../../../packages/shared/constants.ts";
import type { Env } from "../env.ts";
import type { CellEvent } from "../events.ts";
import type { CellIndexApi } from "../services.ts";
import { CellIndexDb, type HasRefQuery, type RefPage, type RefQuery } from "../stores/cell-index-db.ts";
import { durableSql } from "../stores/sql.ts";

const ALARM_INTERVAL_MS = 60_000;

/** References for one partition cell. A once-a-minute alarm sweeps expired rows while there is anything to sweep. */
export class CellIndex extends DurableObject<Env> implements CellIndexApi {
  private readonly db: CellIndexDb;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new CellIndexDb(durableSql(ctx.storage.sql));
    this.db.init();
  }

  async apply(partition: string, events: CellEvent[], now: number): Promise<void> {
    this.db.setPartition(partition);
    this.db.apply(events, now);
    await this.ensureAlarm();
  }

  async query(partition: string, query: RefQuery): Promise<RefPage> {
    this.db.setPartition(partition);
    const page = this.db.query(query);
    await this.ensureAlarm();
    return page;
  }

  async hasRef(_partition: string, query: HasRefQuery): Promise<boolean> {
    return this.db.hasRef(query);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.db.sweep(now);
    const recentLoad = this.db.loadSamples().some((sample) => sample.minute >= minuteOf(now) - MERGE_QUIET_MINUTES);
    if (!this.db.isEmpty() || recentLoad) await this.ctx.storage.setAlarm(now + ALARM_INTERVAL_MS);
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }
}
```

- [ ] **Step 4: User state Durable Object**

Create `workers/edge/durable-objects/user-state.ts`:

```ts
import { DurableObject } from "cloudflare:workers";
import type { EngagementResponse } from "../../../packages/protocol/index.ts";
import type { Env } from "../env.ts";
import type { UserStateApi } from "../services.ts";
import { durableSql } from "../stores/sql.ts";
import { UserStateDb, type LikeInput, type RepostInput } from "../stores/user-state-db.ts";

const SWEEP_INTERVAL_MS = 60 * 60_000;

/** One of 65,536 buckets of per-user likes and reposts. */
export class UserState extends DurableObject<Env> implements UserStateApi {
  private readonly db: UserStateDb;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new UserStateDb(durableSql(ctx.storage.sql));
    this.db.init();
  }

  async like(input: LikeInput): Promise<{ changed: boolean; first: boolean }> {
    const result = this.db.like(input);
    await this.ensureAlarm();
    return result;
  }

  async repost(input: RepostInput): Promise<{ ok: boolean; first: boolean }> {
    const result = this.db.repost(input);
    await this.ensureAlarm();
    return result;
  }

  async engagement(userId: string, threadIds: string[]): Promise<EngagementResponse> {
    return this.db.engagement(userId, threadIds);
  }

  async alarm(): Promise<void> {
    this.db.sweep(Date.now());
    if (!this.db.isEmpty()) await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }
}
```

- [ ] **Step 5: Production services**

Create `workers/edge/services-env.ts`:

```ts
import { locationHintFor } from "../../packages/feed/location-hint.ts";
import type { PartitionMap, SplitEntry } from "../../packages/feed/partition.ts";
import { PARTITION_MAP_CACHE_MS } from "../../packages/shared/constants.ts";
import type { Env } from "./env.ts";
import type { CellIndexApi, LimitKind, Services, ThreadStoreApi, UserStateApi } from "./services.ts";
import { userStateName } from "./stores/user-state-db.ts";

let partitionCache: { map: PartitionMap; loadedAt: number } | null = null;

export function createServices(env: Env): Services {
  return {
    thread: (id, hint) =>
      env.THREAD_STORE.getByName(id, hint ? { locationHint: hint } : undefined) as unknown as ThreadStoreApi,
    cell: (partition) =>
      env.CELL_INDEX.getByName(partition, { locationHint: locationHintFor(partition) }) as unknown as CellIndexApi,
    user: async (userId) => env.USER_STATE.getByName(await userStateName(userId)) as unknown as UserStateApi,
    sendEvents: async (events) => {
      if (events.length > 0) await env.FEED_EVENTS.sendBatch(events.map((body) => ({ body })));
    },
    partitionMap: (now) => loadPartitionMap(env.PARTITION_MAP, now),
    limit: async (kind, key) => (await limiter(env, kind).limit({ key })).success,
    cache: {
      match: async (key) => (await caches.default.match(new Request(key))) ?? undefined,
      put: (key, response) => caches.default.put(new Request(key), response),
    },
  };
}

function limiter(env: Env, kind: LimitKind): RateLimit {
  if (kind === "like") return env.LIKE_LIMITER;
  if (kind === "read") return env.READ_LIMITER;
  return env.MESSAGE_LIMITER;
}

/** Each isolate re-reads the split list every 30 s; the 16-minute dual-read window covers KV propagation. */
async function loadPartitionMap(kv: KVNamespace, now: number): Promise<PartitionMap> {
  if (partitionCache && now - partitionCache.loadedAt < PARTITION_MAP_CACHE_MS) return partitionCache.map;
  const splits: Record<string, SplitEntry> = {};
  let cursor: string | undefined;
  do {
    const page = await kv.list<SplitEntry>({ prefix: "split:", cursor });
    for (const key of page.keys) if (key.metadata) splits[key.name.slice("split:".length)] = key.metadata;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  partitionCache = { map: { splits }, loadedAt: now };
  return partitionCache.map;
}
```

- [ ] **Step 6: Rewrite `env.ts`**

```ts
import type { FeedEvent } from "./events.ts";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  THREAD_STORE: DurableObjectNamespace;
  CELL_INDEX: DurableObjectNamespace;
  USER_STATE: DurableObjectNamespace;
  FEED_EVENTS: Queue<FeedEvent>;
  PARTITION_MAP: KVNamespace;
  MESSAGE_LIMITER: RateLimit;
  LIKE_LIMITER: RateLimit;
  READ_LIMITER: RateLimit;
  REGISTER_LIMITER: RateLimit;
  RP_NAME: string;
  RP_ID: string;
  ORIGIN: string;
  SESSION_KEY: string;
}
```

- [ ] **Step 7: Rewrite the Worker entry point**

Replace `workers/edge/index.ts` with:

```ts
import { handleAction } from "./api/actions.ts";
import type { ApiContext } from "./api/context.ts";
import { handleEngagement } from "./api/engagement.ts";
import { handleFeed } from "./api/feed.ts";
import { handleThread } from "./api/threads.ts";
import { handleAuth } from "./auth/routes.ts";
import { authenticate } from "./auth/session.ts";
import { CellIndex } from "./durable-objects/cell-index.ts";
import { ThreadStore } from "./durable-objects/thread-store.ts";
import { UserState } from "./durable-objects/user-state.ts";
import type { Env } from "./env.ts";
import type { FeedEvent } from "./events.ts";
import { appendCookies, errorResponse, HttpError, json, readJson } from "./http.ts";
import { consumeEvents } from "./queue/consumer.ts";
import { createServices } from "./services-env.ts";

export { CellIndex, ThreadStore, UserState };

const THREAD_PATH = /^\/api\/threads\/([0-9a-f-]{36})$/u;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/auth/")) return await handleAuth(request, env, url.pathname);
      if (url.pathname === "/api/client-error" && request.method === "POST") return await logClientError(request);
      if (url.pathname === "/api/health") return json({ ok: true });
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (error) {
      return errorResponse(error);
    }
  },

  async queue(batch: MessageBatch<FeedEvent>, env: Env): Promise<void> {
    try {
      await consumeEvents(batch.messages.map((message) => message.body), createServices(env), Date.now());
    } catch (error) {
      console.error("Feed event batch failed; retrying", error);
      batch.retryAll();
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
      env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
    ]);
  },
} satisfies ExportedHandler<Env, FeedEvent>;

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  // SameSite cookies stop cross-site pages, not sibling subdomains.
  if (request.method === "POST" && request.headers.get("origin") !== env.ORIGIN) {
    throw new HttpError(403, "FORBIDDEN_ORIGIN");
  }
  const auth = await authenticate(request, env);
  if (!auth) throw new HttpError(401, "UNAUTHORIZED");
  const ctx: ApiContext = { services: createServices(env), user: auth.user, now: Date.now() };
  return appendCookies(await route(request, url, ctx), auth.setCookies);
}

async function route(request: Request, url: URL, ctx: ApiContext): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/feed") return handleFeed(url, request, ctx);
  if (request.method === "GET" && url.pathname === "/api/me/engagement") return handleEngagement(url, ctx);
  if (request.method === "POST" && url.pathname === "/api/actions") return handleAction(request, ctx);
  const thread = THREAD_PATH.exec(url.pathname);
  if (request.method === "GET" && thread) return handleThread(thread[1]!, url, request, ctx);
  throw new HttpError(404, "NOT_FOUND");
}

async function logClientError(request: Request): Promise<Response> {
  const input = await readJson<{ area?: unknown; operation?: unknown; name?: unknown; message?: unknown }>(request);
  const area = boundedDiagnostic(input.area, 32);
  const operation = boundedDiagnostic(input.operation, 32);
  const name = boundedDiagnostic(input.name, 80);
  const message = boundedDiagnostic(input.message, 300);
  console.warn("Client error", { area, operation, name, message });
  return new Response(null, { status: 204 });
}

function boundedDiagnostic(value: unknown, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit) : "unknown";
}
```

Then delete the old socket Durable Object:

```bash
git rm workers/edge/durable-objects/geo-shard.ts
```

- [ ] **Step 8: Rewrite `wrangler.jsonc`**

Replace the file with the following, putting the KV id printed in Step 1 where it says `REPLACE_WITH_PARTITION_MAP_ID`:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "nearline",
  "main": "workers/edge/index.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*"]
  },
  "routes": [
    { "pattern": "nearline.sxm.li", "custom_domain": true }
  ],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "proximity-chat-auth",
      "database_id": "5556c6eb-50bb-4c78-ae6e-63623074018b",
      "migrations_dir": "migrations/d1"
    }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "THREAD_STORE", "class_name": "ThreadStore" },
      { "name": "CELL_INDEX", "class_name": "CellIndex" },
      { "name": "USER_STATE", "class_name": "UserState" }
    ]
  },
  "exports": {
    "GeoShardLive": { "type": "durable-object", "state": "deleted" },
    "ThreadStore": { "type": "durable-object", "storage": "sqlite" },
    "CellIndex": { "type": "durable-object", "storage": "sqlite" },
    "UserState": { "type": "durable-object", "storage": "sqlite" }
  },
  "queues": {
    "producers": [{ "binding": "FEED_EVENTS", "queue": "nearline-feed-events" }],
    "consumers": [{ "queue": "nearline-feed-events", "max_batch_size": 100, "max_batch_timeout": 1, "max_retries": 10 }]
  },
  "kv_namespaces": [
    { "binding": "PARTITION_MAP", "id": "REPLACE_WITH_PARTITION_MAP_ID" }
  ],
  "ratelimits": [
    { "name": "MESSAGE_LIMITER", "namespace_id": "1002", "simple": { "limit": 20, "period": 10 } },
    { "name": "REGISTER_LIMITER", "namespace_id": "1003", "simple": { "limit": 3, "period": 60 } },
    { "name": "LIKE_LIMITER", "namespace_id": "1004", "simple": { "limit": 30, "period": 10 } },
    { "name": "READ_LIMITER", "namespace_id": "1005", "simple": { "limit": 120, "period": 60 } }
  ],
  "triggers": { "crons": ["17 * * * *"] },
  "vars": {
    "RP_NAME": "Nearline",
    "RP_ID": "nearline.sxm.li",
    "ORIGIN": "https://nearline.sxm.li"
  },
  "observability": { "enabled": true }
}
```

- [ ] **Step 9: Verify**

Run:

```bash
npm test && npm run typecheck && npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

Expected: tests pass; typecheck exits 0; the dry run lists the `THREAD_STORE`, `CELL_INDEX`, `USER_STATE`, `FEED_EVENTS`, `PARTITION_MAP` and four rate-limit bindings and ends with `--dry-run: exiting now.` The browser client still uses WebSockets at this point and is not deployable; Task 17 replaces it.

- [ ] **Step 10: Commit**

```bash
git add -A workers/edge wrangler.jsonc
git commit -F - <<'EOF'
feat(worker): wire thread, cell and user Durable Objects, queue and KV

Replaces the geographic socket shard with pull-only HTTP routes.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---

### Task 15: Automatic partition splitting and merging

**Files:**
- Create: `workers/edge/durable-objects/partition-maintenance.ts`
- Modify: `workers/edge/durable-objects/cell-index.ts`
- Test: `tests/partition-maintenance.test.ts`

**Interfaces:**
- Consumes: `shouldSplit`, `isQuiet`, `minuteOf`, `SplitEntry` (Task 6); `childrenOf`, `parentAt`, `resolutionOf` (Task 2); `CellIndexDb.partition()` and `loadSamples()` (Task 9).
- Produces:
  - `interface PartitionKv { getWithMetadata<M>(key: string): Promise<{ value: string | null; metadata: M | null }>; get(key: string): Promise<string | null>; put(key: string, value: string, options?: { metadata?: unknown; expirationTtl?: number }): Promise<void> }`
  - `maintainPartition(db: Pick<CellIndexDb, "partition" | "loadSamples">, kv: PartitionKv, now: number): Promise<"split" | "merged" | "busy" | "idle">`

- [ ] **Step 1: Write the failing test**

Create `tests/partition-maintenance.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { childrenOf, latLngToCanonicalLocation, parentAt } from "../packages/geo/index.ts";
import type { LoadSample, SplitEntry } from "../packages/feed/partition.ts";
import { MERGE_QUIET_MINUTES, SPLIT_WRITES_PER_MINUTE } from "../packages/shared/constants.ts";
import { maintainPartition, type PartitionKv } from "../workers/edge/durable-objects/partition-maintenance.ts";

const london = latLngToCanonicalLocation(51.5074, -0.1278);
const r7 = parentAt(london, 7);
const r8 = parentAt(london, 8);
const NOW = 100 * 60_000;

function fakeKv(initial: Record<string, { value: string; metadata?: unknown }> = {}) {
  const store = new Map(Object.entries(initial));
  const kv: PartitionKv = {
    async getWithMetadata<M>(key: string) {
      const item = store.get(key);
      return { value: item?.value ?? null, metadata: (item?.metadata as M | undefined) ?? null };
    },
    async get(key) { return store.get(key)?.value ?? null; },
    async put(key, value, options) { store.set(key, { value, metadata: options?.metadata }); },
  };
  return { kv, store };
}

const db = (partition: string | null, samples: LoadSample[]) => ({ partition: () => partition, loadSamples: () => samples });
const busyMinutes = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ minute: 100 - count + i, writes: SPLIT_WRITES_PER_MINUTE + 1, reads: 0 }));

describe("partition maintenance", () => {
  it("splits a partition after sustained load", async () => {
    const { kv, store } = fakeKv();
    expect(await maintainPartition(db(r7, busyMinutes(5)), kv, NOW)).toBe("split");
    expect(store.get(`split:${r7}`)?.metadata).toEqual({ splitAt: NOW } satisfies SplitEntry);
  });

  it("marks moderately busy partitions so their parent does not merge", async () => {
    const { kv, store } = fakeKv();
    const samples = [{ minute: 99, writes: SPLIT_WRITES_PER_MINUTE / 2, reads: 0 }];
    expect(await maintainPartition(db(r8, samples), kv, NOW)).toBe("busy");
    expect(store.has(`busy:${r8}`)).toBe(true);
  });

  it("merges a long-split parent once none of its children are busy", async () => {
    const splitAt = NOW - (MERGE_QUIET_MINUTES + 1) * 60_000;
    const { kv, store } = fakeKv({ [`split:${r7}`]: { value: "", metadata: { splitAt } } });
    expect(await maintainPartition(db(r8, []), kv, NOW)).toBe("merged");
    expect(store.get(`split:${r7}`)?.metadata).toEqual({ splitAt, mergedAt: NOW });
  });

  it("does not merge while a sibling is busy or the split is recent", async () => {
    const splitAt = NOW - (MERGE_QUIET_MINUTES + 1) * 60_000;
    const sibling = childrenOf(r7).find((cell) => cell !== r8)!;
    const busy = fakeKv({ [`split:${r7}`]: { value: "", metadata: { splitAt } }, [`busy:${sibling}`]: { value: "1" } });
    expect(await maintainPartition(db(r8, []), busy.kv, NOW)).toBe("idle");
    const recent = fakeKv({ [`split:${r7}`]: { value: "", metadata: { splitAt: NOW - 60_000 } } });
    expect(await maintainPartition(db(r8, []), recent.kv, NOW)).toBe("idle");
  });

  it("does nothing without a known partition or at the base resolution", async () => {
    const { kv } = fakeKv();
    expect(await maintainPartition(db(null, []), kv, NOW)).toBe("idle");
    expect(await maintainPartition(db(r7, []), kv, NOW)).toBe("idle");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/partition-maintenance.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `workers/edge/durable-objects/partition-maintenance.ts`:

```ts
import { isQuiet, minuteOf, shouldSplit, type SplitEntry } from "../../../packages/feed/partition.ts";
import { childrenOf, parentAt, resolutionOf } from "../../../packages/geo/index.ts";
import {
  MERGE_QUIET_MINUTES,
  PARTITION_BASE_RESOLUTION,
  PARTITION_DUAL_READ_MS,
} from "../../../packages/shared/constants.ts";
import type { CellIndexDb } from "../stores/cell-index-db.ts";

/** The slice of Workers KV used for the partition map. */
export interface PartitionKv {
  getWithMetadata<M>(key: string): Promise<{ value: string | null; metadata: M | null }>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { metadata?: unknown; expirationTtl?: number }): Promise<void>;
}

const BUSY_TTL_SECONDS = 300;

/**
 * Runs from a cell index's minute alarm.
 * - Sustained load splits this partition (`split:<cell>` with `splitAt`).
 * - A partition that is not quiet writes a short-lived `busy:<cell>` key. Partitions with no traffic
 *   write nothing and count as quiet, which is why busy keys veto a merge instead of quiet keys allowing one.
 * - A quiet child of a long-split parent merges the parent back when no sibling is busy.
 * Each key is its own KV entry, so concurrent partitions never overwrite each other's decisions.
 */
export async function maintainPartition(
  db: Pick<CellIndexDb, "partition" | "loadSamples">,
  kv: PartitionKv,
  now: number,
): Promise<"split" | "merged" | "busy" | "idle"> {
  const partition = db.partition();
  if (!partition) return "idle";
  const minute = minuteOf(now);
  const samples = db.loadSamples();
  const resolution = resolutionOf(partition);

  if (shouldSplit(samples, minute, resolution)) {
    const existing = (await kv.getWithMetadata<SplitEntry>(`split:${partition}`)).metadata;
    if (!existing || existing.mergedAt !== undefined) {
      await kv.put(`split:${partition}`, "", { metadata: { splitAt: now } satisfies SplitEntry });
    }
    return "split";
  }

  if (!isQuiet(samples, minute)) {
    await kv.put(`busy:${partition}`, "1", { expirationTtl: BUSY_TTL_SECONDS });
    return "busy";
  }

  if (resolution <= PARTITION_BASE_RESOLUTION) return "idle";
  const parent = parentAt(partition, resolution - 1);
  const entry = (await kv.getWithMetadata<SplitEntry>(`split:${parent}`)).metadata;
  if (!entry || entry.mergedAt !== undefined || now - entry.splitAt < MERGE_QUIET_MINUTES * 60_000) return "idle";
  const busy = await Promise.all(childrenOf(parent).map((child) => kv.get(`busy:${child}`)));
  if (busy.some((value) => value !== null)) return "idle";
  await kv.put(`split:${parent}`, "", {
    metadata: { splitAt: entry.splitAt, mergedAt: now } satisfies SplitEntry,
    // The merged entry is needed only for the dual-read window; KV then deletes it.
    expirationTtl: Math.ceil(PARTITION_DUAL_READ_MS / 1_000) + 120,
  });
  return "merged";
}
```

- [ ] **Step 4: Call it from the cell index alarm**

In `workers/edge/durable-objects/cell-index.ts`, add the import:

```ts
import { maintainPartition } from "./partition-maintenance.ts";
```

and in `alarm()`, directly after `this.db.sweep(now);`, add:

```ts
    try {
      await maintainPartition(this.db, this.env.PARTITION_MAP, now);
    } catch (error) {
      // Partition tuning is best-effort; sweeping must keep running.
      console.warn("Partition maintenance failed", error);
    }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/partition-maintenance.test.ts && npm test && npm run typecheck`
Expected: 5 maintenance tests pass; whole suite passes; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add workers/edge/durable-objects/partition-maintenance.ts workers/edge/durable-objects/cell-index.ts tests/partition-maintenance.test.ts
git commit -F - <<'EOF'
feat(feed): split busy partitions and merge quiet ones automatically

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---
### Task 16: Client state, polling and HTTP calls

**Files:**
- Create: `apps/web/feed-state.ts`, `apps/web/poller.ts`, `apps/web/api.ts`
- Test: `tests/feed-state.test.ts`, `tests/poller.test.ts`

**Interfaces:**
- Consumes: protocol types (Task 4), `decayedScore` (Task 1), `deletionOutcome` (Task 3), constants.
- Produces:
  - `feed-state.ts`: `interface ThreadEntry { summary: ThreadSummary; via: Anchor; pending: boolean }`; `interface OpenThread { id: string; summary: ThreadSummary | null; posts: PostView[]; etag: string | null; loaded: boolean; focusId: string | null; faded: boolean }`; `class FeedState` with fields `threads`, `lists`, `cursors`, `etags`, `likedPosts`, `repostedThreads`, `pendingReplies`, `open`, and methods `now`, `setServerTime`, `reset`, `applyHead`, `applyMore`, `applyEngagement`, `takeUnflagged`, `visibleIds`, `addPendingThread`, `confirmPendingThread`, `failPendingThread`, `remove`, `prune`, `resortTrending`, `likeCount`, `repostCount`, `setLiked`, `setReposted`, `beginOpen`, `applyTree`, `markFaded`, `closeOpen`, `focus`, `addPendingReply`, `confirmReply`, `failReply`, `removePost` (signatures in Step 3).
  - `poller.ts`: `nextDelay(base: number, current: number, unchangedForMs: number): number`; `class Poller { constructor(base: number, task: () => Promise<boolean>, clock?: () => number); start(): void; stop(): void; poke(): void }`
  - `api.ts`: `type Fetched<T>`; `fetchFeed(params, etag)`, `fetchThread(threadId, room, etag)`, `fetchEngagement(threadIds)`, `sendAction(action)`.

- [ ] **Step 1: Write the failing state test**

Create `tests/feed-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Anchor, FeedItem, PostView, ThreadSummary } from "../packages/protocol/index.ts";
import { FeedState } from "../apps/web/feed-state.ts";

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const via = (createdAt: number, kind: Anchor["kind"] = "root"): Anchor => ({ cell11: "8b195da49b48fff", kind, byAuthor: "aaaa0001", createdAt });

function summary(n: number, extra: Partial<ThreadSummary> = {}): ThreadSummary {
  const root: PostView = { id: id(n), threadId: id(n), parentId: null, author: "aaaa0001", body: `post ${n}`, createdAt: n, deleted: false, likeCount: 0 };
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
    expect(state.takeUnflagged().sort()).toEqual([id(1), id(2)]);
    expect(state.takeUnflagged()).toEqual([]);
    state.applyEngagement({ liked: [id(1)], reposted: [id(2)] });
    expect(state.likedPosts.has(id(1))).toBe(true);
    expect(state.repostedThreads.has(id(2))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/feed-state.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the client state**

Create `apps/web/feed-state.ts`:

```ts
import { decayedScore } from "../../packages/feed/score.ts";
import { deletionOutcome } from "../../packages/feed/tree.ts";
import type {
  Anchor,
  EngagementResponse,
  FeedItem,
  FeedTab,
  PostView,
  ThreadResponse,
  ThreadSummary,
} from "../../packages/protocol/index.ts";
import { MAX_ENGAGEMENT_IDS, TREND_MIN_PARTICIPANTS } from "../../packages/shared/constants.ts";

export interface ThreadEntry {
  summary: ThreadSummary;
  via: Anchor;
  pending: boolean;
}

export interface OpenThread {
  id: string;
  summary: ThreadSummary | null;
  posts: PostView[];
  etag: string | null;
  loaded: boolean;
  focusId: string | null;
  faded: boolean;
}

interface CountOverride {
  base: number;
  delta: number;
  until: number;
}

const TABS: readonly FeedTab[] = ["latest", "trending"];
/** How long an optimistic count is shown while the queue catches up. */
const OVERRIDE_MS = 15_000;

/** Everything the page shows, independent of the DOM so it can be unit tested. */
export class FeedState {
  readonly threads = new Map<string, ThreadEntry>();
  readonly lists: Record<FeedTab, string[]> = { latest: [], trending: [] };
  readonly cursors: Record<FeedTab, string | null> = { latest: null, trending: null };
  readonly etags: Record<FeedTab, string | null> = { latest: null, trending: null };
  readonly likedPosts = new Set<string>();
  readonly repostedThreads = new Set<string>();
  readonly pendingReplies = new Set<string>();
  open: OpenThread | null = null;
  private clockOffset = 0;
  private readonly flagged = new Set<string>();
  private readonly likeOverrides = new Map<string, CountOverride>();
  private readonly repostOverrides = new Map<string, CountOverride>();

  /** Server time, so a wrong phone clock cannot fade posts early or late. */
  now(clientNow = Date.now()): number {
    return clientNow + this.clockOffset;
  }

  setServerTime(serverTime: number, clientNow = Date.now()): void {
    this.clockOffset = serverTime - clientNow;
  }

  /** The range, room or location changed: what is shown belongs to another view. */
  reset(): void {
    for (const [id, entry] of this.threads) if (!entry.pending) this.threads.delete(id);
    for (const tab of TABS) {
      this.lists[tab] = this.lists[tab].filter((id) => this.threads.has(id));
      this.cursors[tab] = null;
      this.etags[tab] = null;
    }
  }

  /** The first page of a poll becomes the head of the list; older loaded items stay below. Returns ids new to this tab. */
  applyHead(tab: FeedTab, items: readonly FeedItem[], nextCursor: string | null, etag: string | null): string[] {
    const known = new Set(this.lists[tab]);
    const loadedMorePages = this.cursors[tab] !== null && this.lists[tab].length > items.length;
    for (const item of items) this.upsert(item);
    const head = items.map((item) => item.summary.id);
    const inHead = new Set(head);
    const pending = this.lists[tab].filter((id) => this.threads.get(id)?.pending);
    const tail = this.lists[tab].filter((id) => !inHead.has(id) && this.threads.has(id) && !this.threads.get(id)!.pending);
    this.lists[tab] = [...pending, ...head, ...tail];
    if (!loadedMorePages) this.cursors[tab] = nextCursor;
    this.etags[tab] = etag;
    return head.filter((id) => !known.has(id));
  }

  applyMore(tab: FeedTab, items: readonly FeedItem[], nextCursor: string | null): void {
    for (const item of items) this.upsert(item);
    const known = new Set(this.lists[tab]);
    this.lists[tab].push(...items.map((item) => item.summary.id).filter((id) => !known.has(id)));
    this.cursors[tab] = nextCursor;
  }

  applyEngagement(response: EngagementResponse): void {
    for (const id of response.liked) this.likedPosts.add(id);
    for (const id of response.reposted) this.repostedThreads.add(id);
  }

  /** Thread ids whose engagement has not been asked for yet. Marks them as asked. */
  takeUnflagged(): string[] {
    const ids = [...this.threads.values()]
      .filter((entry) => !entry.pending && !this.flagged.has(entry.summary.id))
      .map((entry) => entry.summary.id)
      .slice(0, MAX_ENGAGEMENT_IDS);
    for (const id of ids) this.flagged.add(id);
    return ids;
  }

  visibleIds(tab: FeedTab): string[] {
    return this.lists[tab].filter((id) => this.threads.has(id));
  }

  addPendingThread(summary: ThreadSummary, via: Anchor): void {
    this.threads.set(summary.id, { summary, via, pending: true });
    this.lists.latest = [summary.id, ...this.lists.latest];
  }

  /** If a poll already brought the real thread, drop the placeholder; otherwise rename it to the real id. */
  confirmPendingThread(tempId: string, postId: string): void {
    const temp = this.threads.get(tempId);
    this.threads.delete(tempId);
    if (!temp) return;
    if (this.threads.has(postId)) {
      for (const tab of TABS) this.lists[tab] = this.lists[tab].filter((id) => id !== tempId);
      return;
    }
    const root = { ...temp.summary.root, id: postId, threadId: postId };
    this.threads.set(postId, { summary: { ...temp.summary, id: postId, root }, via: temp.via, pending: false });
    for (const tab of TABS) this.lists[tab] = this.lists[tab].map((id) => (id === tempId ? postId : id));
  }

  failPendingThread(tempId: string): void {
    this.threads.delete(tempId);
    for (const tab of TABS) this.lists[tab] = this.lists[tab].filter((id) => id !== tempId);
  }

  remove(threadId: string): void {
    this.threads.delete(threadId);
    for (const tab of TABS) this.lists[tab] = this.lists[tab].filter((id) => id !== threadId);
    if (this.open?.id === threadId) this.open.faded = true;
  }

  prune(now: number): string[] {
    const expired = [...this.threads.values()]
      .filter((entry) => !entry.pending && entry.summary.expiresAt <= now)
      .map((entry) => entry.summary.id);
    for (const id of expired) this.remove(id);
    if (this.open?.summary && this.open.summary.expiresAt <= now) this.open.faded = true;
    return expired;
  }

  resortTrending(now: number): void {
    const current = (entry: ThreadEntry) => decayedScore({ value: entry.summary.score, at: entry.summary.scoreAt }, now);
    this.lists.trending = [...this.threads.values()]
      .filter((entry) => !entry.pending && entry.summary.participantCount >= TREND_MIN_PARTICIPANTS)
      .sort((a, b) => current(b) - current(a) || b.summary.lastActivityAt - a.summary.lastActivityAt)
      .map((entry) => entry.summary.id);
  }

  likeCount(postId: string, serverCount: number, now: number): number {
    return readOverride(this.likeOverrides, postId, serverCount, now);
  }

  repostCount(threadId: string, serverCount: number, now: number): number {
    return readOverride(this.repostOverrides, threadId, serverCount, now);
  }

  setLiked(postId: string, on: boolean, serverCount: number, now: number): void {
    if (this.likedPosts.has(postId) === on) return;
    if (on) this.likedPosts.add(postId);
    else this.likedPosts.delete(postId);
    writeOverride(this.likeOverrides, postId, on ? 1 : -1, serverCount, now);
  }

  setReposted(threadId: string, on: boolean, serverCount: number, now: number): void {
    if (this.repostedThreads.has(threadId) === on) return;
    if (on) this.repostedThreads.add(threadId);
    else this.repostedThreads.delete(threadId);
    writeOverride(this.repostOverrides, threadId, on ? 1 : -1, serverCount, now);
  }

  beginOpen(threadId: string): void {
    this.open = {
      id: threadId,
      summary: this.threads.get(threadId)?.summary ?? null,
      posts: [],
      etag: null,
      loaded: false,
      focusId: null,
      faded: false,
    };
  }

  applyTree(response: ThreadResponse, etag: string | null): void {
    const open = this.open;
    if (!open || open.id !== response.summary.id) return;
    const known = new Set(response.posts.map((post) => post.id));
    const pending = open.posts.filter((post) => this.pendingReplies.has(post.id) && !known.has(post.id));
    open.posts = [...response.posts, ...pending];
    open.summary = response.summary;
    open.etag = etag;
    open.loaded = true;
    open.faded = false;
    const entry = this.threads.get(response.summary.id);
    if (entry) entry.summary = response.summary;
  }

  markFaded(threadId: string): void {
    if (this.open?.id === threadId) this.open.faded = true;
  }

  closeOpen(): void {
    this.open = null;
  }

  focus(postId: string | null): void {
    if (this.open) this.open.focusId = postId;
  }

  addPendingReply(post: PostView): void {
    if (!this.open || this.open.id !== post.threadId) return;
    this.pendingReplies.add(post.id);
    this.open.posts = [...this.open.posts, post];
  }

  confirmReply(tempId: string, postId: string): void {
    this.pendingReplies.delete(tempId);
    const open = this.open;
    if (!open) return;
    if (open.posts.some((post) => post.id === postId)) {
      open.posts = open.posts.filter((post) => post.id !== tempId);
      return;
    }
    open.posts = open.posts.map((post) => (post.id === tempId ? { ...post, id: postId } : post));
  }

  failReply(tempId: string): void {
    this.pendingReplies.delete(tempId);
    if (this.open) this.open.posts = this.open.posts.filter((post) => post.id !== tempId);
  }

  removePost(postId: string): void {
    const open = this.open;
    if (!open) return;
    const outcome = deletionOutcome(open.posts, postId);
    if (outcome === "remove") open.posts = open.posts.filter((post) => post.id !== postId);
    else if (outcome === "placeholder") {
      open.posts = open.posts.map((post) => (post.id === postId ? { ...post, body: "", deleted: true, likeCount: 0 } : post));
    } else if (outcome === "remove_thread") this.remove(open.id);
  }

  private upsert(item: FeedItem): void {
    const existing = this.threads.get(item.summary.id);
    const via = existing && !existing.pending && existing.via.createdAt > item.via.createdAt ? existing.via : item.via;
    this.threads.set(item.summary.id, { summary: item.summary, via, pending: false });
  }
}

/** Shows base + delta until the server's count moves away from the base it was taken against, or time runs out. */
function readOverride(map: Map<string, CountOverride>, key: string, serverCount: number, now: number): number {
  const override = map.get(key);
  if (!override) return serverCount;
  if (now >= override.until || serverCount !== override.base) {
    map.delete(key);
    return serverCount;
  }
  return Math.max(0, override.base + override.delta);
}

function writeOverride(map: Map<string, CountOverride>, key: string, step: number, serverCount: number, now: number): void {
  const current = map.get(key);
  const carried = current && now < current.until && current.base === serverCount ? current.delta : 0;
  map.set(key, { base: serverCount, delta: carried + step, until: now + OVERRIDE_MS });
}
```

- [ ] **Step 4: Run the state tests**

Run: `npx vitest run tests/feed-state.test.ts`
Expected: 9 tests pass.

- [ ] **Step 5: Write the failing poller test**

Create `tests/poller.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextDelay, Poller } from "../apps/web/poller.ts";
import { POLL_BACKOFF_AFTER_MS, POLL_FEED_MS, POLL_MAX_MS } from "../packages/shared/constants.ts";

describe("polling", () => {
  it("backs off only after a minute without change, up to the cap", () => {
    expect(nextDelay(POLL_FEED_MS, POLL_FEED_MS, POLL_BACKOFF_AFTER_MS - 1)).toBe(POLL_FEED_MS);
    expect(nextDelay(POLL_FEED_MS, POLL_FEED_MS, POLL_BACKOFF_AFTER_MS)).toBe(POLL_FEED_MS * 2);
    expect(nextDelay(POLL_FEED_MS, 20_000, POLL_BACKOFF_AFTER_MS)).toBe(POLL_MAX_MS);
  });

  describe("Poller", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("polls immediately, repeats, and stops", async () => {
      const task = vi.fn(async () => true);
      const poller = new Poller(1_000, task, () => Date.now());
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(task).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(task).toHaveBeenCalledTimes(2);
      poller.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(task).toHaveBeenCalledTimes(2);
    });

    it("runs at once when poked", async () => {
      const task = vi.fn(async () => false);
      const poller = new Poller(10_000, task, () => Date.now());
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      poller.poke();
      await vi.advanceTimersByTimeAsync(0);
      expect(task).toHaveBeenCalledTimes(2);
      poller.stop();
    });
  });
});
```

- [ ] **Step 6: Implement the poller**

Create `apps/web/poller.ts`:

```ts
import { POLL_BACKOFF_AFTER_MS, POLL_MAX_MS } from "../../packages/shared/constants.ts";

/** Base interval while things change; doubling after a quiet minute, capped. */
export function nextDelay(base: number, current: number, unchangedForMs: number): number {
  if (unchangedForMs < POLL_BACKOFF_AFTER_MS) return base;
  return Math.min(POLL_MAX_MS, Math.max(base, current * 2));
}

/** Runs `task` repeatedly. `task` resolves true when it found something new. */
export class Poller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delay: number;
  private lastChange: number;
  private running = false;
  private inFlight = false;

  constructor(
    private readonly base: number,
    private readonly task: () => Promise<boolean>,
    private readonly clock: () => number = Date.now,
  ) {
    this.delay = base;
    this.lastChange = clock();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Something happened (a user action, a tab switch): poll now and reset the backoff. */
  poke(): void {
    this.lastChange = this.clock();
    this.delay = this.base;
    if (!this.running) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    let changed = false;
    try {
      changed = await this.task();
    } catch {
      changed = false;
    } finally {
      this.inFlight = false;
    }
    if (changed) this.lastChange = this.clock();
    this.delay = changed ? this.base : nextDelay(this.base, this.delay, this.clock() - this.lastChange);
    if (this.running && this.timer === null) this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, this.delay);
  }
}
```

- [ ] **Step 7: Create the HTTP client**

Create `apps/web/api.ts`:

```ts
import type {
  ActionRequest,
  ActionResponse,
  EngagementResponse,
  FeedResponse,
  FeedTab,
  ThreadResponse,
} from "../../packages/protocol/index.ts";
import type { ProximityScope } from "../../packages/shared/constants.ts";

export type Fetched<T> =
  | { status: "fresh"; data: T; etag: string | null }
  | { status: "unchanged" }
  | { status: "gone" }
  | { status: "unauthorized" }
  | { status: "error" };

export interface FeedParams {
  cell: string;
  scope: ProximityScope;
  room: string;
  tab: FeedTab;
  cursor: string | null;
}

async function getJson<T>(url: string, etag: string | null): Promise<Fetched<T>> {
  let response: Response;
  try {
    response = await fetch(url, { headers: etag ? { "if-none-match": etag } : {}, credentials: "same-origin" });
  } catch {
    return { status: "error" };
  }
  if (response.status === 304) return { status: "unchanged" };
  if (response.status === 401) return { status: "unauthorized" };
  if (response.status === 404 || response.status === 410) return { status: "gone" };
  if (!response.ok) return { status: "error" };
  return { status: "fresh", data: await response.json() as T, etag: response.headers.get("etag") };
}

export function fetchFeed(params: FeedParams, etag: string | null): Promise<Fetched<FeedResponse>> {
  const query = new URLSearchParams({ cell: params.cell, scope: String(params.scope), room: params.room, tab: params.tab });
  if (params.cursor) query.set("cursor", params.cursor);
  return getJson<FeedResponse>(`/api/feed?${query}`, etag);
}

export function fetchThread(threadId: string, room: string, etag: string | null): Promise<Fetched<ThreadResponse>> {
  return getJson<ThreadResponse>(`/api/threads/${threadId}?${new URLSearchParams({ room })}`, etag);
}

export async function fetchEngagement(threadIds: readonly string[]): Promise<EngagementResponse | null> {
  if (threadIds.length === 0) return null;
  const result = await getJson<EngagementResponse>(`/api/me/engagement?${new URLSearchParams({ threads: threadIds.join(",") })}`, null);
  return result.status === "fresh" ? result.data : null;
}

export async function sendAction(action: ActionRequest): Promise<ActionResponse> {
  try {
    const response = await fetch("/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
      credentials: "same-origin",
    });
    if (response.status === 401) return { id: action.id, ok: false, code: "UNAUTHORIZED" };
    return await response.json() as ActionResponse;
  } catch {
    return { id: action.id, ok: false, code: "UNAVAILABLE" };
  }
}
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run tests/feed-state.test.ts tests/poller.test.ts && npm test && npm run typecheck`
Expected: all pass. (`apps/web/main.ts` still compiles against the legacy socket types; Task 17 replaces it.)

- [ ] **Step 9: Commit**

```bash
git add apps/web/feed-state.ts apps/web/poller.ts apps/web/api.ts tests/feed-state.test.ts tests/poller.test.ts
git commit -F - <<'EOF'
feat(web): add client feed state, poller and HTTP client

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---

### Task 17: The feed interface, and removal of the chat code

**Files:**
- Rewrite: `public/index.html`, `apps/web/main.ts`
- Modify: `public/styles.css`
- Create: `apps/web/render-post.ts`, `apps/web/render-feed.ts`, `apps/web/render-thread.ts`
- Modify (legacy removal): `packages/protocol/index.ts`, `packages/geo/index.ts`, `packages/shared/constants.ts`, `tests/geo.test.ts`, `tests/protocol.test.ts`

**Interfaces:**
- Consumes: `FeedState`, `Poller`, `api.ts` (Task 16); `buildTree`, `findNode`, `ancestry`, `countDescendants` (Task 3); constants.
- Produces:
  - `render-post.ts`: `type IconName`, `icon(name: IconName): SVGSVGElement`, `authorColor(author: string): string`, `formatAge(timestamp: number, now: number): string`, `interface PostCardOptions`, `renderPostCard(options: PostCardOptions): HTMLElement`
  - `render-feed.ts`: `renderFeed(list: HTMLElement, state: FeedState, tab: FeedTab, ctx: { currentAuthor: string; now: number }): void`, `refreshTimes(root: ParentNode, now: number): void`
  - `render-thread.ts`: `renderThread(container: HTMLElement, state: FeedState, currentAuthor: string, now: number): void`

Before editing any UI file, load the `impeccable` skill (craft floor) and read the direction contract in `.impeccable/surfaces/public-index-html.md`. The visual world is fixed: asphalt ground, paint ink, yellow only for private filters, signal green only for "live", road-stud author chips, solid paint for primary and dashed for yield. Build within it.

- [ ] **Step 1: Replace `public/index.html`**

```html
<!doctype html>
<html lang="en" data-scope="10">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
    <meta name="theme-color" content="#18191b">
    <meta name="description" content="A live local feed for people nearby.">
    <title>Nearline</title>
    <link rel="preload" href="/fonts/barlow-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/fonts/barlow-condensed-latin-800-normal.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/styles.css">
    <script type="module" src="/app.js"></script>
  </head>
  <body>
    <main id="auth-view" class="gate" hidden>
      <div class="gate-road" aria-hidden="true">
        <span class="road-word">Nearline</span>
        <span class="road-stop"></span>
      </div>
      <section class="gate-content" aria-labelledby="auth-title">
        <p class="sr-only">Nearline</p>
        <h1 id="auth-title">Talk to people nearby.</h1>
        <p class="gate-copy">Posts from around you. Every thread fades fifteen minutes after it goes quiet.</p>
        <div class="gate-actions">
          <button id="login-button" class="button primary" type="button">Continue with passkey</button>
          <button id="register-button" class="button secondary" type="button">New here? Create a passkey</button>
        </div>
        <p class="support-copy">No username or password. <a class="text-link" href="/how-it-works.html">How Nearline works</a></p>
      </section>
    </main>

    <main id="location-view" class="gate" hidden>
      <div class="gate-road" aria-hidden="true">
        <span class="road-word">Nearline</span>
        <span class="road-stop"></span>
      </div>
      <section class="gate-content" aria-labelledby="location-title">
        <p class="sr-only">Nearline</p>
        <h1 id="location-title">Enter the local line.</h1>
        <p id="location-copy" class="gate-copy">Nearline shows posts from around you. Location is required to continue.</p>
        <button id="location-button" class="button primary" type="button">Use my location</button>
      </section>
    </main>

    <main id="chat-view" class="app-shell" hidden>
      <aside class="sidebar" aria-label="Nearline controls">
        <div class="sidebar-brand">
          <span class="painted-mark">Nearline</span>
        </div>

        <section class="sidebar-section" aria-labelledby="range-heading">
          <h2 id="range-heading" class="group-label">Range</h2>
          <div class="range-control vertical" role="group" aria-labelledby="range-heading">
            <button type="button" data-scope="11" aria-pressed="false"><span>Close</span><small>about a block</small></button>
            <button type="button" data-scope="10" aria-pressed="true"><span>Nearby</span><small>a few blocks</small></button>
            <button type="button" data-scope="9" aria-pressed="false"><span>Wide</span><small>the neighbourhood</small></button>
          </div>
        </section>

        <section class="sidebar-section" aria-labelledby="view-heading">
          <h2 id="view-heading" class="group-label">View</h2>
          <button class="view-toggle" data-room-button type="button" aria-haspopup="dialog" aria-controls="room-dialog">
            <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>
            <span data-room-button-label>Public</span>
            <span class="view-toggle-action">Change</span>
          </button>
          <p id="desktop-view-description" class="sidebar-note">Open local feed</p>
        </section>

        <footer class="sidebar-footer">
          <p class="live-state"><span class="status-dot" data-sync-dot aria-hidden="true"></span><span data-sync-label>Connecting…</span></p>
          <a class="text-link" href="/how-it-works.html">How Nearline works</a>
          <div class="identity-row">
            <span class="identity" data-author-label>@--------</span>
            <button class="text-button" data-logout type="button">Log out</button>
          </div>
        </footer>
      </aside>

      <section class="conversation" aria-label="Feed">
        <header class="topbar">
          <span class="painted-mark">Nearline</span>
          <div class="topbar-actions">
            <details class="identity-menu" data-identity-menu>
              <summary aria-label="Identity actions">
                <span class="identity" data-author-label>@--------</span>
                <svg class="icon chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
              </summary>
              <div class="identity-popover">
                <span class="identity-popover-label">Signed in with passkey</span>
                <a class="popover-link" href="/how-it-works.html">How Nearline works</a>
                <button data-logout type="button">Log out</button>
              </div>
            </details>
            <button class="view-toggle compact" data-room-button type="button" aria-haspopup="dialog" aria-controls="room-dialog">
              <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>
              <span data-room-button-label>Public</span>
            </button>
          </div>
        </header>

        <section class="range-strip" aria-label="Range">
          <div class="range-control horizontal" role="group" aria-label="Range">
            <button type="button" data-scope="11" aria-pressed="false"><span>Close</span><small>a block</small></button>
            <button type="button" data-scope="10" aria-pressed="true"><span>Nearby</span><small>few blocks</small></button>
            <button type="button" data-scope="9" aria-pressed="false"><span>Wide</span><small>neighbourhood</small></button>
          </div>
          <label class="sr-only" for="scope-select">Range</label>
          <select id="scope-select" class="sr-only" tabindex="-1" aria-hidden="true">
            <option value="9">Wide</option>
            <option value="10" selected>Nearby</option>
            <option value="11">Close</option>
          </select>
        </section>

        <header class="conversation-header">
          <span id="desktop-view-status">Public · Nearby</span>
          <span class="live-state"><span class="status-dot" data-sync-dot aria-hidden="true"></span><span data-sync-label>Connecting…</span></span>
        </header>

        <div class="lane" aria-hidden="true"></div>

        <p class="status-line" aria-live="polite" aria-atomic="true">
          <span class="status-dot" data-sync-dot aria-hidden="true"></span>
          <span id="scope-status">Nearby</span>
          <span class="status-separator" aria-hidden="true">/</span>
          <span data-sync-label>Connecting…</span>
        </p>

        <div class="feed-tabs" role="tablist" aria-label="Feed">
          <button id="tab-latest" type="button" role="tab" aria-selected="true" aria-controls="feed" data-tab="latest">Latest</button>
          <button id="tab-trending" type="button" role="tab" aria-selected="false" aria-controls="feed" data-tab="trending">Trending</button>
        </div>

        <section id="feed" class="feed" aria-label="Posts nearby">
          <button id="new-posts" class="new-posts" type="button" hidden>New posts</button>
          <div id="feed-list" class="feed-list" role="feed" aria-busy="false"></div>
          <div id="empty-state" class="empty-state"><p id="empty-title">Quiet here</p><span id="empty-copy">Start the line.</span></div>
          <button id="load-more" class="button secondary load-more" type="button" hidden>Load more</button>
        </section>

        <form id="composer" class="composer">
          <label class="composer-field">
            <span class="sr-only">New post</span>
            <textarea id="message-input" rows="1" maxlength="1000" placeholder="Post nearby…" enterkeyhint="send"></textarea>
          </label>
          <button id="send-button" class="send-button" type="submit" disabled>Post</button>
        </form>
      </section>

      <section id="thread-view" class="thread-view" aria-label="Thread" hidden>
        <header class="thread-header">
          <button id="thread-back" class="icon-button" type="button" aria-label="Back to feed">
            <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg>
          </button>
          <h2 class="thread-title">Thread</h2>
          <button id="thread-up" class="text-button" type="button" hidden>Up a level</button>
        </header>
        <div id="thread-body" class="thread-body"></div>
        <form id="reply-composer" class="composer reply-composer">
          <div class="reply-target-row">
            <span id="reply-target">Reply to thread</span>
            <button id="reply-cancel" class="text-button" type="button" hidden>Cancel</button>
          </div>
          <label class="composer-field">
            <span class="sr-only">Reply</span>
            <textarea id="reply-input" rows="1" maxlength="1000" placeholder="Reply…" enterkeyhint="send"></textarea>
          </label>
          <button id="reply-send" class="send-button" type="submit" disabled>Reply</button>
        </form>
      </section>
    </main>

    <dialog id="room-dialog" class="filter-dialog" aria-labelledby="filter-title">
      <div class="hatch" aria-hidden="true"></div>
      <form id="room-form" method="dialog">
        <header class="dialog-header">
          <h2 id="filter-title">Private filter</h2>
          <button id="room-close" class="icon-button" value="cancel" aria-label="Close private filter" type="submit" formnovalidate>
            <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>
          </button>
        </header>
        <p class="dialog-copy">Only people nearby using the same room ID and passphrase will see your posts, and you will see only theirs.</p>
        <label class="field-label" for="room-id">Room ID</label>
        <input id="room-id" autocomplete="off" autocapitalize="none" autocorrect="off" maxlength="100" required>
        <label class="field-label" for="room-passphrase">Passphrase</label>
        <input id="room-passphrase" type="password" autocomplete="off" maxlength="200" required>
        <div class="dialog-actions">
          <button id="leave-room" class="button secondary" type="button" hidden>Return to public</button>
          <button class="button restrict" value="default" type="submit">Apply filter</button>
        </div>
      </form>
    </dialog>

    <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
  </body>
</html>
```

- [ ] **Step 2: Update `public/styles.css`**

Read the current file first (it may have changed since this plan was written). Then:

1. Delete every rule whose selector starts with `.transcript`, `.message`, `.timeline-event` or `.new-messages`, including the ones inside the `@media (min-width: 1024px)` block (`.transcript { … }` and `.new-messages { bottom: 104px; }`).
2. Change the selector `.composer::before` rule and its `:root.room-active .composer::before` rule so they apply only to the feed composer: replace `.composer::before` with `#composer::before` in both places, and in the desktop block replace `.composer::before { left: …; right: …; }` with `#composer::before { … }` (same values).
3. Append the block below at the end of the file.

```css
/* ---------- Links ---------- */
.text-link { color: var(--paint-2); text-decoration: underline; text-decoration-color: var(--seam-strong); text-underline-offset: 4px; }
.text-link:hover { color: var(--paint); }
.popover-link { display: flex; align-items: center; min-height: 44px; padding: 0 10px; border-radius: var(--radius); color: var(--paint); font-size: 15px; text-decoration: none; }

/* ---------- Feed tabs: same grammar as the range control ---------- */
.feed-tabs { flex: none; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; padding: 10px max(16px, env(safe-area-inset-right, 0px)) 6px max(16px, env(safe-area-inset-left, 0px)); }
.feed-tabs button {
  min-height: 44px; border: var(--stroke-paint) solid var(--seam); border-radius: var(--radius); background: transparent;
  color: var(--paint-2); font-family: var(--font-paint); font-size: 18px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
  transition: background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}
.feed-tabs button[aria-selected="true"] { border-color: var(--paint); background: var(--paint); color: var(--on-paint); }

/* ---------- Feed ---------- */
.feed {
  position: relative; flex: 1 1 auto; min-height: 0; overflow-y: auto;
  padding: 0 max(16px, env(safe-area-inset-right, 0px)) 24px max(16px, env(safe-area-inset-left, 0px));
  scroll-behavior: smooth; overscroll-behavior: contain;
  scrollbar-width: thin; scrollbar-color: var(--seam-strong) transparent;
}
.feed::-webkit-scrollbar { width: 8px; }
.feed::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 4px; background: var(--seam-strong) padding-box; }
.feed-list:empty { display: none; }
.feed-list:not(:empty) + .empty-state { display: none; }
.new-posts {
  position: sticky; z-index: 3; top: 8px; display: block; margin: 8px auto 0; min-height: 40px; padding: 0 16px;
  border: 0; border-radius: var(--radius); background: var(--paint); color: var(--on-paint);
  font-size: var(--t-ui); font-weight: 600; box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
  animation: rise-in 220ms var(--ease-out) both;
}
.load-more { display: flex; width: 100%; margin-top: 12px; }

/* ---------- Posts ---------- */
.post { position: relative; padding: 14px 0 12px; animation: rise-in 260ms var(--ease-out) both; }
.feed-list .post + .post { border-top: var(--stroke-hair) solid var(--seam); }
.post-feed { cursor: pointer; }
.post-feed:focus-visible { outline-offset: 4px; }
.post-via { margin-bottom: 6px; display: flex; align-items: center; gap: 6px; padding-left: 18px; color: var(--paint-3); font-size: var(--t-label); font-weight: 600; }
.post-via .icon { width: 13px; height: 13px; }
.post-meta { margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.post-author { min-width: 0; display: flex; align-items: center; gap: 8px; color: var(--paint-2); font-family: var(--font-data); font-size: 13px; }
/* Road stud: each author's colour comes from their hash. */
.post-author::before { content: ""; width: 10px; height: 10px; flex: none; border-radius: 2px; background: var(--stud, var(--paint-3)); box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.35); }
.post.own .post-author { color: var(--paint); }
.post.own .post-author::before { background: var(--paint); }
.post-time { flex: none; color: var(--paint-3); font-family: var(--font-data); font-size: var(--t-label); font-variant-numeric: tabular-nums; }
.post-body { max-width: 68ch; padding-left: 18px; color: var(--paint); font-size: var(--t-body); line-height: 1.5; overflow-wrap: anywhere; white-space: pre-wrap; }
.post-focus .post-body { font-size: 20px; line-height: 1.45; }
.post.deleted .post-body { color: var(--paint-3); font-style: italic; }
.post.pending { opacity: 0.72; }
.post.pending .post-body { outline: var(--stroke-paint) dashed var(--seam-strong); outline-offset: 6px; border-radius: var(--radius); }

.post-actions { margin-top: 8px; padding-left: 10px; display: flex; align-items: center; gap: 2px; }
.post-action {
  min-width: 44px; min-height: 40px; padding: 0 8px; display: inline-flex; align-items: center; gap: 6px;
  border: 0; border-radius: var(--radius); background: transparent; color: var(--paint-3);
  font-family: var(--font-data); font-size: var(--t-label); font-variant-numeric: tabular-nums;
  transition: color var(--motion-fast) var(--ease-out), background-color var(--motion-fast) var(--ease-out), transform 120ms var(--ease-out);
}
.post-action .icon { width: 17px; height: 17px; }
.post-action:active:not(:disabled) { transform: scale(0.94); }
.post-action[aria-pressed="true"] { color: var(--paint); }
.action-like[aria-pressed="true"] .icon { fill: currentColor; }
.post-action:disabled { cursor: default; }
.action-delete { margin-left: auto; }

/* Fading paint: the thread's remaining life out of fifteen minutes. */
.life { height: 3px; margin: 10px 0 0 18px; overflow: hidden; background: var(--seam); }
.life span { display: block; height: 100%; background: var(--paint-2); transform: scaleX(var(--life, 1)); transform-origin: left center; transition: transform 1s linear; }
:root.room-active .life span { background: var(--yellow); }

/* ---------- Thread view ---------- */
.thread-view {
  position: fixed; inset: 0; z-index: 30; display: flex; flex-direction: column; min-height: 0;
  background: var(--grain), var(--asphalt);
  padding-top: env(safe-area-inset-top, 0px);
  animation: sheet-in 260ms var(--ease-out) both;
}
.thread-header { flex: none; min-height: 60px; padding: 8px max(16px, env(safe-area-inset-right, 0px)) 8px max(8px, env(safe-area-inset-left, 0px)); display: flex; align-items: center; gap: 8px; border-bottom: var(--stroke-hair) solid var(--seam); }
.thread-title { flex: 1; font-family: var(--font-paint); font-size: 22px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; }
.thread-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 8px max(16px, env(safe-area-inset-right, 0px)) 24px max(16px, env(safe-area-inset-left, 0px)); overscroll-behavior: contain; }
.thread-faded { margin: 12px 0; padding: 12px 14px; border: var(--stroke-paint) dashed var(--seam-strong); border-radius: var(--radius); color: var(--paint-2); font-size: var(--t-ui); }
.thread-loading { margin-top: 12px; color: var(--paint-3); font-size: var(--t-ui); }
.thread-context { margin-bottom: 8px; display: grid; gap: 4px; }
.context-link { min-height: 40px; padding: 6px 10px; border: 0; border-left: var(--stroke-hair) dashed var(--seam-strong); background: transparent; color: var(--paint-3); font-size: var(--t-label); text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reply-tree { margin: 0; padding: 0; list-style: none; }
.reply-tree .reply-tree { margin-left: 10px; padding-left: 10px; border-left: var(--stroke-paint) dashed var(--seam); }
.reply-node > .post { padding-top: 10px; }
.continue-thread { margin: 2px 0 8px 18px; min-height: 40px; padding: 0 12px; border: var(--stroke-paint) dashed var(--seam-strong); border-radius: var(--radius); background: transparent; color: var(--paint-2); font-size: var(--t-label); font-weight: 600; }
.reply-composer { grid-template-columns: minmax(0, 1fr) auto; }
.reply-composer::before { content: ""; position: absolute; top: 0; left: max(16px, env(safe-area-inset-left, 0px)); right: max(16px, env(safe-area-inset-right, 0px)); height: var(--stroke-bar); background: var(--paint); opacity: 0.9; }
:root.room-active .reply-composer::before { background: var(--yellow); }
.reply-target-row { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--paint-3); font-size: var(--t-label); font-weight: 600; }

@media (hover: hover) and (pointer: fine) {
  .feed-tabs button[aria-selected="false"]:hover { border-color: var(--seam-strong); color: var(--paint); }
  .post-action:not(:disabled):hover { background: var(--asphalt-raised); color: var(--paint); }
  .context-link:hover, .continue-thread:hover { color: var(--paint); }
  .popover-link:hover { background: var(--asphalt-raised); }
}

@media (min-width: 1024px) {
  .feed-tabs { padding-inline: max(28px, calc((100% - 760px) / 2)); }
  .feed { padding: 4px max(28px, calc((100% - 760px) / 2)) 28px; }
}

/* Wide screens: the thread sits beside the feed instead of over it. */
@media (min-width: 1280px) {
  :root.thread-open .app-shell { grid-template-columns: 300px minmax(0, 1fr) minmax(380px, 440px); }
  .thread-view { position: static; z-index: auto; padding-top: 0; border-left: var(--stroke-hair) solid var(--seam); background: var(--grain), var(--asphalt-raised); animation: none; }
}

@media (prefers-reduced-motion: reduce) {
  .life span { transition: none; }
}
```

- [ ] **Step 3: Create `apps/web/render-post.ts`**

```ts
import type { Anchor, PostView } from "../../packages/protocol/index.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

export type IconName = "reply" | "repost" | "like" | "delete" | "back";

const ICON_PATHS: Record<IconName, string> = {
  reply: "M6.5 3.5 2.5 7.5l4 4M2.5 7.5h6.5a4.5 4.5 0 0 1 4.5 4.5v1",
  repost: "M3 6.5v-1a2 2 0 0 1 2-2h7.5m0 0-2-2m2 2-2 2M13 9.5v1a2 2 0 0 1-2 2H3.5m0 0 2 2m-2-2 2-2",
  like: "M8 13.5S2.5 10.3 2.5 6.4A2.9 2.9 0 0 1 8 5a2.9 2.9 0 0 1 5.5 1.4c0 3.9-5.5 7.1-5.5 7.1Z",
  delete: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5",
  back: "M10 3 5 8l5 5",
};

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon", `icon-${name}`);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICON_PATHS[name]);
  svg.append(path);
  return svg;
}

/** Road-stud colour from the author's hash, so speakers stay distinguishable without profiles. */
export function authorColor(author: string): string {
  const hue = Number.parseInt(author.slice(0, 4), 16) % 360;
  return Number.isFinite(hue) ? `hsl(${hue} 72% 66%)` : "";
}

export function formatAge(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 45_000) return "now";
  if (elapsed < 60 * 60_000) return `${Math.max(1, Math.floor(elapsed / 60_000))}m`;
  return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

export interface PostCardOptions {
  post: PostView;
  threadId: string;
  variant: "feed" | "focus" | "reply";
  currentAuthor: string;
  now: number;
  likeCount: number;
  likedByMe: boolean;
  replyCount?: number;
  repostCount?: number;
  repostedByMe?: boolean;
  via?: Anchor;
  expiresAt?: number;
  pending?: boolean;
}

export function renderPostCard(options: PostCardOptions): HTMLElement {
  const { post, threadId, variant } = options;
  const own = post.author === options.currentAuthor;
  const article = document.createElement("article");
  article.className = ["post", `post-${variant}`, own ? "own" : "", options.pending ? "pending" : "", post.deleted ? "deleted" : ""]
    .filter(Boolean).join(" ");
  article.dataset.threadId = threadId;
  article.dataset.postId = post.id;
  article.style.setProperty("--stud", authorColor(post.author));
  if (variant === "feed") {
    article.dataset.action = "open";
    article.tabIndex = 0;
  }

  if (options.via?.kind === "repost") {
    const via = document.createElement("p");
    via.className = "post-via";
    via.append(icon("repost"), document.createTextNode(`@${options.via.byAuthor} reposted here`));
    article.append(via);
  }

  const meta = document.createElement("div");
  meta.className = "post-meta";
  const author = document.createElement("span");
  author.className = "post-author";
  author.textContent = `@${post.author}`;
  if (own) {
    const you = document.createElement("span");
    you.className = "you-label";
    you.textContent = "you";
    author.append(you);
  }
  const time = document.createElement("time");
  time.className = "post-time";
  time.dateTime = new Date(post.createdAt).toISOString();
  time.dataset.ts = String(post.createdAt);
  time.textContent = formatAge(post.createdAt, options.now);
  meta.append(author, time);

  const body = document.createElement("p");
  body.className = "post-body";
  body.textContent = post.deleted ? "[deleted]" : post.body;
  article.append(meta, body);

  if (!post.deleted && !options.pending) article.append(actionRow(options, own));

  if (options.expiresAt !== undefined) {
    const life = document.createElement("div");
    life.className = "life";
    life.dataset.expiresAt = String(options.expiresAt);
    life.setAttribute("aria-hidden", "true");
    life.append(document.createElement("span"));
    article.append(life);
  }
  return article;
}

function actionRow(options: PostCardOptions, own: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "post-actions";
  row.append(actionButton("reply", "Reply", options, options.replyCount));
  if (options.repostCount !== undefined) {
    const repost = actionButton("repost", options.repostedByMe ? "Reposted" : "Repost here", options, options.repostCount);
    repost.setAttribute("aria-pressed", String(Boolean(options.repostedByMe)));
    repost.disabled = Boolean(options.repostedByMe);
    row.append(repost);
  }
  const like = actionButton("like", options.likedByMe ? "Unlike" : "Like", options, options.likeCount);
  like.setAttribute("aria-pressed", String(options.likedByMe));
  row.append(like);
  if (own) row.append(actionButton("delete", "Delete", options));
  return row;
}

function actionButton(
  name: "reply" | "repost" | "like" | "delete",
  label: string,
  options: PostCardOptions,
  count?: number,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `post-action action-${name}`;
  button.dataset.action = name;
  button.dataset.threadId = options.threadId;
  button.dataset.postId = options.post.id;
  button.setAttribute("aria-label", count === undefined ? label : `${label}, ${count}`);
  button.append(icon(name));
  if (count !== undefined) {
    const value = document.createElement("span");
    value.className = "count";
    value.textContent = String(count);
    button.append(value);
  }
  return button;
}
```

- [ ] **Step 4: Create `apps/web/render-feed.ts`**

```ts
import type { FeedTab } from "../../packages/protocol/index.ts";
import { THREAD_TTL_MS } from "../../packages/shared/constants.ts";
import type { FeedState } from "./feed-state.ts";
import { formatAge, renderPostCard } from "./render-post.ts";

export interface FeedRenderContext {
  currentAuthor: string;
  now: number;
}

const cards = new Map<string, { signature: string; element: HTMLElement }>();

/**
 * Keyed rendering: a card is rebuilt only when what it shows changed, and existing nodes are moved
 * rather than recreated, so focus, scroll position and the life-line transition survive a poll.
 */
export function renderFeed(list: HTMLElement, state: FeedState, tab: FeedTab, ctx: FeedRenderContext): void {
  const seen = new Set<string>();
  let cursor: Element | null = list.firstElementChild;
  for (const id of state.visibleIds(tab)) {
    const entry = state.threads.get(id)!;
    const likeCount = state.likeCount(id, entry.summary.likeCount, ctx.now);
    const repostCount = state.repostCount(id, entry.summary.repostCount, ctx.now);
    const likedByMe = state.likedPosts.has(id);
    const repostedByMe = state.repostedThreads.has(id);
    const signature = JSON.stringify([
      entry.summary.version, entry.summary.expiresAt, entry.summary.replyCount, entry.summary.root.deleted,
      likeCount, repostCount, likedByMe, repostedByMe, entry.via.createdAt, entry.via.byAuthor, entry.pending, ctx.currentAuthor,
    ]);
    let card = cards.get(id);
    if (!card || card.signature !== signature) {
      const element = renderPostCard({
        post: entry.summary.root, threadId: id, variant: "feed", currentAuthor: ctx.currentAuthor, now: ctx.now,
        likeCount, likedByMe, replyCount: entry.summary.replyCount, repostCount, repostedByMe,
        via: entry.via, expiresAt: entry.summary.expiresAt, pending: entry.pending,
      });
      if (card?.element.isConnected) {
        if (cursor === card.element) cursor = element;
        card.element.replaceWith(element);
      }
      card = { signature, element };
      cards.set(id, card);
    }
    if (cursor === card.element) cursor = cursor.nextElementSibling;
    else list.insertBefore(card.element, cursor);
    seen.add(id);
  }
  for (const [id, card] of cards) {
    if (seen.has(id)) continue;
    card.element.remove();
    cards.delete(id);
  }
}

/** Cheap per-second update: relative times and each thread's fading life line. */
export function refreshTimes(root: ParentNode, now: number): void {
  for (const time of root.querySelectorAll<HTMLTimeElement>("time[data-ts]")) {
    time.textContent = formatAge(Number(time.dataset.ts), now);
  }
  for (const life of root.querySelectorAll<HTMLElement>(".life[data-expires-at]")) {
    const remaining = Math.max(0, Math.min(1, (Number(life.dataset.expiresAt) - now) / THREAD_TTL_MS));
    life.style.setProperty("--life", remaining.toFixed(4));
  }
}
```

- [ ] **Step 5: Create `apps/web/render-thread.ts`**

```ts
import { ancestry, buildTree, countDescendants, findNode, type TreeNode } from "../../packages/feed/tree.ts";
import type { PostView } from "../../packages/protocol/index.ts";
import { MAX_VISIBLE_REPLY_DEPTH } from "../../packages/shared/constants.ts";
import type { FeedState } from "./feed-state.ts";
import { renderPostCard } from "./render-post.ts";

interface ThreadRenderContext {
  state: FeedState;
  threadId: string;
  currentAuthor: string;
  now: number;
}

export function renderThread(container: HTMLElement, state: FeedState, currentAuthor: string, now: number): void {
  container.replaceChildren();
  const open = state.open;
  if (!open) return;
  const ctx: ThreadRenderContext = { state, threadId: open.id, currentAuthor, now };

  if (open.faded) {
    const banner = document.createElement("p");
    banner.className = "thread-faded";
    banner.textContent = "This thread has faded. Nothing here is kept once a thread goes quiet for fifteen minutes.";
    container.append(banner);
  }

  if (!open.loaded) {
    if (open.summary) container.append(card(open.summary.root, "focus", ctx));
    const loading = document.createElement("p");
    loading.className = "thread-loading";
    loading.textContent = "Loading replies…";
    container.append(loading);
    return;
  }

  const root = buildTree(open.posts);
  if (!root) return;
  const focus = (open.focusId ? findNode(root, open.focusId) : null) ?? root;

  if (focus !== root) {
    const context = document.createElement("div");
    context.className = "thread-context";
    for (const id of ancestry(open.posts, focus.post.id).slice(0, -1)) {
      const post = open.posts.find((item) => item.id === id);
      if (!post) continue;
      const link = document.createElement("button");
      link.type = "button";
      link.className = "context-link";
      link.dataset.action = "focus";
      link.dataset.threadId = open.id;
      link.dataset.postId = post.id;
      link.textContent = `@${post.author}: ${post.deleted ? "[deleted]" : post.body}`;
      context.append(link);
    }
    container.append(context);
  }

  container.append(card(focus.post, "focus", ctx, focus === root ? undefined : countDescendants(focus)));
  const list = document.createElement("ol");
  list.className = "reply-tree";
  appendReplies(list, focus.children, 1, ctx);
  container.append(list);
}

function appendReplies(list: HTMLOListElement, nodes: readonly TreeNode[], depth: number, ctx: ThreadRenderContext): void {
  for (const node of nodes) {
    const item = document.createElement("li");
    item.className = "reply-node";
    item.append(card(node.post, "reply", ctx));
    if (node.children.length > 0) {
      if (depth >= MAX_VISIBLE_REPLY_DEPTH) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "continue-thread";
        more.dataset.action = "focus";
        more.dataset.threadId = ctx.threadId;
        more.dataset.postId = node.post.id;
        const hidden = countDescendants(node);
        more.textContent = `Continue thread (${hidden} more) →`;
        item.append(more);
      } else {
        const nested = document.createElement("ol");
        nested.className = "reply-tree";
        appendReplies(nested, node.children, depth + 1, ctx);
        item.append(nested);
      }
    }
    list.append(item);
  }
}

function card(post: PostView, variant: "focus" | "reply", ctx: ThreadRenderContext, descendants?: number): HTMLElement {
  const { state, threadId, now } = ctx;
  const summary = state.open?.summary ?? state.threads.get(threadId)?.summary ?? null;
  const isRoot = post.id === threadId;
  return renderPostCard({
    post,
    threadId,
    variant,
    currentAuthor: ctx.currentAuthor,
    now,
    likeCount: state.likeCount(post.id, post.likeCount, now),
    likedByMe: state.likedPosts.has(post.id),
    replyCount: variant === "focus" ? (isRoot ? summary?.replyCount : descendants) : undefined,
    repostCount: variant === "focus" && isRoot && summary ? state.repostCount(threadId, summary.repostCount, now) : undefined,
    repostedByMe: state.repostedThreads.has(threadId),
    expiresAt: variant === "focus" && isRoot ? summary?.expiresAt : undefined,
    pending: state.pendingReplies.has(post.id),
  });
}
```

- [ ] **Step 6: Replace `apps/web/main.ts`**

```ts
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { latLngToCanonicalLocation, locationToScopeCell } from "../../packages/geo/index.ts";
import type { ActionRequest, Anchor, ErrorCode, FeedTab, PostView, ThreadSummary } from "../../packages/protocol/index.ts";
import {
  MAX_MESSAGE_CHARS,
  POLL_FEED_MS,
  POLL_THREAD_MS,
  THREAD_TTL_MS,
  type ProximityScope,
} from "../../packages/shared/constants.ts";
import { bytesToHex, sha256 } from "../../packages/shared/encoding.ts";
import { fetchEngagement, fetchFeed, fetchThread, sendAction } from "./api.ts";
import { FeedState } from "./feed-state.ts";
import { Poller } from "./poller.ts";
import { refreshTimes, renderFeed } from "./render-feed.ts";
import { renderThread } from "./render-thread.ts";

const elements = {
  authView: required<HTMLElement>("auth-view"),
  locationView: required<HTMLElement>("location-view"),
  chatView: required<HTMLElement>("chat-view"),
  login: required<HTMLButtonElement>("login-button"),
  register: required<HTMLButtonElement>("register-button"),
  location: required<HTMLButtonElement>("location-button"),
  locationCopy: required<HTMLElement>("location-copy"),
  scopeStatus: required<HTMLElement>("scope-status"),
  desktopViewStatus: required<HTMLElement>("desktop-view-status"),
  desktopViewDescription: required<HTMLElement>("desktop-view-description"),
  scope: required<HTMLSelectElement>("scope-select"),
  feed: required<HTMLElement>("feed"),
  feedList: required<HTMLElement>("feed-list"),
  empty: required<HTMLElement>("empty-state"),
  emptyTitle: required<HTMLElement>("empty-title"),
  emptyCopy: required<HTMLElement>("empty-copy"),
  loadMore: required<HTMLButtonElement>("load-more"),
  newPosts: required<HTMLButtonElement>("new-posts"),
  composer: required<HTMLFormElement>("composer"),
  input: required<HTMLTextAreaElement>("message-input"),
  send: required<HTMLButtonElement>("send-button"),
  threadView: required<HTMLElement>("thread-view"),
  threadBody: required<HTMLElement>("thread-body"),
  threadBack: required<HTMLButtonElement>("thread-back"),
  threadUp: required<HTMLButtonElement>("thread-up"),
  replyComposer: required<HTMLFormElement>("reply-composer"),
  replyInput: required<HTMLTextAreaElement>("reply-input"),
  replySend: required<HTMLButtonElement>("reply-send"),
  replyTarget: required<HTMLElement>("reply-target"),
  replyCancel: required<HTMLButtonElement>("reply-cancel"),
  roomDialog: required<HTMLDialogElement>("room-dialog"),
  roomForm: required<HTMLFormElement>("room-form"),
  roomId: required<HTMLInputElement>("room-id"),
  roomPassphrase: required<HTMLInputElement>("room-passphrase"),
  leaveRoom: required<HTMLButtonElement>("leave-room"),
  toast: required<HTMLElement>("toast"),
};

const scopeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-scope]"));
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tab]"));
const roomButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-room-button]"));
const authorLabels = Array.from(document.querySelectorAll<HTMLElement>("[data-author-label]"));
const syncDots = Array.from(document.querySelectorAll<HTMLElement>("[data-sync-dot]"));
const syncLabels = Array.from(document.querySelectorAll<HTMLElement>("[data-sync-label]"));
const logoutButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-logout]"));
const identityMenus = Array.from(document.querySelectorAll<HTMLDetailsElement>("[data-identity-menu]"));

const scopeCopy: Record<ProximityScope, string> = { 11: "Close", 10: "Nearby", 9: "Wide" };

const ERROR_COPY: Partial<Record<ErrorCode, string>> = {
  RATE_LIMITED: "You’re going too fast. Wait a moment.",
  INVALID_MESSAGE: "That post can’t be sent.",
  THREAD_NOT_FOUND: "That thread has faded.",
  THREAD_EXPIRED: "That thread has faded.",
  NOT_VISIBLE: "That thread is out of your range now.",
  PARENT_NOT_FOUND: "That post is gone.",
  POST_NOT_FOUND: "That post is gone.",
  THREAD_FULL: "This thread is full.",
  ALREADY_REPOSTED: "You already reposted this.",
  NOT_AUTHOR: "You can only delete your own posts.",
  UNAVAILABLE: "Couldn’t reach Nearline. Try again.",
};

const state = new FeedState();
const feedPoller = new Poller(POLL_FEED_MS, pollFeed);
const threadPoller = new Poller(POLL_THREAD_MS, pollThread);

let currentLocation = "";
let currentAuthor = "";
let currentRoomTag = "";
let currentScope: ProximityScope = 10;
let activeTab: FeedTab = "latest";
let replyParentId: string | null = null;
let watchId: number | null = null;
let toastTimer: number | undefined;
let renderQueued = false;
let laneSteps = 0;
let unseenNewPosts = 0;

void initialize();

async function initialize(): Promise<void> {
  bindEvents();
  syncViewportHeight();
  try {
    const session = await authApi<{ authenticated: boolean; author?: string }>("/api/auth/session");
    if (session.authenticated) {
      setAuthor(session.author ?? "");
      await prepareLocation();
      return;
    }
  } catch {
    showToast("The service is unavailable. Try again shortly.");
  }
  showView("auth");
}

function bindEvents(): void {
  elements.login.addEventListener("click", () => void authenticatePasskey());
  elements.register.addEventListener("click", () => void registerPasskey());
  elements.location.addEventListener("click", () => beginLocation(false));
  elements.scope.addEventListener("change", () => {
    currentScope = Number(elements.scope.value) as ProximityScope;
    applyScopeVisuals();
    refreshView();
  });
  for (const button of scopeButtons) {
    button.addEventListener("click", () => {
      const scope = Number(button.dataset.scope) as ProximityScope;
      if (scope === currentScope) return;
      elements.scope.value = String(scope);
      elements.scope.dispatchEvent(new Event("change"));
    });
  }
  for (const button of tabButtons) button.addEventListener("click", () => selectTab(button.dataset.tab as FeedTab));
  for (const button of roomButtons) button.addEventListener("click", openRoomDialog);
  for (const button of logoutButtons) button.addEventListener("click", () => void logout());
  document.addEventListener("click", (event) => {
    for (const menu of identityMenus) {
      if (menu.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") for (const menu of identityMenus) menu.open = false;
  });
  elements.roomForm.addEventListener("submit", (event) => {
    if ((event.submitter as HTMLButtonElement | null)?.value === "cancel") return;
    event.preventDefault();
    void enterRoom();
  });
  elements.leaveRoom.addEventListener("click", leaveRoom);

  elements.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitPost();
  });
  elements.input.addEventListener("input", updateComposers);
  elements.input.addEventListener("keydown", submitOnEnter(elements.composer));
  elements.replyComposer.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitReply();
  });
  elements.replyInput.addEventListener("input", updateComposers);
  elements.replyInput.addEventListener("keydown", submitOnEnter(elements.replyComposer));
  elements.replyCancel.addEventListener("click", () => setReplyTarget(null));

  elements.feedList.addEventListener("click", handlePostClick);
  elements.feedList.addEventListener("keydown", handlePostKey);
  elements.threadBody.addEventListener("click", handlePostClick);
  elements.threadBack.addEventListener("click", () => {
    if ((history.state as { thread?: string } | null)?.thread) history.back();
    else closeThread();
  });
  elements.threadUp.addEventListener("click", focusUp);
  elements.loadMore.addEventListener("click", () => void loadMore());
  elements.newPosts.addEventListener("click", () => {
    elements.feed.scrollTo({ top: 0, behavior: "smooth" });
    hideNewPosts();
  });
  elements.feed.addEventListener("scroll", () => {
    if (elements.feed.scrollTop < 80) hideNewPosts();
  }, { passive: true });
  window.addEventListener("popstate", () => {
    if (state.open && !(history.state as { thread?: string } | null)?.thread) closeThread();
  });
  document.addEventListener("visibilitychange", syncPolling);
  window.visualViewport?.addEventListener("resize", syncViewportHeight);
  window.addEventListener("orientationchange", syncViewportHeight);

  window.setInterval(() => refreshTimes(document.body, state.now()), prefersReducedMotion() ? 60_000 : 1_000);
  window.setInterval(() => {
    if (state.prune(state.now()).length > 0) scheduleRender();
  }, 5_000);
  window.setInterval(() => {
    if (activeTab !== "trending") return;
    state.resortTrending(state.now());
    scheduleRender();
  }, 15_000);

  applyScopeVisuals();
  setSyncState(false, "Connecting…");
}

// ---------- Authentication ----------

async function authenticatePasskey(): Promise<void> {
  await withBusy(elements.login, async () => {
    requirePasskeySupport();
    const optionsJSON = await authApi<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
      "/api/auth/login/options", { method: "POST" },
    );
    const credential = await startAuthentication({ optionsJSON });
    await authApi("/api/auth/login/verify", jsonInit(credential));
    const session = await authApi<{ author: string }>("/api/auth/session");
    setAuthor(session.author);
    await prepareLocation();
  }, "authenticate");
}

async function registerPasskey(): Promise<void> {
  await withBusy(elements.register, async () => {
    requirePasskeySupport();
    const optionsJSON = await authApi<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
      "/api/auth/register/options", { method: "POST" },
    );
    const credential = await startRegistration({ optionsJSON });
    const result = await authApi<{ author: string }>("/api/auth/register/verify", jsonInit(credential));
    setAuthor(result.author);
    await prepareLocation();
  }, "create");
}

async function logout(): Promise<void> {
  for (const button of logoutButtons) button.disabled = true;
  try {
    await authApi("/api/auth/logout", { method: "POST" });
    window.location.reload();
  } catch (error) {
    console.error(error);
    for (const button of logoutButtons) button.disabled = false;
    showToast("Couldn’t log out. Try again.");
  }
}

function endSession(): void {
  stopPolling();
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  currentLocation = "";
  state.reset();
  state.closeOpen();
  showView("auth");
  showToast("Your session ended. Continue with your passkey to rejoin.");
}

function setAuthor(author: string): void {
  currentAuthor = author;
  for (const label of authorLabels) label.textContent = author ? `@${author}` : "@--------";
}

// ---------- Location ----------

async function prepareLocation(): Promise<void> {
  showView("location");
  elements.location.hidden = false;
  elements.location.disabled = false;
  elements.location.textContent = "Use my location";
  elements.locationCopy.textContent = "Nearline shows posts from around you. Location is required to continue.";
  if (!("geolocation" in navigator)) {
    elements.locationCopy.textContent = "This browser does not provide location access.";
    elements.location.disabled = true;
    return;
  }
  if (!("permissions" in navigator)) return;
  try {
    const permission = await navigator.permissions.query({ name: "geolocation" });
    if (permission.state === "granted") {
      beginLocation(true);
      return;
    }
    if (permission.state === "denied") {
      elements.locationCopy.textContent = "Location is required for Nearline. Allow access in your browser settings to continue.";
      elements.location.textContent = "Retry location";
    }
  } catch {
    // Some browsers expose geolocation without supporting its Permissions API state.
  }
}

function beginLocation(automatic: boolean): void {
  if (!("geolocation" in navigator)) {
    elements.locationCopy.textContent = "This browser does not provide location access.";
    return;
  }
  elements.location.disabled = true;
  elements.location.hidden = automatic;
  elements.location.textContent = "Locating…";
  if (automatic) elements.locationCopy.textContent = "Finding your local line…";
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(
    (position) => {
      const location = latLngToCanonicalLocation(position.coords.latitude, position.coords.longitude);
      if (location === currentLocation) return;
      const previous = currentLocation;
      currentLocation = location;
      if (!previous) {
        showView("chat");
        return;
      }
      if (locationToScopeCell(previous, currentScope) !== locationToScopeCell(location, currentScope)) refreshView();
    },
    (error) => {
      stopPolling();
      showView("location");
      elements.location.hidden = false;
      elements.location.disabled = false;
      elements.location.textContent = "Retry location";
      elements.locationCopy.textContent = error.code === error.PERMISSION_DENIED
        ? "Location is required for Nearline. Allow access in your browser settings to continue."
        : "Location is unavailable. Check your connection and try again.";
    },
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
  );
}

// ---------- Polling ----------

function viewerFields(): { cell: string; scope: ProximityScope; room: string } {
  return { cell: locationToScopeCell(currentLocation, currentScope), scope: currentScope, room: currentRoomTag };
}

function viewKey(tab: FeedTab): string {
  return currentLocation ? `${locationToScopeCell(currentLocation, currentScope)}|${currentScope}|${currentRoomTag}|${tab}` : "";
}

function syncPolling(): void {
  if (document.hidden || elements.chatView.hidden || !currentLocation) {
    stopPolling();
    return;
  }
  feedPoller.start();
  if (state.open) threadPoller.start();
}

function stopPolling(): void {
  feedPoller.stop();
  threadPoller.stop();
}

/** The view changed (range, room or location): forget what was shown and fetch afresh. */
function refreshView(): void {
  state.reset();
  hideNewPosts();
  feedPoller.poke();
  scheduleRender();
}

async function pollFeed(): Promise<boolean> {
  if (!currentLocation) return false;
  const tab = activeTab;
  const key = viewKey(tab);
  const result = await fetchFeed({ ...viewerFields(), tab, cursor: null }, state.etags[tab]);
  if (result.status === "unauthorized") {
    endSession();
    return false;
  }
  if (result.status === "error" || result.status === "gone") {
    setSyncState(false, "Offline — retrying");
    return false;
  }
  setSyncState(true, "Updated just now");
  if (result.status === "unchanged" || key !== viewKey(activeTab)) return false;
  state.setServerTime(result.data.serverTime);
  const added = state.applyHead(tab, result.data.items, result.data.nextCursor, result.etag);
  if (tab === "trending") state.resortTrending(state.now());
  if (added.length > 0 && tab === "latest") {
    advanceLane();
    if (elements.feed.scrollTop > 80) showNewPosts(added.length);
  }
  void loadEngagement();
  scheduleRender();
  return true;
}

async function loadMore(): Promise<void> {
  const tab = activeTab;
  const cursor = state.cursors[tab];
  if (!cursor || !currentLocation) return;
  const key = viewKey(tab);
  elements.loadMore.disabled = true;
  const result = await fetchFeed({ ...viewerFields(), tab, cursor }, null);
  elements.loadMore.disabled = false;
  if (result.status !== "fresh" || key !== viewKey(activeTab)) return;
  state.applyMore(tab, result.data.items, result.data.nextCursor);
  void loadEngagement();
  scheduleRender();
}

async function loadEngagement(): Promise<void> {
  const response = await fetchEngagement(state.takeUnflagged());
  if (!response) return;
  state.applyEngagement(response);
  scheduleRender();
}

async function pollThread(): Promise<boolean> {
  const open = state.open;
  if (!open) return false;
  const result = await fetchThread(open.id, currentRoomTag, open.etag);
  if (state.open?.id !== open.id) return false;
  if (result.status === "unauthorized") {
    endSession();
    return false;
  }
  if (result.status === "gone") {
    state.markFaded(open.id);
    threadPoller.stop();
    scheduleRender();
    return false;
  }
  if (result.status !== "fresh") return false;
  state.setServerTime(result.data.serverTime);
  state.applyTree(result.data, result.etag);
  scheduleRender();
  return true;
}

// ---------- Actions ----------

async function submitPost(): Promise<void> {
  const body = elements.input.value;
  if (!canSubmit(body) || !currentLocation) return;
  const id = crypto.randomUUID();
  const now = state.now();
  const via: Anchor = { cell11: currentLocation, kind: "root", byAuthor: currentAuthor, createdAt: now };
  if (activeTab !== "latest") selectTab("latest");
  state.addPendingThread(pendingSummary(id, body, now), via);
  elements.input.value = "";
  elements.feed.scrollTo({ top: 0 });
  scheduleRender();
  const result = await sendAction({ id, type: "post", ...viewerFields(), location: currentLocation, body });
  if (result.ok && result.postId) {
    state.confirmPendingThread(id, result.postId);
    feedPoller.poke();
  } else {
    state.failPendingThread(id);
    if (!elements.input.value) elements.input.value = body;
    handleActionError(result.ok ? "UNAVAILABLE" : result.code);
  }
  scheduleRender();
}

async function submitReply(): Promise<void> {
  const open = state.open;
  const body = elements.replyInput.value;
  if (!open || open.faded || !canSubmit(body)) return;
  const parentId = replyParentId ?? open.focusId ?? open.id;
  const id = crypto.randomUUID();
  state.addPendingReply({
    id, threadId: open.id, parentId, author: currentAuthor, body, createdAt: state.now(), deleted: false, likeCount: 0,
  });
  elements.replyInput.value = "";
  setReplyTarget(null);
  scheduleRender();
  const action: ActionRequest = { id, type: "reply", ...viewerFields(), threadId: open.id, parentId, body };
  const result = await sendAction(action);
  if (result.ok && result.postId) {
    state.confirmReply(id, result.postId);
    threadPoller.poke();
    feedPoller.poke();
  } else {
    state.failReply(id);
    if (!elements.replyInput.value) elements.replyInput.value = body;
    handleActionError(result.ok ? "UNAVAILABLE" : result.code);
  }
  scheduleRender();
}

async function toggleLike(threadId: string, postId: string): Promise<void> {
  const on = !state.likedPosts.has(postId);
  state.setLiked(postId, on, serverLikeCount(threadId, postId), state.now());
  scheduleRender();
  const result = await sendAction({ id: crypto.randomUUID(), type: "like", ...viewerFields(), threadId, postId, on });
  if (!result.ok) {
    state.setLiked(postId, !on, serverLikeCount(threadId, postId), state.now());
    handleActionError(result.code);
    scheduleRender();
  }
}

function serverLikeCount(threadId: string, postId: string): number {
  if (postId === threadId) return state.threads.get(threadId)?.summary.likeCount ?? state.open?.summary?.likeCount ?? 0;
  return state.open?.posts.find((post) => post.id === postId)?.likeCount ?? 0;
}

async function repost(threadId: string): Promise<void> {
  if (state.repostedThreads.has(threadId) || !currentLocation) return;
  const serverCount = state.threads.get(threadId)?.summary.repostCount ?? state.open?.summary?.repostCount ?? 0;
  state.setReposted(threadId, true, serverCount, state.now());
  scheduleRender();
  const result = await sendAction({ id: crypto.randomUUID(), type: "repost", ...viewerFields(), threadId, location: currentLocation });
  if (result.ok) {
    showToast("Reposted. People around you can see it now.");
    feedPoller.poke();
  } else if (result.code !== "ALREADY_REPOSTED") {
    state.setReposted(threadId, false, serverCount, state.now());
    handleActionError(result.code);
  }
  scheduleRender();
}

async function deletePost(threadId: string, postId: string): Promise<void> {
  if (!window.confirm("Delete this post? This can’t be undone.")) return;
  const result = await sendAction({ id: crypto.randomUUID(), type: "delete", threadId, postId });
  if (!result.ok) {
    handleActionError(result.code);
    return;
  }
  const open = state.open?.id === threadId ? state.open : null;
  const replies = open ? open.posts.length - 1 : state.threads.get(threadId)?.summary.replyCount ?? 0;
  if (postId === threadId && replies === 0) {
    state.remove(threadId);
    if (open) closeThread();
  } else {
    state.removePost(postId);
    threadPoller.poke();
  }
  feedPoller.poke();
  scheduleRender();
}

function handleActionError(code: ErrorCode): void {
  if (code === "UNAUTHORIZED") {
    endSession();
    return;
  }
  showToast(ERROR_COPY[code] ?? "Something went wrong.");
}

function pendingSummary(id: string, body: string, now: number): ThreadSummary {
  const root: PostView = { id, threadId: id, parentId: null, author: currentAuthor, body, createdAt: now, deleted: false, likeCount: 0 };
  return {
    id, roomTag: currentRoomTag, root, replyCount: 0, likeCount: 0, repostCount: 0, participantCount: 1,
    score: 0, scoreAt: now, lastActivityAt: now, expiresAt: now + THREAD_TTL_MS, version: 0,
  };
}

// ---------- Feed and thread interaction ----------

function handlePostClick(event: MouseEvent): void {
  const control = (event.target as Element).closest<HTMLElement>("[data-action]");
  if (!control) return;
  const threadId = control.dataset.threadId;
  const postId = control.dataset.postId ?? threadId;
  if (!threadId || !postId) return;
  switch (control.dataset.action) {
    case "open":
      if (window.getSelection()?.toString()) return;
      openThread(threadId);
      break;
    case "reply":
      openThread(threadId);
      setReplyTarget(postId);
      break;
    case "like":
      void toggleLike(threadId, postId);
      break;
    case "repost":
      void repost(threadId);
      break;
    case "delete":
      void deletePost(threadId, postId);
      break;
    case "focus":
      state.focus(postId === threadId ? null : postId);
      setReplyTarget(null);
      scheduleRender();
      break;
  }
}

function handlePostKey(event: KeyboardEvent): void {
  if (event.key !== "Enter") return;
  const article = event.target instanceof HTMLElement && event.target.matches("article[data-action='open']") ? event.target : null;
  if (article?.dataset.threadId) openThread(article.dataset.threadId);
}

function openThread(threadId: string): void {
  if (state.open?.id !== threadId) {
    state.beginOpen(threadId);
    setReplyTarget(null);
    history.pushState({ thread: threadId }, "");
  }
  threadPoller.start();
  threadPoller.poke();
  scheduleRender();
  requestAnimationFrame(() => elements.threadBack.focus({ preventScroll: true }));
}

function closeThread(): void {
  state.closeOpen();
  threadPoller.stop();
  setReplyTarget(null);
  scheduleRender();
}

function focusUp(): void {
  const open = state.open;
  if (!open?.focusId) return;
  const parent = open.posts.find((post) => post.id === open.focusId)?.parentId ?? null;
  state.focus(parent === open.id ? null : parent);
  scheduleRender();
}

function setReplyTarget(postId: string | null): void {
  replyParentId = postId;
  const open = state.open;
  const post = postId && open
    ? open.posts.find((item) => item.id === postId) ?? (open.summary?.root.id === postId ? open.summary.root : undefined)
    : undefined;
  elements.replyTarget.textContent = post ? `Replying to @${post.author}` : "Reply to thread";
  elements.replyCancel.hidden = !post;
  if (post) requestAnimationFrame(() => elements.replyInput.focus({ preventScroll: true }));
}

function selectTab(tab: FeedTab): void {
  if (tab === activeTab) return;
  activeTab = tab;
  for (const button of tabButtons) button.setAttribute("aria-selected", String(button.dataset.tab === tab));
  hideNewPosts();
  if (tab === "trending") state.resortTrending(state.now());
  elements.feed.scrollTo({ top: 0 });
  feedPoller.poke();
  scheduleRender();
}

// ---------- Rendering ----------

function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render(): void {
  const now = state.now();
  preserveScroll(() => renderFeed(elements.feedList, state, activeTab, { currentAuthor, now }));
  const empty = state.visibleIds(activeTab).length === 0;
  elements.empty.hidden = !empty;
  elements.emptyTitle.textContent = activeTab === "latest" ? "Quiet here" : "Nothing trending";
  elements.emptyCopy.textContent = activeTab === "latest" ? "Start the line." : "Threads trend once more than one person joins in.";
  elements.loadMore.hidden = empty || !state.cursors[activeTab];
  renderThreadPanel(now);
  refreshTimes(document.body, now);
  updateComposers();
}

function renderThreadPanel(now: number): void {
  const open = state.open;
  document.documentElement.classList.toggle("thread-open", Boolean(open));
  elements.threadView.hidden = !open;
  if (!open) return;
  renderThread(elements.threadBody, state, currentAuthor, now);
  elements.threadUp.hidden = !open.focusId;
  elements.replyComposer.hidden = open.faded;
}

/** Keeps the post under the reader's eye still when new posts arrive above it. */
function preserveScroll(update: () => void): void {
  const feed = elements.feed;
  if (feed.scrollTop <= 0) {
    update();
    return;
  }
  const anchor = Array.from(elements.feedList.children)
    .find((child) => (child as HTMLElement).offsetTop + (child as HTMLElement).offsetHeight > feed.scrollTop) as HTMLElement | undefined;
  const before = anchor?.offsetTop ?? 0;
  update();
  if (anchor?.isConnected) feed.scrollTop += anchor.offsetTop - before;
}

function updateComposers(): void {
  resize(elements.input);
  resize(elements.replyInput);
  elements.send.disabled = !canSubmit(elements.input.value) || !currentLocation;
  elements.replySend.disabled = !canSubmit(elements.replyInput.value) || !state.open || state.open.faded;
}

function canSubmit(body: string): boolean {
  return body.trim().length > 0 && Array.from(body).length <= MAX_MESSAGE_CHARS;
}

function resize(input: HTMLTextAreaElement): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

function submitOnEnter(form: HTMLFormElement): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  };
}

function setSyncState(online: boolean, label: string): void {
  document.documentElement.classList.toggle("live", online);
  for (const dot of syncDots) dot.classList.toggle("online", online);
  for (const text of syncLabels) text.textContent = label;
}

/** The lane's dashes step forward whenever a poll brings new posts. */
function advanceLane(): void {
  laneSteps += 1;
  document.documentElement.style.setProperty("--lane-steps", String(laneSteps));
}

function showNewPosts(count: number): void {
  unseenNewPosts += count;
  elements.newPosts.textContent = `${unseenNewPosts} new ${unseenNewPosts === 1 ? "post" : "posts"}`;
  elements.newPosts.hidden = false;
}

function hideNewPosts(): void {
  unseenNewPosts = 0;
  elements.newPosts.hidden = true;
}

// ---------- Range and private filters ----------

function applyScopeVisuals(): void {
  const scope = scopeCopy[currentScope];
  document.documentElement.dataset.scope = String(currentScope);
  elements.scopeStatus.textContent = currentRoomTag ? `${scope} · private filter` : scope;
  elements.desktopViewStatus.textContent = `${currentRoomTag ? "Private filter" : "Public"} · ${scope}`;
  elements.desktopViewDescription.textContent = currentRoomTag ? "Private filter active" : "Open local feed";
  for (const button of scopeButtons) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.scope) === currentScope));
  }
}

async function enterRoom(): Promise<void> {
  const roomId = elements.roomId.value;
  const passphrase = elements.roomPassphrase.value;
  if (!roomId || !passphrase) return;
  const roomBytes = new TextEncoder().encode(roomId);
  const passphraseBytes = new TextEncoder().encode(passphrase);
  const joined = new Uint8Array(roomBytes.length + 1 + passphraseBytes.length);
  joined.set(roomBytes, 0);
  joined.set(passphraseBytes, roomBytes.length + 1);
  currentRoomTag = bytesToHex(await sha256(joined));
  setRoomButtonLabel("Private");
  for (const button of roomButtons) button.classList.add("active");
  document.documentElement.classList.add("room-active");
  elements.input.placeholder = "Post to this filter…";
  elements.leaveRoom.hidden = false;
  elements.roomForm.reset();
  elements.roomDialog.close();
  applyScopeVisuals();
  refreshView();
}

function leaveRoom(): void {
  currentRoomTag = "";
  setRoomButtonLabel("Public");
  for (const button of roomButtons) button.classList.remove("active");
  document.documentElement.classList.remove("room-active");
  elements.input.placeholder = "Post nearby…";
  elements.leaveRoom.hidden = true;
  elements.roomDialog.close();
  applyScopeVisuals();
  refreshView();
}

function setRoomButtonLabel(label: string): void {
  for (const button of roomButtons) {
    const text = button.querySelector<HTMLElement>("[data-room-button-label]");
    if (text) text.textContent = label;
  }
}

function openRoomDialog(): void {
  elements.roomDialog.showModal();
  requestAnimationFrame(() => elements.roomId.focus({ preventScroll: true }));
}

// ---------- Shell ----------

function showView(view: "auth" | "location" | "chat"): void {
  elements.authView.hidden = view !== "auth";
  elements.locationView.hidden = view !== "location";
  elements.chatView.hidden = view !== "chat";
  if (view === "chat" && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    requestAnimationFrame(() => elements.input.focus({ preventScroll: true }));
  }
  syncPolling();
  scheduleRender();
}

function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3_200);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

async function withBusy(
  button: HTMLButtonElement,
  action: () => Promise<void>,
  operation: "create" | "authenticate",
): Promise<void> {
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = "Waiting for passkey…";
  try {
    await action();
  } catch (error) {
    console.error(error);
    void reportPasskeyError(error, operation);
    if (error instanceof Error && error.message === "RATE_LIMITED") {
      showToast("Too many attempts from this network. Wait a minute and try again.");
    } else {
      showToast(operation === "create" ? "Couldn’t create passkey. Try again." : "Couldn’t use passkey. Try again.");
    }
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

function requirePasskeySupport(): void {
  if (!("PublicKeyCredential" in window)) {
    throw new DOMException("This browser does not expose WebAuthn", "NotSupportedError");
  }
}

async function reportPasskeyError(error: unknown, operation: "create" | "authenticate"): Promise<void> {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message.slice(0, 300) : "Unknown browser error";
  try {
    await fetch("/api/client-error", jsonInit({ area: "passkey", operation, name, message }));
  } catch {
    // Diagnostics must never replace or delay the user-facing failure state.
  }
}

function syncViewportHeight(): void {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--viewport-height", `${Math.round(height)}px`);
}

async function authApi<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

function jsonInit(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
```

- [ ] **Step 7: Remove the chat-only code**

1. In `packages/protocol/index.ts`, delete `ChatMessage`, `ConnectionAttachment`, `ClientFrame`, `ServerFrame`, `isClientFrame` and `sameRoom`, and remove the two legacy members (`"SHARD_CHANGED"`, `"MESSAGE_REJECTED"`) and the comment above them from `ErrorCode`.
2. In `packages/geo/index.ts`, delete `locationToShard`, `candidateShardsForMessage`, `MessageReach`, `messageReach` and `reachIncludes`, and remove `SHARD_RESOLUTION` from the constants import. Keep `scopeReach` (used by `messageVisibleTo`).
3. In `packages/shared/constants.ts`, delete `SHARD_RESOLUTION`, `MAX_MESSAGES_PER_SECOND_PER_USER`, `BURST_MESSAGES_PER_USER` and `MAX_TRANSCRIPT_MESSAGES`.
4. In `tests/geo.test.ts`, delete the tests named "assigns every location to exactly one resolution-5 home shard", "includes the home shard in fanout candidates" and "precomputed message reach agrees with the per-viewer visibility check", and remove `candidateShardsForMessage`, `locationToShard`, `messageReach` and `reachIncludes` from its import.
5. In `tests/protocol.test.ts`, delete the tests "treats rooms strictly as equality filters" and "accepts only object frames with a string type" and the `message` fixture, keep the remaining tests, and change the import to `import { isRoomTag } from "../packages/protocol/index.ts";`.

Then confirm nothing still refers to the removed names:

```bash
grep -rnE "ChatMessage|ConnectionAttachment|ClientFrame|ServerFrame|sameRoom|isClientFrame|locationToShard|candidateShardsForMessage|messageReach|reachIncludes|SHARD_RESOLUTION|MAX_TRANSCRIPT_MESSAGES|BURST_MESSAGES_PER_USER|MAX_MESSAGES_PER_SECOND_PER_USER|SHARD_CHANGED|MESSAGE_REJECTED" packages apps workers tests
```

Expected: no output.

- [ ] **Step 8: Build and test**

Run: `npm test && npm run build`
Expected: all tests pass; `public/app.js` builds; both typechecks exit 0.

- [ ] **Step 9: One batched visual check**

Serve a static preview with mock data (no backend needed): copy `public/` to a scratch directory, add a page that loads `/styles.css` and the markup from `public/index.html` without `/app.js`, unhides `#chat-view`, inserts four feed posts (one reposted, one own, one deleted), and opens the thread view with a three-level reply tree. Capture phone (390×844) and desktop (1440×900, with `html.thread-open`) screenshots in one round with the Playwright Chromium headless shell. Fix what the screenshots show in one batch, recapture once, and stop.

- [ ] **Step 10: Commit**

```bash
git add -A public apps packages tests
git commit -F - <<'EOF'
feat(web): replace live chat with the local feed interface

Latest and Trending tabs, post cards with replies, reposts and likes,
fading life lines, a thread view with a reply tree, and polling with
optimistic actions. Removes the WebSocket chat code.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---
### Task 18: The "How Nearline works" page

**Files:**
- Create: `public/how-it-works.html`
- Modify: `public/styles.css` (append a `body.doc` block)

**Interfaces:**
- Consumes: the fonts and colour tokens in `public/styles.css`; the links to `/how-it-works.html` added in Task 17.
- Produces: a static, public page (no sign-in required) that explains the whole system to someone who has never read the code.

This page is for the project's owner and anyone curious. It must explain the real system as built, in plain language, with every number matching `packages/shared/constants.ts`. If a later task changes a constant, update this page in the same commit.

- [ ] **Step 1: Add document styles**

Append to `public/styles.css`:

```css
/* ---------- Long-form documentation page ---------- */
body.doc { height: auto; min-height: 100%; overflow: auto; }
.doc-shell { width: min(100% - 32px, 760px); margin: 0 auto; padding: max(28px, env(safe-area-inset-top, 0px)) 0 96px; }
.doc-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 48px; }
.doc-header .painted-mark { font-size: 30px; }
.doc h1 { margin: 0 0 16px; font-size: clamp(34px, 8vw, 52px); font-weight: 600; letter-spacing: -0.025em; line-height: 1.05; text-wrap: balance; }
.doc .lede { margin-bottom: 40px; color: var(--paint-2); font-size: 20px; line-height: 1.55; }
.doc h2 { margin: 64px 0 14px; font-family: var(--font-paint); font-size: 30px; font-weight: 800; letter-spacing: 0.03em; line-height: 1.1; text-transform: uppercase; }
.doc h3 { margin: 32px 0 8px; font-size: 19px; font-weight: 600; }
.doc p, .doc li { color: var(--paint); font-size: var(--t-body); line-height: 1.65; }
.doc p + p { margin-top: 14px; }
.doc ul, .doc ol { margin: 12px 0; padding-left: 22px; }
.doc li + li { margin-top: 6px; }
.doc code { padding: 1px 5px; border-radius: var(--radius); background: var(--asphalt-high); color: var(--paint); font-family: var(--font-data); font-size: 0.88em; }
.doc strong { font-weight: 600; }
.doc .toc { display: grid; gap: 4px; margin: 0 0 24px; padding: 16px 18px; border: var(--stroke-paint) dashed var(--seam-strong); border-radius: var(--radius); list-style: none; }
.doc .toc a { color: var(--paint-2); text-decoration: none; }
.doc .toc a:hover { color: var(--paint); text-decoration: underline; text-underline-offset: 4px; }
.doc figure { margin: 24px 0; padding: 18px; border: var(--stroke-hair) solid var(--seam); border-radius: var(--radius); background: var(--asphalt-raised); }
.doc figure svg { display: block; width: 100%; height: auto; }
.doc figcaption { margin-top: 12px; color: var(--paint-3); font-size: var(--t-ui); line-height: 1.5; }
.doc table { width: 100%; margin: 16px 0; border-collapse: collapse; font-size: var(--t-ui); }
.doc th, .doc td { padding: 10px 12px; border-bottom: var(--stroke-hair) solid var(--seam); text-align: left; vertical-align: top; }
.doc th { color: var(--paint-3); font-size: var(--t-label); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
.doc td { color: var(--paint); line-height: 1.5; }
.doc .table-wrap { overflow-x: auto; }
.doc .note { margin: 20px 0; padding: 14px 16px; border-left: 0; border: var(--stroke-paint) dashed var(--seam-strong); border-radius: var(--radius); color: var(--paint-2); }
.doc .steps { counter-reset: step; list-style: none; padding: 0; }
.doc .steps > li { position: relative; padding-left: 44px; }
.doc .steps > li::before { counter-increment: step; content: counter(step); position: absolute; left: 0; top: 2px; width: 28px; height: 28px; display: grid; place-items: center; border-radius: var(--radius); background: var(--paint); color: var(--on-paint); font-family: var(--font-paint); font-weight: 800; }
.doc .back-link { display: inline-flex; align-items: center; min-height: 44px; }
.diagram-paint { fill: none; stroke: var(--paint); stroke-width: 2; }
.diagram-faint { fill: none; stroke: var(--seam-strong); stroke-width: 2; stroke-dasharray: 6 5; }
.diagram-fill { fill: var(--paint); }
.diagram-yellow { fill: none; stroke: var(--yellow); stroke-width: 3; }
.diagram-box { fill: var(--asphalt); stroke: var(--paint-2); stroke-width: 2; }
.diagram-box-strong { fill: var(--paint); stroke: var(--paint); stroke-width: 2; }
.diagram-text { fill: var(--paint); font-family: var(--font-ui); font-size: 15px; }
.diagram-text-dark { fill: var(--on-paint); font-family: var(--font-ui); font-size: 15px; font-weight: 600; }
.diagram-label { fill: var(--paint-3); font-family: var(--font-ui); font-size: 13px; }
.diagram-arrow { fill: none; stroke: var(--paint-2); stroke-width: 2; marker-end: url(#arrow); }
.diagram-arrow-async { fill: none; stroke: var(--yellow); stroke-width: 2; stroke-dasharray: 7 5; marker-end: url(#arrow-yellow); }
```

- [ ] **Step 2: Create `public/how-it-works.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#18191b">
    <meta name="description" content="How Nearline works: location filtering, fading threads, trending, and the system design behind them.">
    <title>How Nearline Works</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body class="doc">
    <div class="doc-shell">
      <header class="doc-header">
        <span class="painted-mark">Nearline</span>
        <a class="text-link back-link" href="/">Back to Nearline</a>
      </header>

      <main>
        <h1>How Nearline works</h1>
        <p class="lede">Nearline is a feed of posts from the people physically around you. Nothing here is permanent: a thread fades fifteen minutes after the last thing that happened in it. This page explains every part of how that works, from the hexagons on the map to the machinery that would let it serve a billion people.</p>

        <ol class="toc">
          <li><a href="#where">1. Where you are: hexagons, not coordinates</a></li>
          <li><a href="#range">2. How far you listen</a></li>
          <li><a href="#threads">3. Threads, and why they fade</a></li>
          <li><a href="#trending">4. What makes a thread trend</a></li>
          <li><a href="#reposts">5. Reposts carry threads across the map</a></li>
          <li><a href="#rooms">6. Private filters</a></li>
          <li><a href="#parts">7. The parts of the system</a></li>
          <li><a href="#post">8. Following a post</a></li>
          <li><a href="#like">9. Following a like, and why there is a queue</a></li>
          <li><a href="#read">10. Reading the feed</a></li>
          <li><a href="#scale">11. Built for a billion people</a></li>
          <li><a href="#identity">12. Identity and sign-in</a></li>
          <li><a href="#privacy">13. What the server knows</a></li>
          <li><a href="#code">14. Where the code lives</a></li>
          <li><a href="#glossary">15. Glossary</a></li>
        </ol>

        <section id="where" aria-labelledby="where-title">
          <h2 id="where-title">1. Where you are: hexagons, not coordinates</h2>
          <p>Your phone knows your latitude and longitude to within a few metres. Nearline never sends those numbers anywhere. Instead, your browser converts them into the ID of a hexagon on a map grid called <strong>H3</strong>, made by Uber and used by many mapping systems.</p>
          <p>H3 covers the whole planet in hexagons at sixteen sizes, called <em>resolutions</em>. Each size fits neatly inside the next size up, like nested tiles. Nearline uses three of them for listening, plus a few larger ones for organising data (section 11):</p>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Resolution</th><th>Hexagon edge</th><th>Used for</th></tr></thead>
              <tbody>
                <tr><td>11</td><td>about 25 m</td><td>Your position, and the Close range</td></tr>
                <tr><td>10</td><td>about 66 m</td><td>The Nearby range</td></tr>
                <tr><td>9</td><td>about 174 m</td><td>The Wide range</td></tr>
                <tr><td>7 to 9</td><td>about 1.2 km to 174 m</td><td>Partitions: how data is split between servers</td></tr>
              </tbody>
            </table>
          </div>
          <p>Your position is always a resolution-11 hexagon, roughly the size of a large house. That is precise enough to know who is near whom, and coarse enough that the server never learns your exact spot.</p>
        </section>

        <section id="range" aria-labelledby="range-title">
          <h2 id="range-title">2. How far you listen</h2>
          <p>You choose a range: Close, Nearby or Wide. Each range picks a hexagon size. Nearline takes the hexagon you are in at that size, plus the six hexagons touching it. Those seven hexagons are your <strong>region</strong>, and you see every post anchored inside it.</p>
          <figure>
            <svg viewBox="0 0 320 260" role="img" aria-labelledby="region-svg-title">
              <title id="region-svg-title">A centre hexagon surrounded by six neighbours, forming a region</title>
              <g transform="translate(160 130)">
                <polygon class="diagram-faint" transform="translate(69.28 0)" points="0,-40 34.64,-20 34.64,20 0,40 -34.64,20 -34.64,-20"/>
                <polygon class="diagram-faint" transform="translate(34.64 60)" points="0,-40 34.64,-20 34.64,20 0,40 -34.64,20 -34.64,-20"/>
                <polygon class="diagram-faint" transform="translate(-34.64 60)" points="0,-40 34.64,-20 34.64,20 0,40 -34.64,20 -34.64,-20"/>
                <polygon class="diagram-faint" transform="translate(-69.28 0)" points="0,-40 34.64,-20 34.64,20 0,40 -34.64,20 -34.64,-20"/>
                <polygon class="diagram-faint" transform="translate(-34.64 -60)" points="0,-40 34.64,-20 34.64,20 0,40 -34.64,20 -34.64,-20"/>
                <polygon class="diagram-faint" transform="translate(34.64 -60)" points="0,-40 34.64,-20 34.64,20 0,40 -34.64,20 -34.64,-20"/>
                <polygon class="diagram-paint" points="0,-40 34.64,-20 34.64,20 0,40 -34.64,20 -34.64,-20"/>
                <circle class="diagram-fill" r="6"/>
                <text class="diagram-text" x="0" y="26" text-anchor="middle">you</text>
              </g>
            </svg>
            <figcaption>Your region at any range: the hexagon you are in (solid) and its six neighbours (dashed). A post is visible to you when its location falls inside these seven hexagons at your range's size.</figcaption>
          </figure>
          <p>This rule is symmetric: if you can see someone's post, they can see yours at the same range. It is also the only definition of "nearby" in the whole system. The browser, the feed and the check that decides whether you may reply all use the same function.</p>
          <p>The lane line under the range picker encodes your range the way road markings do: short dashes for Close, long dashes for Wide, like the markings on slow and fast roads.</p>
        </section>

        <section id="threads" aria-labelledby="threads-title">
          <h2 id="threads-title">3. Threads, and why they fade</h2>
          <p>A <strong>thread</strong> is a post and everything under it: replies, replies to replies at any depth, likes and reposts. The thread is the unit that lives and dies together.</p>
          <p>Every thread has an expiry time: <strong>fifteen minutes after its last activity</strong>. Activity means a new reply, a like, or a repost. Each one pushes the expiry fifteen minutes into the future. Reading a thread does not. Unliking or deleting does not. When the clock runs out, the whole thread is deleted from the servers, every reply with it.</p>
          <figure>
            <svg viewBox="0 0 700 150" role="img" aria-labelledby="life-svg-title">
              <title id="life-svg-title">A timeline where each activity resets a fifteen-minute expiry</title>
              <line class="diagram-faint" x1="20" y1="70" x2="680" y2="70"/>
              <circle class="diagram-fill" cx="40" cy="70" r="7"/>
              <text class="diagram-text" x="40" y="45" text-anchor="middle">post</text>
              <circle class="diagram-fill" cx="190" cy="70" r="7"/>
              <text class="diagram-text" x="190" y="45" text-anchor="middle">reply</text>
              <circle class="diagram-fill" cx="300" cy="70" r="7"/>
              <text class="diagram-text" x="300" y="45" text-anchor="middle">like</text>
              <line class="diagram-yellow" x1="300" y1="100" x2="640" y2="100"/>
              <line class="diagram-yellow" x1="640" y1="88" x2="640" y2="112"/>
              <text class="diagram-label" x="470" y="128" text-anchor="middle">15 minutes after the last activity</text>
              <text class="diagram-text" x="640" y="45" text-anchor="middle">gone</text>
            </svg>
            <figcaption>The post's own expiry was replaced by the reply's, then by the like's. Fifteen quiet minutes after the like, the thread disappears for everyone.</figcaption>
          </figure>
          <p>In the app, the thin line under each post is that clock. It shrinks as the thread goes quiet and snaps back to full whenever someone interacts.</p>
          <h3>Replies form a tree</h3>
          <p>You can reply to a post or to any reply. The thread view indents each level with a dashed guide. After four levels, "Continue thread" re-centres the view on that reply so deep conversations stay readable on a phone.</p>
          <h3>Deleting</h3>
          <p>You can delete your own posts. A post nobody replied to disappears. A post with replies becomes "[deleted]" so the conversation under it still makes sense. Deleting the opening post of a thread nobody replied to removes the whole thread.</p>
        </section>

        <section id="trending" aria-labelledby="trending-title">
          <h2 id="trending-title">4. What makes a thread trend</h2>
          <p>The Latest tab is simple: newest first. The Trending tab ranks threads by how much is happening in them <em>right now</em>.</p>
          <h3>Weights</h3>
          <p>In 2023 X (formerly Twitter) published the source of its recommendation algorithm. Its main ranking stage scores a post by adding up the chance of each kind of engagement multiplied by a fixed weight. Nearline borrows the relative sizes of those weights:</p>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Engagement</th><th>X's weight</th><th>Nearline's points</th></tr></thead>
              <tbody>
                <tr><td>Like</td><td>0.5</td><td>1</td></tr>
                <tr><td>Repost</td><td>1.0</td><td>2</td></tr>
                <tr><td>Reply</td><td>13.5</td><td>27</td></tr>
                <tr><td>The author replies in their own thread</td><td>75</td><td>150</td></tr>
              </tbody>
            </table>
          </div>
          <p>A reply is worth 27 likes because it costs more effort and starts a conversation. The author replying back is worth the most because it is the strongest sign a conversation is really happening.</p>
          <h3>Fairness rules</h3>
          <ul>
            <li>Each person counts once per kind of engagement per thread. Ten replies from one person score as one reply. Liking, unliking and liking again scores once.</li>
            <li>An author's own replies only score after someone else has replied, so nobody can make their own post trend by talking to themselves.</li>
            <li>A thread needs at least two different people involved to appear in Trending at all.</li>
          </ul>
          <h3>Decay</h3>
          <p>Points fade: a thread's score halves every five minutes. A burst of activity lifts a thread to the top, and it drifts down as the burst ends. Only what is happening now matters.</p>
          <h3>The trick that makes it cheap</h3>
          <p>Decaying scores sound expensive: every score changes every second, so the order would seem to need recomputing constantly. It does not. Because every score fades at the same rate, the order between two threads never changes unless one of them gets new activity. Mathematically, ranking by <code>score × 2^(−age / 5 minutes)</code> gives the same order as ranking by <code>log₂(score) + (time of last update) / 5 minutes</code>, a number that stays fixed. Nearline stores that fixed number and lets the database sort by it. Trending costs the same as sorting by date.</p>
        </section>

        <section id="reposts" aria-labelledby="reposts-title">
          <h2 id="reposts-title">5. Reposts carry threads across the map</h2>
          <p>Nearline has no followers, so a repost cannot mean "show this to my followers". Instead, reposting carries a thread to <strong>where you are standing</strong>.</p>
          <p>Every thread has one or more <strong>anchors</strong>: places it is shown from. The original post is the first anchor. Each repost adds an anchor at the reposter's location. You see a thread when any of its anchors is inside your region. A thread can travel: someone a few streets away reposts it, then someone near them reposts it again, and it spreads hand to hand as long as people keep it alive.</p>
          <p>You can only repost a thread you can currently see, and only once.</p>
        </section>

        <section id="rooms" aria-labelledby="rooms-title">
          <h2 id="rooms-title">6. Private filters</h2>
          <p>A private filter is a room ID and a passphrase. Your browser turns the pair into a fingerprint with SHA-256 and attaches it to everything you post and read. Only people nearby using the same pair see those threads, and you see only theirs. There is no list of rooms, no members and no owner: a room exists only as long as people use the same words.</p>
          <p>A private filter is an organising tool, not encryption. Anyone who guesses the same room ID and passphrase sees the same threads, and the server can see post text like any other post.</p>
        </section>

        <section id="parts" aria-labelledby="parts-title">
          <h2 id="parts-title">7. The parts of the system</h2>
          <p>Nearline runs on Cloudflare. Each part has one job, and each is split up independently so that no single machine has to handle everyone.</p>
          <figure>
            <svg viewBox="0 0 760 470" role="img" aria-labelledby="parts-svg-title">
              <title id="parts-svg-title">Architecture: browser, edge worker, stores, queue and cache</title>
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="#c9c7be"/></marker>
                <marker id="arrow-yellow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="#f2c230"/></marker>
              </defs>
              <rect class="diagram-box-strong" x="290" y="14" width="180" height="50" rx="3"/>
              <text class="diagram-text-dark" x="380" y="45" text-anchor="middle">Your browser</text>
              <path class="diagram-arrow" d="M380 66 V108"/>
              <text class="diagram-label" x="392" y="92">HTTPS polls and actions</text>
              <rect class="diagram-box" x="160" y="110" width="440" height="64" rx="3"/>
              <text class="diagram-text" x="380" y="138" text-anchor="middle">Edge Worker (runs in every Cloudflare city)</text>
              <text class="diagram-label" x="380" y="160" text-anchor="middle">checks sign-in · validates · rate-limits · builds feeds · caches</text>
              <rect class="diagram-box" x="630" y="118" width="116" height="48" rx="3"/>
              <text class="diagram-text" x="688" y="147" text-anchor="middle">Edge cache</text>
              <path class="diagram-arrow" d="M602 142 H628"/>
              <path class="diagram-arrow" d="M230 176 V250"/>
              <path class="diagram-arrow" d="M380 176 V250"/>
              <path class="diagram-arrow" d="M530 176 V250"/>
              <rect class="diagram-box" x="150" y="252" width="160" height="70" rx="3"/>
              <text class="diagram-text" x="230" y="282" text-anchor="middle">Thread stores</text>
              <text class="diagram-label" x="230" y="304" text-anchor="middle">one per thread</text>
              <rect class="diagram-box" x="320" y="252" width="120" height="70" rx="3"/>
              <text class="diagram-text" x="380" y="282" text-anchor="middle">Cell indexes</text>
              <text class="diagram-label" x="380" y="304" text-anchor="middle">one per area</text>
              <rect class="diagram-box" x="450" y="252" width="160" height="70" rx="3"/>
              <text class="diagram-text" x="530" y="282" text-anchor="middle">User state</text>
              <text class="diagram-label" x="530" y="304" text-anchor="middle">65,536 buckets</text>
              <rect class="diagram-box" x="230" y="388" width="300" height="56" rx="3"/>
              <text class="diagram-text" x="380" y="421" text-anchor="middle">Queue: follow-on changes</text>
              <path class="diagram-arrow-async" d="M230 324 V386"/>
              <path class="diagram-arrow-async" d="M530 324 V386"/>
              <path class="diagram-arrow-async" d="M380 386 V326"/>
              <path class="diagram-arrow-async" d="M300 386 C 300 360, 260 350, 250 326"/>
              <rect class="diagram-box" x="20" y="252" width="110" height="70" rx="3"/>
              <text class="diagram-text" x="75" y="282" text-anchor="middle">D1</text>
              <text class="diagram-label" x="75" y="304" text-anchor="middle">passkeys</text>
              <path class="diagram-arrow" d="M170 176 C 120 200, 90 220, 80 250"/>
            </svg>
            <figcaption>Solid arrows are requests the browser waits for. Dashed yellow arrows are follow-on changes delivered through the queue a second or two later.</figcaption>
          </figure>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Part</th><th>Split by</th><th>Its job</th></tr></thead>
              <tbody>
                <tr><td>Edge Worker</td><td>Not split: it keeps no data</td><td>Receives every request, checks who you are, rejects bad input, limits how fast anyone can act, assembles feeds and caches them.</td></tr>
                <tr><td>Thread store</td><td>One per thread</td><td>The single, authoritative copy of a thread: its posts, reply tree, counts, score and expiry. It deletes itself when the thread expires.</td></tr>
                <tr><td>Cell index</td><td>One per area of the map</td><td>A list of references: "thread T is anchored at place P, scores this much, expires then." It never holds post text.</td></tr>
                <tr><td>User state</td><td>65,536 buckets of users</td><td>Remembers what each person liked and reposted, so "did I already like this?" never touches a busy thread.</td></tr>
                <tr><td>Queue</td><td>Batches</td><td>Carries follow-on changes between the parts reliably, retrying until each one lands.</td></tr>
                <tr><td>Edge cache</td><td>Per Cloudflare city</td><td>Keeps finished feeds for 3 seconds and threads for 2, so most requests are answered without touching any store.</td></tr>
                <tr><td>D1 database</td><td>One</td><td>Accounts, passkeys and long-lived sign-in sessions. Never post content.</td></tr>
              </tbody>
            </table>
          </div>
          <p>The thread stores, cell indexes and user state are <strong>Durable Objects</strong>: small Cloudflare servers, each with its own private SQLite database, that exist only while they have something to hold. There can be billions of them, and each one handles only its own slice of the work.</p>
          <div class="note">The key idea: <strong>every thread has exactly one source of truth</strong>, its thread store. Everything else either points at it (cell indexes) or is a short-lived copy (the cache).</div>
        </section>

        <section id="post" aria-labelledby="post-title">
          <h2 id="post-title">8. Following a post</h2>
          <ol class="steps">
            <li>You type and press Post. Your browser shows the post at once with a dashed outline, before the server has answered.</li>
            <li>The browser sends the text, your resolution-11 hexagon, your range and your room fingerprint to <code>POST /api/actions</code>.</li>
            <li>The Edge Worker checks your sign-in token, the text length and your rate limit.</li>
            <li>It invents a new ID for the thread and creates its thread store, asking Cloudflare to place it in a data centre near you.</li>
            <li>The thread store saves the post, sets the expiry to fifteen minutes from now, and sets an alarm for that moment.</li>
            <li>It puts a note on the queue: "add a reference to this thread in the area index covering this hexagon".</li>
            <li>The browser receives the new ID and swaps its placeholder for the real post.</li>
            <li>A second or two later, the queue delivers the note and the cell index records the reference. From then on, anyone whose region includes your hexagon sees the post on their next refresh.</li>
          </ol>
        </section>

        <section id="like" aria-labelledby="like-title">
          <h2 id="like-title">9. Following a like, and why there is a queue</h2>
          <p>A like has to change three places: your user state ("you liked this"), the thread store (the count and the score) and every cell index that points at the thread (so Trending re-orders and the expiry moves).</p>
          <p>Doing all of that while you wait would be slow, and fragile: if the third step failed, the like would be half-recorded forever. On a post going viral, it would also send a hundred thousand separate updates a second into one thread store, which no single server can absorb.</p>
          <ol class="steps">
            <li>Your tap changes your own screen immediately.</li>
            <li>The Edge Worker asks your user state bucket to record the like. This is the one step that must be exact, so a double tap cannot count twice. It also reports whether this is your first like anywhere in this thread, which is what decides if it scores.</li>
            <li>The Worker puts a note on the queue: "thread T, post P, +1, first like: yes" and answers your browser.</li>
            <li>A background consumer collects notes in batches of up to 100, groups them by thread, and makes <strong>one</strong> call per thread: "+87 likes, 80 of them first likes".</li>
            <li>The thread store applies the batch, updates the score and expiry, and leaves one note per area index: "thread T now scores this much and expires then".</li>
            <li>The consumer delivers those to the cell indexes, again batched.</li>
          </ol>
          <h3>Duplicates and disorder</h3>
          <p>The queue guarantees every note arrives at least once, but a note may arrive twice, and notes may arrive out of order. Every store remembers the IDs of notes it has applied for twenty minutes and ignores repeats. Counts are stored as plus-one and minus-one changes, which add up correctly in any order, so an unlike that arrives before its like still ends at the right number. When a thread expires, each area index keeps a short "tombstone" so a late note cannot bring it back.</p>
        </section>

        <section id="read" aria-labelledby="read-title">
          <h2 id="read-title">10. Reading the feed</h2>
          <p>Nearline never pushes anything to your phone. Your browser asks for updates: every 5 seconds for the feed, every 3 seconds for an open thread. After a minute with no change it slows down, doubling the wait up to 30 seconds. While the tab is hidden it stops. This is called <strong>polling</strong>, and it is how X's own timeline works.</p>
          <h3>Why polling scales</h3>
          <p>Everyone standing in the same hexagon, at the same range, in the same room, sees exactly the same feed. So the request does not include your exact position, only the hexagon at your range's size, and the answer can be shared. The first person to ask in each Cloudflare city builds the feed; everyone else for the next 3 seconds gets the cached copy. A stadium of 80,000 people costs about as much as one person.</p>
          <p>Each response carries a version tag. When your browser asks again, it sends the tag it already has. If nothing changed, the server answers "304 Not Modified" with no content at all.</p>
          <h3>Building a feed</h3>
          <ol class="steps">
            <li>Work out your seven region hexagons and which area indexes cover them (usually one or two).</li>
            <li>Ask each area index for its references in those hexagons, newest first or by trend, already filtered for expiry and room.</li>
            <li>Merge the lists, keeping each thread once, through its newest anchor you can see.</li>
            <li>Fetch the thirty threads' summaries from their thread stores, through a 2-second cache.</li>
            <li>Cache the result for 3 seconds and send it.</li>
          </ol>
          <p>Your own likes and reposts are fetched separately from your user state, never cached for others, and only for threads your browser has not asked about before.</p>
        </section>

        <section id="scale" aria-labelledby="scale-title">
          <h2 id="scale-title">11. Built for a billion people</h2>
          <p>Nearline will probably never have a billion users, but it was designed so that it could. At that size the hard part is not the total number of people. It is that they bunch up: a stadium, a viral post, the centre of Tokyo.</p>
          <h3>A stadium</h3>
          <p>Eighty thousand people in one hexagon all poll the same cached feed. The area index behind it sees roughly one request every three seconds per Cloudflare city.</p>
          <h3>A viral thread</h3>
          <p>A hundred thousand likes a second land in 65,536 different user-state buckets, spread by a hash of each person's ID. The thread store itself receives a few batched updates a second from the queue.</p>
          <h3>A dense city: areas that split themselves</h3>
          <p>References are stored in area indexes, each responsible for one hexagon of the map. By default that hexagon is resolution 7, about five square kilometres. Each area index counts its reads and writes every minute. If it stays above 600 writes or 30,000 reads a minute for five minutes in a row, it splits into its seven smaller children (resolution 8), and those can split again down to resolution 9. When all the children stay below a quarter of those limits for thirty minutes, they merge back.</p>
          <figure>
            <svg viewBox="0 0 640 220" role="img" aria-labelledby="split-svg-title">
              <title id="split-svg-title">One busy hexagon splitting into seven smaller hexagons</title>
              <g transform="translate(130 110)">
                <polygon class="diagram-paint" points="0,-80 69.28,-40 69.28,40 0,80 -69.28,40 -69.28,-40"/>
                <text class="diagram-text" x="0" y="6" text-anchor="middle">busy area</text>
              </g>
              <path class="diagram-arrow" d="M240 110 H360"/>
              <text class="diagram-label" x="300" y="96" text-anchor="middle">split</text>
              <g transform="translate(500 110)">
                <polygon class="diagram-paint" points="0,-28 24.25,-14 24.25,14 0,28 -24.25,14 -24.25,-14"/>
                <polygon class="diagram-paint" transform="translate(48.5 0)" points="0,-28 24.25,-14 24.25,14 0,28 -24.25,14 -24.25,-14"/>
                <polygon class="diagram-paint" transform="translate(24.25 42)" points="0,-28 24.25,-14 24.25,14 0,28 -24.25,14 -24.25,-14"/>
                <polygon class="diagram-paint" transform="translate(-24.25 42)" points="0,-28 24.25,-14 24.25,14 0,28 -24.25,14 -24.25,-14"/>
                <polygon class="diagram-paint" transform="translate(-48.5 0)" points="0,-28 24.25,-14 24.25,14 0,28 -24.25,14 -24.25,-14"/>
                <polygon class="diagram-paint" transform="translate(-24.25 -42)" points="0,-28 24.25,-14 24.25,14 0,28 -24.25,14 -24.25,-14"/>
                <polygon class="diagram-paint" transform="translate(24.25 -42)" points="0,-28 24.25,-14 24.25,14 0,28 -24.25,14 -24.25,-14"/>
              </g>
            </svg>
            <figcaption>A busy area becomes seven areas, each with its own index and its own share of the work.</figcaption>
          </figure>
          <p>Splitting normally means moving data, which is slow and risky. Nearline avoids it entirely because nothing lives longer than fifteen minutes after its last update. After a split, new references go to the new areas, while readers check both the old and the new areas for sixteen minutes. By then everything in the old area has expired on its own.</p>
          <h3>Sign-in without a database lookup</h3>
          <p>Checking a database on every poll would make the account database the bottleneck. Instead, each sign-in also issues a <strong>signed access token</strong> valid for an hour. The Edge Worker verifies its signature mathematically, with no lookup. Once an hour, a longer-lived session in D1 is checked and a new token issued.</p>
          <h3>Keeping data near its people</h3>
          <p>A local product is naturally regional. Thread stores and area indexes are created in the Cloudflare region closest to their place on the map, so Tokyo's posts live in Asia and São Paulo's in South America.</p>
        </section>

        <section id="identity" aria-labelledby="identity-title">
          <h2 id="identity-title">12. Identity and sign-in</h2>
          <p>There are no usernames or passwords. You sign in with a <strong>passkey</strong>: a key pair your device creates and guards with your fingerprint, face or PIN. The server stores only the public half. Your public identity is the first eight characters of a hash of that public key, like <code>@4f92ac17</code>. Its coloured square, the "road stud", is derived from the same characters, so you can tell people apart without profiles.</p>
          <p>Signing out deletes your long-lived session at once. An access token already issued stays valid until it expires, at most an hour later: the price of checking tokens without a database.</p>
        </section>

        <section id="privacy" aria-labelledby="privacy-title">
          <h2 id="privacy-title">13. What the server knows</h2>
          <ul>
            <li><strong>Never:</strong> your latitude and longitude. They stay in your browser.</li>
            <li><strong>When you post or repost:</strong> the resolution-11 hexagon you were in, about 25 metres across. It is stored with the thread and deleted when the thread expires.</li>
            <li><strong>When you read:</strong> only the hexagon at your range's size, which is coarser.</li>
            <li><strong>Post text:</strong> stored until the thread expires, then deleted with it. Nothing is archived.</li>
            <li><strong>Your likes and reposts:</strong> kept in your user-state bucket for 24 hours so you cannot like the same thing twice, then deleted.</li>
            <li><strong>Your account:</strong> your passkey's public key and your sign-in sessions.</li>
          </ul>
        </section>

        <section id="code" aria-labelledby="code-title">
          <h2 id="code-title">14. Where the code lives</h2>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Folder or file</th><th>What it does</th></tr></thead>
              <tbody>
                <tr><td><code>packages/geo</code></td><td>Every use of the H3 hexagon library: positions, regions, the visibility rule.</td></tr>
                <tr><td><code>packages/feed</code></td><td>Pure logic: trending scores, reply trees, partitions, feed ordering, location hints.</td></tr>
                <tr><td><code>packages/protocol</code></td><td>The shapes of every request and response, and their validation.</td></tr>
                <tr><td><code>packages/shared</code></td><td>Constants (every number on this page), encodings, IDs and access tokens.</td></tr>
                <tr><td><code>workers/edge/api</code></td><td>The HTTP endpoints: feed, thread, engagement and actions.</td></tr>
                <tr><td><code>workers/edge/stores</code></td><td>All the SQL, tested against a real SQLite engine.</td></tr>
                <tr><td><code>workers/edge/durable-objects</code></td><td>The thin Durable Object classes around the stores, and area splitting.</td></tr>
                <tr><td><code>workers/edge/queue</code></td><td>The batching consumer for follow-on changes.</td></tr>
                <tr><td><code>apps/web</code></td><td>The browser app: polling, state, rendering.</td></tr>
                <tr><td><code>docs/superpowers/specs</code></td><td>The design documents this was built from.</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="glossary" aria-labelledby="glossary-title">
          <h2 id="glossary-title">15. Glossary</h2>
          <div class="table-wrap">
            <table>
              <tbody>
                <tr><th scope="row">Anchor</th><td>A place a thread is shown from: the original post, or a repost.</td></tr>
                <tr><th scope="row">Cell index</th><td>The list of thread references for one area of the map.</td></tr>
                <tr><th scope="row">Durable Object</th><td>A small Cloudflare server with its own database, created on demand, one per thread, area or user bucket.</td></tr>
                <tr><th scope="row">Edge</th><td>Cloudflare's servers in hundreds of cities, close to wherever you are.</td></tr>
                <tr><th scope="row">H3</th><td>A grid of hexagons covering the planet at sixteen sizes.</td></tr>
                <tr><th scope="row">Half-life</th><td>The time it takes a trending score to fall by half: five minutes.</td></tr>
                <tr><th scope="row">Idempotent</th><td>Safe to apply twice: the second time changes nothing.</td></tr>
                <tr><th scope="row">Partition</th><td>The area of the map one cell index is responsible for.</td></tr>
                <tr><th scope="row">Polling</th><td>The browser asking for updates on a timer, rather than the server pushing them.</td></tr>
                <tr><th scope="row">Queue</th><td>A reliable to-do list between parts of the system, retried until each item succeeds.</td></tr>
                <tr><th scope="row">Reference</th><td>A cell index row pointing at a thread. Never a copy of its content.</td></tr>
                <tr><th scope="row">Region</th><td>Your hexagon at your range's size, plus its six neighbours.</td></tr>
                <tr><th scope="row">Source of truth</th><td>The one place whose copy wins. For a thread, its thread store.</td></tr>
                <tr><th scope="row">Tombstone</th><td>A short-lived marker that a thread expired, so late changes cannot revive it.</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  </body>
</html>
```

- [ ] **Step 3: Check every number against the constants**

Run:

```bash
grep -nE "THREAD_TTL_MS|TREND_HALF_LIFE_MS|ENGAGEMENT_WEIGHTS|TREND_MIN_PARTICIPANTS|POLL_|FEED_CACHE_SECONDS|THREAD_CACHE_SECONDS|PARTITION_|SPLIT_|MERGE_QUIET|ACCESS_TOKEN_TTL_MS|USER_STATE_RETENTION_MS|EVENT_RETENTION_MS" packages/shared/constants.ts
```

Expected: the values match the page (15 min, 5 min half-life, weights 1/2/27/150, 2 participants, polls 5/3/30 s and 60 s, caches 3/2 s, partitions 7–9, 600 writes/30,000 reads, 5 and 30 minutes, 16-minute window, 1-hour token, 24-hour user state, 20-minute idempotency). Fix the page if any differ.

- [ ] **Step 4: Visual check**

Run `npm run build`, serve `public/` statically, and capture `how-it-works.html` at 390 px and 1440 px wide in one round. Check that the diagrams are legible on both, nothing overflows horizontally at 390 px (tables scroll inside `.table-wrap`), and the page scrolls. Fix in one batch.

- [ ] **Step 5: Commit**

```bash
git add public/how-it-works.html public/styles.css
git commit -F - <<'EOF'
docs(web): add a public page explaining how Nearline works

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---
### Task 19: Update SPEC.md and README.md

**Files:**
- Modify: `SPEC.md`, `README.md`

**Interfaces:**
- Consumes: the finished system.
- Produces: documentation that no longer describes the live chat as current.

- [ ] **Step 1: Rewrite the superseded parts of SPEC.md**

Run this script from the repository root. It replaces whole sections by their headings and fails loudly if a heading is missing:

```bash
python3 - <<'EOF'
import re
path = "SPEC.md"
spec = open(path).read()

def replace_between(text, start, end, body):
    i = text.index(start)
    j = text.index(end, i + len(start))
    return text[:i] + body + text[j:]

spec = spec.replace(
    "**Status:** Locked v1 design  \n",
    "**Status:** v1 design; the live chat parts were superseded on 2026-10-05 by the local feed "
    "(`docs/superpowers/specs/2026-10-05-local-feed-design.md`). Where this document and that design disagree, the design wins.  \n",
    1,
)

spec = replace_between(spec, "### 2.3 The client owns its transcript", "### 2.5 Location authenticity is not guaranteed", """### 2.3 Threads are the unit of persistence

Posts, replies, likes and reposts belong to a thread. The server keeps a thread only while it is active: every thread is deleted fifteen minutes after its last activity (a reply, a like or a repost).

### 2.4 Delivery is pull-only

Clients poll for feeds and threads. The server never pushes. Feeds are shared and cached per scope cell, room and tab, so a crowd in one place costs about as much as one person.

""")

spec = replace_between(spec, "# 8. Durable Object Sharding", "# 17. Authentication Flow", """# 8–16. Local Feed Architecture (replaces sharding, WebSockets and fanout)

The live chat's geographic shard Durable Object, WebSocket protocol and fanout are retired. The system is now:

- **Edge Worker** (stateless): authentication, validation, rate limits, feed assembly, edge caching.
- **ThreadStore** Durable Object, one per thread: the single source of truth for a thread's posts, reply tree, counts, trending score and expiry. It deletes itself when the thread expires.
- **CellIndex** Durable Object, one per partition cell (H3 resolution 7 to 9, splitting and merging with load): references to threads anchored in its cell, with ordering data only.
- **UserState** Durable Object, 65,536 buckets: each user's likes and reposts.
- **Queue** `nearline-feed-events`: propagates follow-on changes between them, batched, at least once, idempotently.
- **Workers KV** `PARTITION_MAP`: which cells are split.

HTTP API: `GET /api/feed`, `GET /api/threads/:id`, `GET /api/me/engagement`, `POST /api/actions`. Full details, including the protocol types, trending formula, partitioning and capacity reasoning, are in `docs/superpowers/specs/2026-10-05-local-feed-design.md`. A plain-language explanation is served at `/how-it-works.html`.

---

""")

spec = replace_between(spec, "# 18. Worker Routing", "# 19. Rate Limiting and Abuse Foundation", """# 18. Worker Routing

| Route | Purpose |
|---|---|
| `/api/auth/*` | Passkey registration, login, session and logout |
| `GET /api/feed` | A page of the Latest or Trending feed for a scope cell, range and room |
| `GET /api/threads/:id` | A thread's summary and full reply tree |
| `GET /api/me/engagement` | The signed-in user's likes and reposts for given threads |
| `POST /api/actions` | Post, reply, like, unlike, repost, delete |
| `POST /api/client-error` | Bounded client diagnostics |
| `GET /api/health` | Health check |
| everything else | Static assets |

`POST` requests must carry `Origin` equal to the configured origin.

---

""")

spec = replace_between(spec, "## Geographic Durable Object SQLite contains", "## Browser contains", """## Durable Object SQLite contains

- ThreadStore: one thread's posts, counts, score, participants and where its references live, until the thread expires.
- CellIndex: references (thread id, anchor cell, time, ordering snapshot, expiry), idempotency records and tombstones for 20 minutes, per-minute load counts.
- UserState: likes and reposts per user for 24 hours.

""")

open(path, "w").write(spec)
EOF
grep -nE "^# (8|17|18|19)|^### 2\.[345]|^## (Durable Object SQLite contains|Browser contains)" SPEC.md
```

Expected: the headings `### 2.3 Threads are the unit of persistence`, `### 2.4 Delivery is pull-only`, `# 8–16. Local Feed Architecture…`, `# 17. Authentication Flow`, `# 18. Worker Routing`, `# 19. …`, `## Durable Object SQLite contains` and `## Browser contains` all appear.

- [ ] **Step 2: Rewrite README.md**

Replace `README.md` with:

~~~markdown
# Nearline

A local, X-style feed for the people physically around you: posts, replies, likes and reposts, filtered by where you are. Every thread fades fifteen minutes after its last activity. Built on Cloudflare Workers, Durable Objects, Queues, Workers KV, D1, H3 and passkeys.

- How it works, in plain language: [`public/how-it-works.html`](./public/how-it-works.html) (served at `/how-it-works.html`)
- Design: [`docs/superpowers/specs/2026-10-05-local-feed-design.md`](./docs/superpowers/specs/2026-10-05-local-feed-design.md)
- Original v1 specification: [`SPEC.md`](./SPEC.md)

## Local development

Requirements: Node.js 22.5+ (the tests use `node:sqlite`), a WebAuthn-capable browser, and a Cloudflare account.

```bash
npm install
npm test
npm run build
```

Running the Worker locally needs a `.dev.vars` file:

```
SESSION_KEY=any-long-random-string
RP_ID=localhost
ORIGIN=http://localhost:8787
```

then:

```bash
npx wrangler d1 migrations apply proximity-chat-auth --local
npm run dev
```

## Deploying

One-time setup per environment:

```bash
npx wrangler queues create nearline-feed-events
npx wrangler kv namespace create PARTITION_MAP        # put the id in wrangler.jsonc
openssl rand -base64 48 | npx wrangler secret put SESSION_KEY
npx wrangler d1 migrations apply proximity-chat-auth --remote
```

Then `npm run deploy`. A preview Worker at `preview.nearline.sxm.li` is configured as the `preview` environment: `npm run build:web && npx wrangler deploy --env preview`.

## Commands

- `npm test` — unit, store and handler tests (stores run against real SQLite via `node:sqlite`)
- `npm run typecheck` — strict TypeScript for the Worker and the browser app
- `npm run build` — browser bundle plus typecheck
- `npm run dev` — build the browser bundle and start Wrangler

## Structure

- `apps/web` — the browser app: polling, state, rendering
- `packages/geo` — the only module that uses H3
- `packages/feed` — trending scores, reply trees, partitions, feed ordering
- `packages/protocol` — HTTP request and response types and validation
- `packages/shared` — constants, encoding, UUIDv7, access tokens
- `workers/edge` — the Worker: API handlers, stores, Durable Objects, queue consumer, auth
- `migrations/d1` — accounts, passkeys and sessions
~~~

- [ ] **Step 3: Commit**

```bash
git add SPEC.md README.md
git commit -F - <<'EOF'
docs: update SPEC and README for the local feed

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```

---

### Task 20: Preview, then production

**Files:**
- Modify: `wrangler.jsonc` (add the `preview` environment)

**Interfaces:**
- Consumes: everything.
- Produces: a working preview at `https://preview.nearline.sxm.li`, then production after the user approves.

Every step here changes the Cloudflare account or the live site. Confirm each one with the user before running it.

- [ ] **Step 1: Create the preview resources and the session secrets**

```bash
npx wrangler queues create nearline-feed-events-preview
npx wrangler kv namespace create PARTITION_MAP_PREVIEW
openssl rand -base64 48 | npx wrangler secret put SESSION_KEY
openssl rand -base64 48 | npx wrangler secret put SESSION_KEY --env preview
```

Keep the preview KV id for Step 2.

- [ ] **Step 2: Add the preview environment**

Add this top-level key to `wrangler.jsonc` (after `"observability"`), replacing `REPLACE_WITH_PREVIEW_PARTITION_MAP_ID` with the id from Step 1:

```jsonc
  "env": {
    "preview": {
      "name": "nearline-preview",
      "routes": [{ "pattern": "preview.nearline.sxm.li", "custom_domain": true }],
      "vars": {
        "RP_NAME": "Nearline",
        "RP_ID": "nearline.sxm.li",
        "ORIGIN": "https://preview.nearline.sxm.li"
      },
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "proximity-chat-auth",
          "database_id": "5556c6eb-50bb-4c78-ae6e-63623074018b",
          "migrations_dir": "migrations/d1"
        }
      ],
      "durable_objects": {
        "bindings": [
          { "name": "THREAD_STORE", "class_name": "ThreadStore" },
          { "name": "CELL_INDEX", "class_name": "CellIndex" },
          { "name": "USER_STATE", "class_name": "UserState" }
        ]
      },
      "exports": {
        "ThreadStore": { "type": "durable-object", "storage": "sqlite" },
        "CellIndex": { "type": "durable-object", "storage": "sqlite" },
        "UserState": { "type": "durable-object", "storage": "sqlite" }
      },
      "queues": {
        "producers": [{ "binding": "FEED_EVENTS", "queue": "nearline-feed-events-preview" }],
        "consumers": [{ "queue": "nearline-feed-events-preview", "max_batch_size": 100, "max_batch_timeout": 1, "max_retries": 10 }]
      },
      "kv_namespaces": [
        { "binding": "PARTITION_MAP", "id": "REPLACE_WITH_PREVIEW_PARTITION_MAP_ID" }
      ],
      "ratelimits": [
        { "name": "MESSAGE_LIMITER", "namespace_id": "2002", "simple": { "limit": 20, "period": 10 } },
        { "name": "REGISTER_LIMITER", "namespace_id": "2003", "simple": { "limit": 3, "period": 60 } },
        { "name": "LIKE_LIMITER", "namespace_id": "2004", "simple": { "limit": 30, "period": 10 } },
        { "name": "READ_LIMITER", "namespace_id": "2005", "simple": { "limit": 120, "period": 60 } }
      ],
      "triggers": { "crons": [] }
    }
  }
```

The preview shares production's D1 database, so existing passkeys work on it: the relying party ID `nearline.sxm.li` is valid for the `preview.` subdomain. It has its own Durable Objects, queue and KV, so preview posts never appear in production.

- [ ] **Step 3: Validate and deploy the preview**

```bash
npm test && npm run build
npx wrangler deploy --env preview --dry-run --outdir .wrangler/dry-run-preview
npx wrangler deploy --env preview
```

Expected: the dry run lists the preview bindings; the deploy prints `preview.nearline.sxm.li (custom domain)`.

- [ ] **Step 4: Smoke-test the preview**

```bash
curl -sS https://preview.nearline.sxm.li/api/health
curl -sS -o /dev/null -w "%{http_code}\n" https://preview.nearline.sxm.li/how-it-works.html
curl -sS -o /dev/null -w "%{http_code}\n" "https://preview.nearline.sxm.li/api/feed?cell=x&scope=10&room=&tab=latest"
curl -sS -o /dev/null -w "%{http_code}\n" -X POST -H "Origin: https://evil.example" https://preview.nearline.sxm.li/api/actions
```

Expected: `{"ok":true}`, `200`, `401` (not signed in), `403` (wrong origin).

Then ask the user to open `https://preview.nearline.sxm.li` on their phone, sign in with their existing passkey, and try: posting, replying, a reply to a reply, liking, reposting from a second device or account, the Trending tab, a private filter, and leaving a thread idle for fifteen minutes. Fix anything they report before continuing.

- [ ] **Step 5: Deploy to production (only after the user approves the preview)**

```bash
npm run deploy
curl -sS https://nearline.sxm.li/api/health
```

Expected: the deploy reports the `GeoShardLive` class as deleted and the three new classes as created, and prints `nearline.sxm.li (custom domain)`; health returns `{"ok":true}`.

- [ ] **Step 6: Commit**

```bash
git add wrangler.jsonc
git commit -F - <<'EOF'
chore(deploy): add preview environment

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JFdr2SZV1TLC8HYwin8YJb
EOF
```
