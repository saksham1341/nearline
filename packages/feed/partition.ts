import { parentAt, resolutionOf } from "../geo/index.ts";
import {
  MERGE_QUIET_MINUTES,
  PARTITION_BASE_RESOLUTION,
  PARTITION_DUAL_READ_MS,
  PARTITION_MAX_RESOLUTION,
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
}

export const EMPTY_PARTITION_MAP: PartitionMap = { splits: {} };

export interface PartitionLookup {
  /** Where new refs for this cell go. */
  write: string;
  /** Where refs for this cell may currently live (the write partition plus any still draining). */
  read: string[];
}

/**
 * Walks down from the base resolution through split cells. Because every ref expires within
 * 15 minutes of its last update, repartitioning needs no migration: during the dual-read window
 * readers also read the partition being drained, and writers use only the new one.
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
      if (now - entry.mergedAt < PARTITION_DUAL_READ_MS) read.add(child);
      break;
    }
    if (now - entry.splitAt < PARTITION_DUAL_READ_MS) read.add(current);
    current = child;
  }
  read.add(current);
  return { write: current, read: [...read] };
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
