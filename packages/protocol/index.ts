import { isCanonicalLocation, isScopeCell, locationToScopeCell } from "../geo/index.ts";
import { isProximityScope, MAX_MESSAGE_CHARS, type ProximityScope } from "../shared/constants.ts";

export const ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN_ORIGIN",
  "INVALID_LOCATION",
  "INVALID_SCOPE",
  "INVALID_ROOM_TAG",
  "INVALID_MESSAGE",
  "RATE_LIMITED",
  "THREAD_NOT_FOUND",
  "THREAD_EXPIRED",
  "NOT_VISIBLE",
  "PARENT_NOT_FOUND",
  "POST_NOT_FOUND",
  "THREAD_FULL",
  "ALREADY_REPOSTED",
  "NOT_AUTHOR",
  "UNAVAILABLE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/** The public line uses the empty tag; private filters use a SHA-256 hex digest. */
export function isRoomTag(value: unknown): value is string {
  return value === "" || (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
}

export interface PostView {
  id: string;
  threadId: string;
  parentId: string | null;
  author: string;
  body: string;
  createdAt: number;
  deleted: boolean;
  likeCount: number;
  /** 15 minutes after the last activity in this post's subtree; the branch fades then. */
  expiresAt: number;
}

export type FeedTab = "latest" | "trending";

export interface Anchor {
  cell11: string;
  kind: "root" | "repost";
  byAuthor: string;
  createdAt: number;
}

export interface ThreadSummary {
  id: string;
  roomTag: string;
  root: PostView;
  replyCount: number;
  likeCount: number;
  repostCount: number;
  participantCount: number;
  score: number;
  scoreAt: number;
  lastActivityAt: number;
  expiresAt: number;
  version: number;
}

export interface FeedItem {
  summary: ThreadSummary;
  via: Anchor;
}

export interface FeedResponse {
  version: string;
  serverTime: number;
  items: FeedItem[];
  nextCursor: string | null;
}

export interface ThreadResponse {
  version: number;
  serverTime: number;
  summary: ThreadSummary;
  posts: PostView[];
}

export interface EngagementResponse {
  liked: string[];
  reposted: string[];
}

interface ViewerFields {
  cell: string;
  scope: ProximityScope;
  room: string;
}

export type ActionRequest =
  | ({ id: string; type: "post"; location: string; body: string } & ViewerFields)
  | ({ id: string; type: "reply"; threadId: string; parentId: string; body: string } & ViewerFields)
  | ({ id: string; type: "like"; threadId: string; postId: string; on: boolean } & ViewerFields)
  | ({ id: string; type: "repost"; threadId: string; location: string } & ViewerFields)
  | { id: string; type: "delete"; threadId: string; postId: string };

export type ActionOutcome = { ok: true; postId?: string } | { ok: false; code: ErrorCode };
export type ActionResponse = { id: string } & ActionOutcome;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isValidPostBody(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= MAX_MESSAGE_CHARS;
}

/**
 * Shape and type validation for POST /api/actions. Body length is checked separately so the
 * caller can answer INVALID_MESSAGE instead of BAD_REQUEST.
 */
export function parseActionRequest(value: unknown): ActionRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!isUuid(input.id)) return null;
  const id = input.id;

  if (input.type === "delete") {
    return isUuid(input.threadId) && isUuid(input.postId)
      ? { id, type: "delete", threadId: input.threadId, postId: input.postId }
      : null;
  }

  const viewer = parseViewer(input);
  if (!viewer) return null;

  switch (input.type) {
    case "post":
      if (!isCanonicalLocation(input.location) || typeof input.body !== "string") return null;
      if (locationToScopeCell(input.location, viewer.scope) !== viewer.cell) return null;
      return { id, type: "post", ...viewer, location: input.location, body: input.body };
    case "reply":
      if (!isUuid(input.threadId) || !isUuid(input.parentId) || typeof input.body !== "string") return null;
      return { id, type: "reply", ...viewer, threadId: input.threadId, parentId: input.parentId, body: input.body };
    case "like":
      if (!isUuid(input.threadId) || !isUuid(input.postId) || typeof input.on !== "boolean") return null;
      return { id, type: "like", ...viewer, threadId: input.threadId, postId: input.postId, on: input.on };
    case "repost":
      if (!isUuid(input.threadId) || !isCanonicalLocation(input.location)) return null;
      if (locationToScopeCell(input.location, viewer.scope) !== viewer.cell) return null;
      return { id, type: "repost", ...viewer, threadId: input.threadId, location: input.location };
    default:
      return null;
  }
}

function parseViewer(input: Record<string, unknown>): ViewerFields | null {
  if (!isProximityScope(input.scope) || !isScopeCell(input.cell, input.scope) || !isRoomTag(input.room)) return null;
  return { cell: input.cell, scope: input.scope, room: input.room };
}
