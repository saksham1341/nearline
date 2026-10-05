import type { ProximityScope } from "../shared/constants.ts";

export interface ChatMessage {
  id: string;
  ts: number;
  location: string;
  author: string;
  roomTag: string;
  body: string;
}

export interface ConnectionAttachment {
  version: 1;
  userId: string;
  author: string;
  location: string;
  scope: ProximityScope;
  roomTag: string;
  connectedAt: number;
  malformedCount: number;
}

export type ClientFrame =
  | { type: "position"; location: string }
  | { type: "scope"; scope: ProximityScope }
  | { type: "room"; tag: string }
  | { type: "message"; id?: string; body: string };

export type ServerFrame =
  | { type: "ready"; author: string; scope: ProximityScope; roomTag: string }
  | { type: "message"; message: ChatMessage }
  | { type: "error"; code: ErrorCode };

export type ErrorCode =
  | "BAD_REQUEST"
  | "INVALID_LOCATION"
  | "SHARD_CHANGED"
  | "INVALID_SCOPE"
  | "INVALID_ROOM_TAG"
  | "INVALID_MESSAGE"
  | "RATE_LIMITED"
  | "MESSAGE_REJECTED"
  | "UNAUTHORIZED";

/** The public line uses the empty tag; private filters use a SHA-256 hex digest. */
export function isRoomTag(value: unknown): value is string {
  return value === "" || (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
}

/** Shape check only; each frame's fields are validated by the branch that handles its type. */
export function isClientFrame(value: unknown): value is ClientFrame {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && typeof (value as { type?: unknown }).type === "string";
}

export function sameRoom(viewer: Pick<ConnectionAttachment, "roomTag">, message: ChatMessage): boolean {
  return viewer.roomTag === message.roomTag;
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
}
