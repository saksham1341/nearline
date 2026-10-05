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
