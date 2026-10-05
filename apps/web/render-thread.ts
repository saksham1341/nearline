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

  if (open.branchFaded && !open.faded) {
    const banner = document.createElement("p");
    banner.className = "thread-faded";
    banner.textContent = "The branch you were reading faded. This is the nearest part still active.";
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
    // Every post shows its own branch's remaining life; the root's is the thread's.
    expiresAt: isRoot ? summary?.expiresAt ?? post.expiresAt : post.expiresAt,
    pending: state.pendingReplies.has(post.id),
  });
}
