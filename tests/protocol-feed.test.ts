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
