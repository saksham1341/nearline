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

  it("keeps the newest snapshot when an update arrives before its ref", () => {
    const store = db();
    store.apply([{ eventId: eventId(), type: "thread.updated", partition: "p", threadId: id(1), expiresAt: T + 29 * 60_000, score: 9, scoreAt: T + 14 * 60_000, participantCount: 3 }], T);
    store.apply([added(id(1), { anchorAt: T + 10 * 60_000, kind: "repost", expiresAt: T + 25 * 60_000, score: 2, scoreAt: T + 10 * 60_000, participantCount: 2 })], T);
    const [ref] = query(store, london, 10).refs;
    expect(ref).toMatchObject({ expiresAt: T + 29 * 60_000, score: 9, scoreAt: T + 14 * 60_000, participantCount: 3 });
  });

  it("returns each thread once, so one heavily reposted thread cannot fill a page", () => {
    const store = db();
    const reposts = Array.from({ length: 70 }, (_, i) => added(id(1), { anchorAt: T + 100 + i, kind: "repost", byAuthor: `bb${String(i).padStart(6, "0")}`, participantCount: 3, score: 50 }));
    store.apply([...reposts, added(id(2), { anchorAt: T + 1, participantCount: 2, score: 5 }), added(id(3), { anchorAt: T + 2, participantCount: 2, score: 4 })], T);
    expect(query(store, london, 10, "latest").refs.map((ref) => ref.threadId)).toEqual([id(1), id(3), id(2)]);
    expect(query(store, london, 10, "latest").refs[0]).toMatchObject({ anchorAt: T + 169, kind: "repost" });
    expect(query(store, london, 10, "trending").refs.map((ref) => ref.threadId)).toEqual([id(1), id(2), id(3)]);
  });
});
