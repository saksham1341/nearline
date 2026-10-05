import type { FeedTab } from "../../packages/protocol/index.ts";
import { THREAD_TTL_MS } from "../../packages/shared/constants.ts";
import type { FeedState } from "./feed-state.ts";
import { formatAge, LIFE_TICKS, renderPostCard } from "./render-post.ts";

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
    const remainingMs = Number(life.dataset.expiresAt) - now;
    const remaining = Math.max(0, Math.min(1, remainingMs / THREAD_TTL_MS));
    // On the post as well as the line, so a theme can draw the timer anywhere on the card.
    life.style.setProperty("--life", remaining.toFixed(4));
    life.parentElement?.style.setProperty("--life", remaining.toFixed(4));
    // Whole minutes left, one tick each; ticks beyond that are spent (a theme may tear them off).
    const left = Math.max(0, Math.min(LIFE_TICKS, Math.ceil(remainingMs / 60_000)));
    if (life.dataset.left === String(left)) continue;
    life.dataset.left = String(left);
    Array.from(life.children).forEach((tick, index) => tick.classList.toggle("spent", index >= left));
  }
}
