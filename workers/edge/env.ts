export interface Env {
  DB: D1Database;
  GEO_SHARD: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** Per-user socket creation, across all shards. */
  CONNECT_LIMITER: RateLimit;
  /** Per-user message sends, across all shards; each shard also keeps a smoothing bucket. */
  MESSAGE_LIMITER: RateLimit;
  /** Per-IP passkey registration, since new accounts have no identity to key on yet. */
  REGISTER_LIMITER: RateLimit;
  RP_NAME: string;
  RP_ID: string;
  ORIGIN: string;
}

export interface AuthenticatedUser {
  id: string;
  authorHash: string;
}
