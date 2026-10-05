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
