export const LOCATION_RESOLUTION = 11 as const;

export const PROXIMITY_SCOPES = {
  wide: 9,
  nearby: 10,
  close: 11,
} as const;

export type ProximityScope = (typeof PROXIMITY_SCOPES)[keyof typeof PROXIMITY_SCOPES];

export const MAX_MESSAGE_CHARS = 1_000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const CHALLENGE_TTL_MS = 5 * 60 * 1_000;

export const VALID_SCOPES = new Set<number>(Object.values(PROXIMITY_SCOPES));

export function isProximityScope(value: unknown): value is ProximityScope {
  return typeof value === "number" && VALID_SCOPES.has(value);
}

// ---- Local feed (docs/superpowers/specs/2026-10-05-local-feed-design.md) ----
export const THREAD_TTL_MS = 15 * 60_000;
export const MAX_POSTS_PER_THREAD = 500;
export const FEED_PAGE_SIZE = 30;
export const PARTITION_QUERY_LIMIT = 60;
export const MAX_ENGAGEMENT_IDS = 60;

export const TREND_HALF_LIFE_MS = 5 * 60_000;
export const TREND_MIN_PARTICIPANTS = 2;
/** Relative weights adapted from X's open-sourced Heavy Ranker, normalized to like = 1. */
export const ENGAGEMENT_WEIGHTS = { like: 1, repost: 2, reply: 27, author_reply: 150 } as const;
export type EngagementKind = keyof typeof ENGAGEMENT_WEIGHTS;

export const FEED_CACHE_SECONDS = 3;
export const THREAD_CACHE_SECONDS = 2;
/** Idempotency rows and tombstones outlive any late queue retry. */
export const EVENT_RETENTION_MS = 20 * 60_000;
/** Threads can stay alive past 20 minutes, so per-user likes must outlive them. */
export const USER_STATE_RETENTION_MS = 24 * 60 * 60_000;

export const PARTITION_BASE_RESOLUTION = 7;
export const PARTITION_MAX_RESOLUTION = 9;
export const PARTITION_DUAL_READ_MS = 16 * 60_000;
/** A retired partition is read until it reports drained; this caps how long that can take. */
export const PARTITION_RETIRED_MAX_MS = 24 * 60 * 60_000;
export const PARTITION_MAP_CACHE_MS = 30_000;
export const SPLIT_WRITES_PER_MINUTE = 600;
export const SPLIT_READS_PER_MINUTE = 30_000;
export const SPLIT_SUSTAINED_MINUTES = 5;
export const MERGE_QUIET_MINUTES = 30;

export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
export const MAX_VISIBLE_REPLY_DEPTH = 4;

export const POLL_FEED_MS = 5_000;
export const POLL_THREAD_MS = 3_000;
export const POLL_MAX_MS = 30_000;
export const POLL_BACKOFF_AFTER_MS = 60_000;
