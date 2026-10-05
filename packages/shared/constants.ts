export const LOCATION_RESOLUTION = 11 as const;

export const PROXIMITY_SCOPES = {
  wide: 9,
  nearby: 10,
  close: 11,
} as const;

export type ProximityScope = (typeof PROXIMITY_SCOPES)[keyof typeof PROXIMITY_SCOPES];

export const SHARD_RESOLUTION = 5 as const;
export const MAX_MESSAGE_CHARS = 1_000;
export const MAX_MESSAGES_PER_SECOND_PER_USER = 2;
export const BURST_MESSAGES_PER_USER = 5;
export const MAX_TRANSCRIPT_MESSAGES = 2_000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const CHALLENGE_TTL_MS = 5 * 60 * 1_000;

export const VALID_SCOPES = new Set<number>(Object.values(PROXIMITY_SCOPES));

export function isProximityScope(value: unknown): value is ProximityScope {
  return typeof value === "number" && VALID_SCOPES.has(value);
}
