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
