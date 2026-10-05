import { describe, expect, it } from "vitest";
import { isRoomTag } from "../packages/protocol/index.ts";
import { uuidv7 } from "../packages/shared/uuid.ts";

describe("protocol invariants", () => {
  it("generates valid, time-sortable UUIDv7 identifiers", () => {
    const earlier = uuidv7(1_700_000_000_000);
    const later = uuidv7(1_700_000_000_001);
    expect(earlier).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(earlier < later).toBe(true);
  });

  it("accepts the public tag and SHA-256 hex room tags only", () => {
    expect(isRoomTag("")).toBe(true);
    expect(isRoomTag("a".repeat(64))).toBe(true);
    expect(isRoomTag("A".repeat(64))).toBe(false);
    expect(isRoomTag("a".repeat(63))).toBe(false);
    expect(isRoomTag(null)).toBe(false);
  });
});
