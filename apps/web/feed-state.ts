import { decayedScore } from "../../packages/feed/score.ts";
import { ancestry, deletionOutcome } from "../../packages/feed/tree.ts";
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
  /** The branch being viewed faded and the view moved to its nearest surviving parent. */
  branchFaded: boolean;
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

  /** Thread ids whose engagement has not been fetched yet. Call `markFlagged` once the fetch succeeds. */
  takeUnflagged(): string[] {
    return [...this.threads.values()]
      .filter((entry) => !entry.pending && !this.flagged.has(entry.summary.id))
      .map((entry) => entry.summary.id)
      .slice(0, MAX_ENGAGEMENT_IDS);
  }

  markFlagged(threadIds: readonly string[]): void {
    for (const id of threadIds) this.flagged.add(id);
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
    const open = this.open;
    if (open && !open.faded) {
      // Replies fade by branch on the server's clock; the root lives as long as the thread.
      const previous = open.posts;
      open.posts = previous.filter((post) => post.parentId === null || this.pendingReplies.has(post.id) || post.expiresAt > now);
      this.refocus(previous);
    }
    return expired;
  }

  /** If the focused branch is gone, focus its nearest surviving ancestor and say so. */
  private refocus(previous: readonly PostView[]): void {
    const open = this.open;
    if (!open?.focusId || open.posts.some((post) => post.id === open.focusId)) return;
    const surviving = new Set(open.posts.map((post) => post.id));
    const chain = ancestry(previous, open.focusId).slice(0, -1).reverse();
    const nearest = chain.find((id) => surviving.has(id) && id !== open.id) ?? null;
    open.focusId = nearest;
    open.branchFaded = true;
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
      branchFaded: false,
    };
  }

  applyTree(response: ThreadResponse, etag: string | null): void {
    const open = this.open;
    if (!open || open.id !== response.summary.id) return;
    const known = new Set(response.posts.map((post) => post.id));
    for (const post of response.posts) {
      if (post.clientRef && this.pendingReplies.delete(post.clientRef)) known.add(post.clientRef);
    }
    const pending = open.posts.filter((post) => this.pendingReplies.has(post.id) && !known.has(post.id));
    const previous = open.posts;
    open.posts = [...response.posts, ...pending];
    this.refocus(previous);
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
    if (!this.open) return;
    this.open.focusId = postId;
    this.open.branchFaded = false;
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
    // The poll may bring our own post back before the action answer does: take over its pending slot.
    const ref = item.summary.root.clientRef;
    if (ref && ref !== item.summary.id && this.threads.get(ref)?.pending) {
      this.threads.delete(ref);
      for (const tab of TABS) {
        this.lists[tab] = this.lists[tab].includes(item.summary.id)
          ? this.lists[tab].filter((id) => id !== ref)
          : this.lists[tab].map((id) => (id === ref ? item.summary.id : id));
      }
    }
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
