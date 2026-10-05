import { isQuiet, minuteOf, shouldSplit, type SplitEntry } from "../../../packages/feed/partition.ts";
import { childrenOf, parentAt, resolutionOf } from "../../../packages/geo/index.ts";
import {
  MERGE_QUIET_MINUTES,
  PARTITION_BASE_RESOLUTION,
  PARTITION_RETIRED_MAX_MS,
} from "../../../packages/shared/constants.ts";
import type { CellIndexDb } from "../stores/cell-index-db.ts";

/** The slice of Workers KV used for the partition map. */
export interface PartitionKv {
  getWithMetadata<M>(key: string): Promise<{ value: string | null; metadata: M | null }>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { metadata?: unknown; expirationTtl?: number }): Promise<void>;
}

const BUSY_TTL_SECONDS = 300;

/**
 * Runs from a cell index's minute alarm.
 * - Sustained load splits this partition (`split:<cell>` with `splitAt`).
 * - A partition that is not quiet writes a short-lived `busy:<cell>` key. Partitions with no traffic
 *   write nothing and count as quiet, which is why busy keys veto a merge instead of quiet keys allowing one.
 * - A quiet child of a long-split parent merges the parent back when no sibling is busy.
 * Each key is its own KV entry, so concurrent partitions never overwrite each other's decisions.
 */
export async function maintainPartition(
  db: Pick<CellIndexDb, "partition" | "loadSamples">,
  kv: PartitionKv,
  now: number,
): Promise<"split" | "merged" | "busy" | "idle"> {
  const partition = db.partition();
  if (!partition) return "idle";
  const minute = minuteOf(now);
  const samples = db.loadSamples();
  const resolution = resolutionOf(partition);

  if (shouldSplit(samples, minute, resolution)) {
    const existing = (await kv.getWithMetadata<SplitEntry>(`split:${partition}`)).metadata;
    if (!existing || existing.mergedAt !== undefined) {
      await kv.put(`split:${partition}`, "", { metadata: { splitAt: now } satisfies SplitEntry });
    }
    return "split";
  }

  if (!isQuiet(samples, minute)) {
    await kv.put(`busy:${partition}`, "1", { expirationTtl: BUSY_TTL_SECONDS });
    return "busy";
  }

  if (resolution <= PARTITION_BASE_RESOLUTION) return "idle";
  const parent = parentAt(partition, resolution - 1);
  const entry = (await kv.getWithMetadata<SplitEntry>(`split:${parent}`)).metadata;
  if (!entry || entry.mergedAt !== undefined || now - entry.splitAt < MERGE_QUIET_MINUTES * 60_000) return "idle";
  // A child that is itself split serves its load through smaller cells, which never write a busy key
  // at this level; merging over it would undo a split that is still needed.
  const children = childrenOf(parent);
  const [busy, splitChildren] = await Promise.all([
    Promise.all(children.map((child) => kv.get(`busy:${child}`))),
    Promise.all(children.map((child) => kv.getWithMetadata<SplitEntry>(`split:${child}`))),
  ]);
  if (busy.some((value) => value !== null)) return "idle";
  if (splitChildren.some(({ metadata }) => metadata !== null && metadata.mergedAt === undefined)) return "idle";
  await kv.put(`split:${parent}`, "", {
    metadata: { splitAt: entry.splitAt, mergedAt: now } satisfies SplitEntry,
    // Kept while children may still be drained; KV deletes it after the retired-partition cap.
    expirationTtl: Math.ceil(PARTITION_RETIRED_MAX_MS / 1_000) + 120,
  });
  return "merged";
}

/**
 * A retired partition (one that was split, or a child merged back into its parent) reports itself
 * drained once it holds nothing, so readers can stop reading it.
 */
export async function markDrained(
  db: Pick<CellIndexDb, "partition" | "isEmpty">,
  kv: PartitionKv,
  now: number,
): Promise<boolean> {
  const partition = db.partition();
  if (!partition || !db.isEmpty()) return false;
  const own = (await kv.getWithMetadata<SplitEntry>(`split:${partition}`)).metadata;
  let retired = own !== null && own.mergedAt === undefined;
  const resolution = resolutionOf(partition);
  if (!retired && resolution > PARTITION_BASE_RESOLUTION) {
    const parent = (await kv.getWithMetadata<SplitEntry>(`split:${parentAt(partition, resolution - 1)}`)).metadata;
    retired = parent?.mergedAt !== undefined;
  }
  if (!retired) return false;
  await kv.put(`drain:${partition}`, "", {
    metadata: { drainedAt: now },
    expirationTtl: Math.ceil(PARTITION_RETIRED_MAX_MS / 1_000) + 120,
  });
  return true;
}
