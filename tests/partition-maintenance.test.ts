import { describe, expect, it } from "vitest";
import { childrenOf, latLngToCanonicalLocation, parentAt } from "../packages/geo/index.ts";
import type { LoadSample, SplitEntry } from "../packages/feed/partition.ts";
import { MERGE_QUIET_MINUTES, SPLIT_WRITES_PER_MINUTE } from "../packages/shared/constants.ts";
import { maintainPartition, markDrained, type PartitionKv } from "../workers/edge/durable-objects/partition-maintenance.ts";

const london = latLngToCanonicalLocation(51.5074, -0.1278);
const r7 = parentAt(london, 7);
const r8 = parentAt(london, 8);
const NOW = 100 * 60_000;

function fakeKv(initial: Record<string, { value: string; metadata?: unknown }> = {}) {
  const store = new Map(Object.entries(initial));
  const kv: PartitionKv = {
    async getWithMetadata<M>(key: string) {
      const item = store.get(key);
      return { value: item?.value ?? null, metadata: (item?.metadata as M | undefined) ?? null };
    },
    async get(key) { return store.get(key)?.value ?? null; },
    async put(key, value, options) { store.set(key, { value, metadata: options?.metadata }); },
  };
  return { kv, store };
}

const db = (partition: string | null, samples: LoadSample[]) => ({ partition: () => partition, loadSamples: () => samples });
const busyMinutes = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ minute: 100 - count + i, writes: SPLIT_WRITES_PER_MINUTE + 1, reads: 0 }));

describe("partition maintenance", () => {
  it("splits a partition after sustained load", async () => {
    const { kv, store } = fakeKv();
    expect(await maintainPartition(db(r7, busyMinutes(5)), kv, NOW)).toBe("split");
    expect(store.get(`split:${r7}`)?.metadata).toEqual({ splitAt: NOW } satisfies SplitEntry);
  });

  it("marks moderately busy partitions so their parent does not merge", async () => {
    const { kv, store } = fakeKv();
    const samples = [{ minute: 99, writes: SPLIT_WRITES_PER_MINUTE / 2, reads: 0 }];
    expect(await maintainPartition(db(r8, samples), kv, NOW)).toBe("busy");
    expect(store.has(`busy:${r8}`)).toBe(true);
  });

  it("merges a long-split parent once none of its children are busy", async () => {
    const splitAt = NOW - (MERGE_QUIET_MINUTES + 1) * 60_000;
    const { kv, store } = fakeKv({ [`split:${r7}`]: { value: "", metadata: { splitAt } } });
    expect(await maintainPartition(db(r8, []), kv, NOW)).toBe("merged");
    expect(store.get(`split:${r7}`)?.metadata).toEqual({ splitAt, mergedAt: NOW });
  });

  it("does not merge while a sibling is busy or the split is recent", async () => {
    const splitAt = NOW - (MERGE_QUIET_MINUTES + 1) * 60_000;
    const sibling = childrenOf(r7).find((cell) => cell !== r8)!;
    const busy = fakeKv({ [`split:${r7}`]: { value: "", metadata: { splitAt } }, [`busy:${sibling}`]: { value: "1" } });
    expect(await maintainPartition(db(r8, []), busy.kv, NOW)).toBe("idle");
    const recent = fakeKv({ [`split:${r7}`]: { value: "", metadata: { splitAt: NOW - 60_000 } } });
    expect(await maintainPartition(db(r8, []), recent.kv, NOW)).toBe("idle");
  });

  it("does nothing without a known partition or at the base resolution", async () => {
    const { kv } = fakeKv();
    expect(await maintainPartition(db(null, []), kv, NOW)).toBe("idle");
    expect(await maintainPartition(db(r7, []), kv, NOW)).toBe("idle");
  });

  it("reports a split partition as drained once it is empty", async () => {
    const { kv, store } = fakeKv({ [`split:${r7}`]: { value: "", metadata: { splitAt: 1 } } });
    expect(await markDrained({ partition: () => r7, isEmpty: () => false }, kv, NOW)).toBe(false);
    expect(await markDrained({ partition: () => r7, isEmpty: () => true }, kv, NOW)).toBe(true);
    expect(store.get(`drain:${r7}`)?.metadata).toEqual({ drainedAt: NOW });
  });

  it("reports a merged-away child as drained, and ignores partitions still in use", async () => {
    const merged = fakeKv({ [`split:${r7}`]: { value: "", metadata: { splitAt: 1, mergedAt: 2 } } });
    expect(await markDrained({ partition: () => r8, isEmpty: () => true }, merged.kv, NOW)).toBe(true);
    const active = fakeKv({ [`split:${r7}`]: { value: "", metadata: { splitAt: 1 } } });
    expect(await markDrained({ partition: () => r8, isEmpty: () => true }, active.kv, NOW)).toBe(false);
    expect(active.store.has(`drain:${r8}`)).toBe(false);
  });
});
