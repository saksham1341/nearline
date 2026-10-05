import { EMPTY_PARTITION_MAP, type PartitionMap } from "../../packages/feed/partition.ts";
import type { FeedEvent } from "../../workers/edge/events.ts";
import { consumeEvents } from "../../workers/edge/queue/consumer.ts";
import type { Services } from "../../workers/edge/services.ts";
import { CellIndexDb } from "../../workers/edge/stores/cell-index-db.ts";
import { ThreadDb } from "../../workers/edge/stores/thread-db.ts";
import { UserStateDb } from "../../workers/edge/stores/user-state-db.ts";
import { memorySql } from "./memory-sql.ts";

export interface FakeServices {
  services: Services;
  queue: FeedEvent[];
  drain(now: number): Promise<void>;
  setPartitionMap(map: PartitionMap): void;
}

/** Real store modules over in-memory SQLite, a synchronous queue, and an optional in-memory cache. */
export function createFakeServices(options: { cache?: boolean } = {}): FakeServices {
  const threads = new Map<string, ThreadDb>();
  const cells = new Map<string, CellIndexDb>();
  const users = new Map<string, UserStateDb>();
  const queue: FeedEvent[] = [];
  const cache = new Map<string, Response>();
  let partitionMap = EMPTY_PARTITION_MAP;

  const get = <T extends { init(): void }>(map: Map<string, T>, key: string, make: () => T): T => {
    let value = map.get(key);
    if (!value) {
      value = make();
      value.init();
      map.set(key, value);
    }
    return value;
  };
  const thread = (id: string) => get(threads, id, () => new ThreadDb(memorySql()));
  const cell = (partition: string) => get(cells, partition, () => new CellIndexDb(memorySql()));
  const user = (userId: string) => get(users, userId, () => new UserStateDb(memorySql()));

  const services: Services = {
    thread: (id) => ({
      create: async (input) => { const result = thread(id).create(input); queue.push(...result.events); return result.outcome; },
      reply: async (input) => { const result = thread(id).reply(input); queue.push(...result.events); return result.outcome; },
      remove: async (input) => { const result = thread(id).remove(input); queue.push(...result.events); return result.outcome; },
      summary: async (now) => thread(id).summary(now),
      thread: async (now) => thread(id).thread(now),
      applyLikes: async (events, now) => { queue.push(...thread(id).applyLikes(events, now)); },
      applyReposts: async (events, now) => { queue.push(...thread(id).applyReposts(events, now)); },
    }),
    cell: () => ({
      apply: async (partition, events, now) => { const db = cell(partition); db.setPartition(partition); db.apply(events, now); },
      query: async (partition, query) => cell(partition).query(query),
      hasRef: async (partition, query) => cell(partition).hasRef(query),
    }),
    user: async (userId) => ({
      like: async (input) => user(userId).like(input),
      repost: async (input) => user(userId).repost(input),
      engagement: async (id, threadIds) => user(userId).engagement(id, threadIds),
    }),
    sendEvents: async (events) => { queue.push(...events); },
    partitionMap: async () => partitionMap,
    limit: async () => true,
    cache: {
      match: async (key) => (options.cache ? cache.get(key)?.clone() : undefined),
      put: async (key, response) => { if (options.cache) cache.set(key, response.clone()); },
    },
  };

  return {
    services,
    queue,
    async drain(now) {
      for (let round = 0; round < 20 && queue.length > 0; round += 1) {
        await consumeEvents(queue.splice(0), services, now);
      }
    },
    setPartitionMap(map) {
      partitionMap = map;
    },
  };
}
