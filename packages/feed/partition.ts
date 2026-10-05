import { parentAt, resolutionOf } from "../geo/index.ts";
import {
  MERGE_QUIET_MINUTES,
  PARTITION_BASE_RESOLUTION,
  PARTITION_DUAL_READ_MS,
  PARTITION_MAX_RESOLUTION,
  PARTITION_RETIRED_MAX_MS,
  SPLIT_READS_PER_MINUTE,
  SPLIT_SUSTAINED_MINUTES,
  SPLIT_WRITES_PER_MINUTE,
} from "../shared/constants.ts";

export interface SplitEntry {
  splitAt: number;
  mergedAt?: number;
}

/** Cells listed here are split into their children. Everything else is served at the base resolution. */
export interface PartitionMap {
  splits: Record<string, SplitEntry>;
  /** Retired partitions that reported themselves empty, with when they did. */
  drained: Record<string, number>;
}

export const EMPTY_PARTITION_MAP: PartitionMap = { splits: {}, drained: {} };

export interface PartitionLookup {
  /** Where new refs for this cell go. */
  write: string;
  /** Where refs for this cell may currently live (the write partition plus any still draining). */
  read: string[];
}

/**
 * Walks down from the base resolution through split cells. Repartitioning needs no migration:
 * writers use only the new partition, and readers keep reading the retired one until it reports
 * itself drained. Refs of an active thread keep being refreshed where they are, so a fixed window
 * would hide live threads; the drain report (or a 24-hour cap) ends the dual read instead.
 */
export function partitionFor(cell: string, map: PartitionMap, now: number): PartitionLookup {
  const cellResolution = resolutionOf(cell);
  let current = parentAt(cell, PARTITION_BASE_RESOLUTION);
  const read = new Set<string>();
  while (resolutionOf(current) < PARTITION_MAX_RESOLUTION && resolutionOf(current) < cellResolution) {
    const entry = map.splits[current];
    if (!entry) break;
    const child = parentAt(cell, resolutionOf(current) + 1);
    if (entry.mergedAt !== undefined && entry.mergedAt <= now) {
      if (stillDraining(child, entry.mergedAt, map, now)) read.add(child);
      break;
    }
    if (stillDraining(current, entry.splitAt, map, now)) read.add(current);
    current = child;
  }
  read.add(current);
  return { write: current, read: [...read] };
}

function stillDraining(cell: string, retiredAt: number, map: PartitionMap, now: number): boolean {
  const age = now - retiredAt;
  if (age < PARTITION_DUAL_READ_MS) return true;
  const drainedAt = map.drained[cell];
  const drained = drainedAt !== undefined && drainedAt >= retiredAt;
  return !drained && age < PARTITION_RETIRED_MAX_MS;
}

export function regionPartitions(cells: readonly string[], map: PartitionMap, now: number): string[] {
  const partitions = new Set<string>();
  for (const cell of cells) for (const partition of partitionFor(cell, map, now).read) partitions.add(partition);
  return [...partitions];
}

export interface LoadSample {
  minute: number;
  writes: number;
  reads: number;
}

export function minuteOf(now: number): number {
  return Math.floor(now / 60_000);
}

/** True after SPLIT_SUSTAINED_MINUTES consecutive full minutes above either threshold. */
export function shouldSplit(samples: readonly LoadSample[], currentMinute: number, resolution: number): boolean {
  if (resolution >= PARTITION_MAX_RESOLUTION) return false;
  const byMinute = new Map(samples.map((sample) => [sample.minute, sample]));
  for (let minute = currentMinute - SPLIT_SUSTAINED_MINUTES; minute < currentMinute; minute += 1) {
    const sample = byMinute.get(minute);
    if (!sample || (sample.writes <= SPLIT_WRITES_PER_MINUTE && sample.reads <= SPLIT_READS_PER_MINUTE)) return false;
  }
  return true;
}

/** True when each of the last MERGE_QUIET_MINUTES full minutes stayed under a quarter of both thresholds. */
export function isQuiet(samples: readonly LoadSample[], currentMinute: number): boolean {
  return samples.every((sample) =>
    sample.minute < currentMinute - MERGE_QUIET_MINUTES
    || sample.minute >= currentMinute
    || (sample.writes <= SPLIT_WRITES_PER_MINUTE / 4 && sample.reads <= SPLIT_READS_PER_MINUTE / 4));
}
