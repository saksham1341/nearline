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
  // Like the Durable Object, a thread store creates its tables only when a thread is created.
  const thread = (id: string) => {
    let db = threads.get(id);
    if (!db) {
      db = new ThreadDb(memorySql());
      threads.set(id, db);
    }
    return db;
  };
  /** What the Durable Objects do after each call: send the outbox to the queue, then acknowledge it. */
  const flush = (db: { pendingEvents(limit: number): FeedEvent[]; ackEvents(ids: readonly string[]): void }) => {
    for (let batch = db.pendingEvents(100); batch.length > 0; batch = db.pendingEvents(100)) {
      queue.push(...batch);
      db.ackEvents(batch.map((event) => event.eventId));
    }
  };
  const cell = (partition: string) => get(cells, partition, () => new CellIndexDb(memorySql()));
  const user = (userId: string) => get(users, userId, () => new UserStateDb(memorySql()));

  const services: Services = {
    thread: (id) => ({
      create: async (input) => { const db = thread(id); const result = db.create(input); flush(db); return result.outcome; },
      reply: async (input) => { const db = thread(id); const result = db.reply(input); flush(db); return result.outcome; },
      remove: async (input) => { const db = thread(id); const result = db.remove(input); flush(db); return result.outcome; },
      summary: async (now) => thread(id).summary(now),
      thread: async (now) => thread(id).thread(now),
      applyLikes: async (events, now) => { const db = thread(id); db.applyLikes(events, now); flush(db); },
      applyReposts: async (events, now) => { const db = thread(id); db.applyReposts(events, now); flush(db); },
    }),
    cell: () => ({
      apply: async (partition, events, now) => { const db = cell(partition); db.setPartition(partition); db.apply(events, now); },
      query: async (partition, query) => cell(partition).query(query),
      hasRef: async (partition, query) => cell(partition).hasRef(query),
    }),
    user: async (userId) => ({
      like: async (input) => { const db = user(userId); const result = db.like(input); flush(db); return result; },
      repost: async (input) => { const db = user(userId); const result = db.repost(input); flush(db); return result; },
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
        const failed = await consumeEvents(queue.splice(0), services, now);
        if (failed.length > 0) throw new Error(`${failed.length} events failed`);
      }
    },
    setPartitionMap(map) {
      partitionMap = map;
    },
  };
}
