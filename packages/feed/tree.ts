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
