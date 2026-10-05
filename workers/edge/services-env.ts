import { locationHintFor } from "../../packages/feed/location-hint.ts";
import type { PartitionMap, SplitEntry } from "../../packages/feed/partition.ts";
import { PARTITION_MAP_CACHE_MS } from "../../packages/shared/constants.ts";
import { QUEUE_BATCH_LIMIT } from "./durable-objects/flush.ts";
import type { Env } from "./env.ts";
import type { CellIndexApi, LimitKind, Services, ThreadStoreApi, UserStateApi } from "./services.ts";
import { userStateName } from "./stores/user-state-db.ts";

let partitionCache: { map: PartitionMap; loadedAt: number } | null = null;

export function createServices(env: Env): Services {
  return {
    thread: (id, hint) =>
      env.THREAD_STORE.getByName(id, hint ? { locationHint: hint } : undefined) as unknown as ThreadStoreApi,
    cell: (partition) =>
      env.CELL_INDEX.getByName(partition, { locationHint: locationHintFor(partition) }) as unknown as CellIndexApi,
    user: async (userId) => env.USER_STATE.getByName(await userStateName(userId)) as unknown as UserStateApi,
    sendEvents: async (events) => {
      // Cloudflare Queues accepts at most 100 messages per sendBatch.
      for (let start = 0; start < events.length; start += QUEUE_BATCH_LIMIT) {
        await env.FEED_EVENTS.sendBatch(events.slice(start, start + QUEUE_BATCH_LIMIT).map((body) => ({ body })));
      }
    },
    partitionMap: (now) => loadPartitionMap(env.PARTITION_MAP, now),
    limit: async (kind, key) => (await limiter(env, kind).limit({ key })).success,
    cache: {
      match: async (key) => (await caches.default.match(new Request(key))) ?? undefined,
      put: (key, response) => caches.default.put(new Request(key), response),
    },
  };
}

function limiter(env: Env, kind: LimitKind): RateLimit {
  if (kind === "like") return env.LIKE_LIMITER;
  if (kind === "read") return env.READ_LIMITER;
  return env.MESSAGE_LIMITER;
}

/** Each isolate re-reads the split list every 30 s; the 16-minute dual-read window covers KV propagation. */
async function loadPartitionMap(kv: KVNamespace, now: number): Promise<PartitionMap> {
  if (partitionCache && now - partitionCache.loadedAt < PARTITION_MAP_CACHE_MS) return partitionCache.map;
  const splits: Record<string, SplitEntry> = {};
  let cursor: string | undefined;
  do {
    const page = await kv.list<SplitEntry>({ prefix: "split:", cursor });
    for (const key of page.keys) if (key.metadata) splits[key.name.slice("split:".length)] = key.metadata;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  partitionCache = { map: { splits }, loadedAt: now };
  return partitionCache.map;
}
