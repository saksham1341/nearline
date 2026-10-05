import { describe, expect, it } from "vitest";
import { latLngToCanonicalLocation, parentAt, regionCells, locationToScopeCell } from "../packages/geo/index.ts";
import {
  EMPTY_PARTITION_MAP,
  isQuiet,
  minuteOf,
  partitionFor,
  regionPartitions,
  shouldSplit,
  type LoadSample,
} from "../packages/feed/partition.ts";
import { PARTITION_DUAL_READ_MS, SPLIT_WRITES_PER_MINUTE, SPLIT_READS_PER_MINUTE } from "../packages/shared/constants.ts";

const london = latLngToCanonicalLocation(51.5074, -0.1278);
const r7 = parentAt(london, 7);
const r8 = parentAt(london, 8);
const r9 = parentAt(london, 9);

describe("partition lookup", () => {
  it("defaults to the resolution-7 parent", () => {
    expect(partitionFor(london, EMPTY_PARTITION_MAP, 0)).toEqual({ write: r7, read: [r7] });
  });

  it("descends through settled splits", () => {
    const map = { splits: { [r7]: { splitAt: 0 } } };
    expect(partitionFor(london, map, PARTITION_DUAL_READ_MS)).toEqual({ write: r8, read: [r8] });
  });

  it("reads the old partition too while it drains", () => {
    const map = { splits: { [r7]: { splitAt: 1_000 } } };
    const lookup = partitionFor(london, map, 2_000);
    expect(lookup.write).toBe(r8);
    expect(lookup.read.sort()).toEqual([r7, r8].sort());
  });

  it("never descends past resolution 9 or below the cell itself", () => {
    const map = { splits: { [r7]: { splitAt: 0 }, [r8]: { splitAt: 0 }, [r9]: { splitAt: 0 } } };
    expect(partitionFor(london, map, PARTITION_DUAL_READ_MS).write).toBe(r9);
    expect(partitionFor(r8, map, PARTITION_DUAL_READ_MS).write).toBe(r8);
  });

  it("writes to the parent after a merge and keeps reading the drained child", () => {
    const map = { splits: { [r7]: { splitAt: 0, mergedAt: 5_000 } } };
    const during = partitionFor(london, map, 6_000);
    expect(during.write).toBe(r7);
    expect(during.read.sort()).toEqual([r7, r8].sort());
    expect(partitionFor(london, map, 5_000 + PARTITION_DUAL_READ_MS)).toEqual({ write: r7, read: [r7] });
  });

  it("collects the distinct partitions behind a region", () => {
    const region = regionCells(locationToScopeCell(london, 11));
    const partitions = regionPartitions(region, EMPTY_PARTITION_MAP, 0);
    expect(partitions.length).toBeGreaterThanOrEqual(1);
    expect(partitions.length).toBeLessThanOrEqual(7);
    expect(partitions).toContain(r7);
    expect(new Set(partitions).size).toBe(partitions.length);
  });
});

describe("split and merge decisions", () => {
  const busy = (minute: number): LoadSample => ({ minute, writes: SPLIT_WRITES_PER_MINUTE + 1, reads: 0 });
  const quiet = (minute: number): LoadSample => ({ minute, writes: 1, reads: 1 });

  it("splits only after five busy minutes in a row below resolution 9", () => {
    const now = minuteOf(10 * 60_000);
    const fiveBusy = [5, 6, 7, 8, 9].map(busy);
    expect(shouldSplit(fiveBusy, now, 7)).toBe(true);
    expect(shouldSplit(fiveBusy, now, 9)).toBe(false);
    expect(shouldSplit([5, 6, 8, 9].map(busy), now, 7)).toBe(false);
    expect(shouldSplit([5, 6, 7, 8, 9].map((m) => ({ minute: m, writes: 0, reads: SPLIT_READS_PER_MINUTE + 1 })), now, 7)).toBe(true);
  });

  it("is quiet when every one of the last 30 minutes stayed under a quarter of both thresholds", () => {
    const now = 100;
    const samples = Array.from({ length: 30 }, (_, i) => quiet(70 + i));
    expect(isQuiet(samples, now)).toBe(true);
    expect(isQuiet([], now)).toBe(true);
    expect(isQuiet([...samples, { minute: 99, writes: SPLIT_WRITES_PER_MINUTE, reads: 0 }], now)).toBe(false);
  });
});
