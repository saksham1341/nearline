import type { FeedEvent } from "./events.ts";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  THREAD_STORE: DurableObjectNamespace;
  CELL_INDEX: DurableObjectNamespace;
  USER_STATE: DurableObjectNamespace;
  FEED_EVENTS: Queue<FeedEvent>;
  PARTITION_MAP: KVNamespace;
  MESSAGE_LIMITER: RateLimit;
  LIKE_LIMITER: RateLimit;
  READ_LIMITER: RateLimit;
  REGISTER_LIMITER: RateLimit;
  RP_NAME: string;
  RP_ID: string;
  ORIGIN: string;
  SESSION_KEY: string;
  /** Account Analytics: Read token and the account it covers; without them the capacity check is off. */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}
