import type { RefRecord } from "../../packages/feed/order.ts";
import type { LocationHint } from "../../packages/feed/location-hint.ts";
import type { PartitionMap } from "../../packages/feed/partition.ts";
import type { DeletionOutcome } from "../../packages/feed/tree.ts";
import type { EngagementResponse, PostView, ThreadSummary } from "../../packages/protocol/index.ts";
import type { CellEvent, FeedEvent, ThreadLikedEvent, ThreadRepostedEvent } from "./events.ts";
import type { HasRefQuery, RefQuery } from "./stores/cell-index-db.ts";
import type { Outcome } from "./stores/outcome.ts";
import type { CreateThreadInput, RemoveInput, ReplyInput } from "./stores/thread-db.ts";
import type { LikeInput, RepostInput } from "./stores/user-state-db.ts";

/** One thread's store. In production a Durable Object stub; in tests an in-memory ThreadDb. */
export interface ThreadStoreApi {
  create(input: CreateThreadInput): Promise<Outcome<{ summary: ThreadSummary }>>;
  reply(input: ReplyInput): Promise<Outcome<{ post: PostView; summary: ThreadSummary }>>;
  remove(input: RemoveInput): Promise<Outcome<{ outcome: DeletionOutcome }>>;
  summary(now: number): Promise<Outcome<{ summary: ThreadSummary }>>;
  thread(now: number): Promise<Outcome<{ summary: ThreadSummary; posts: PostView[] }>>;
  applyLikes(events: ThreadLikedEvent[], now: number): Promise<void>;
  applyReposts(events: ThreadRepostedEvent[], now: number): Promise<void>;
}

export interface CellIndexApi {
  apply(partition: string, events: CellEvent[], now: number): Promise<void>;
  query(partition: string, query: RefQuery): Promise<{ refs: RefRecord[]; version: number }>;
  hasRef(partition: string, query: HasRefQuery): Promise<boolean>;
}

export interface UserStateApi {
  like(input: LikeInput): Promise<{ changed: boolean; first: boolean; threadId: string }>;
  repost(input: RepostInput): Promise<{ ok: boolean; first: boolean }>;
  engagement(userId: string, threadIds: string[]): Promise<EngagementResponse>;
}

export interface EdgeCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

export type LimitKind = "message" | "like" | "read";

/** Everything the HTTP handlers and the queue consumer touch, so both run against fakes in tests. */
export interface Services {
  thread(id: string, hint?: LocationHint): ThreadStoreApi;
  cell(partition: string): CellIndexApi;
  user(userId: string): Promise<UserStateApi>;
  sendEvents(events: FeedEvent[]): Promise<void>;
  partitionMap(now: number): Promise<PartitionMap>;
  limit(kind: LimitKind, key: string): Promise<boolean>;
  cache: EdgeCache;
}
