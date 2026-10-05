import { DurableObject } from "cloudflare:workers";
import {
  candidateShardsForMessage,
  isCanonicalLocation,
  locationToShard,
  messageReach,
  reachIncludes,
} from "../../../packages/geo/index.ts";
import {
  isClientFrame,
  isRoomTag,
  sameRoom,
  type ChatMessage,
  type ConnectionAttachment,
  type ErrorCode,
  type ServerFrame,
} from "../../../packages/protocol/index.ts";
import {
  BURST_MESSAGES_PER_USER,
  isProximityScope,
  MAX_MESSAGE_CHARS,
  MAX_MESSAGES_PER_SECOND_PER_USER,
} from "../../../packages/shared/constants.ts";
import { uuidv7 } from "../../../packages/shared/uuid.ts";
import type { Env } from "../env.ts";

const RATE_LIMIT_PRUNE_EVERY = 200;
const RATE_LIMIT_IDLE_MS = 60_000;

export class GeoShardLive extends DurableObject<Env> {
  private rateLimitWrites = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        user_id TEXT PRIMARY KEY,
        tokens REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/connect") return this.handleConnect(request);
    if (url.pathname === "/internal/deliver" && request.method === "POST") {
      const message = await request.json<ChatMessage>();
      if (!validForwardedMessage(message)) return new Response("Bad message", { status: 400 });
      this.deliverLocal(message);
      return new Response(null, { status: 204 });
    }
    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(socket: WebSocket, incoming: string | ArrayBuffer): Promise<void> {
    if (typeof incoming !== "string") return this.protocolError(socket, "BAD_REQUEST");
    let parsed: unknown;
    try {
      parsed = JSON.parse(incoming);
    } catch {
      return this.protocolError(socket, "BAD_REQUEST");
    }
    if (!isClientFrame(parsed)) return this.protocolError(socket, "BAD_REQUEST");
    const frame = parsed;

    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
    if (!validAttachment(attachment)) {
      this.sendError(socket, "UNAUTHORIZED");
      socket.close(1008, "Invalid session");
      return;
    }

    if (frame.type === "position") {
      if (!isCanonicalLocation(frame.location)) return this.sendError(socket, "INVALID_LOCATION");
      if (locationToShard(frame.location) !== locationToShard(attachment.location)) {
        return this.sendError(socket, "SHARD_CHANGED");
      }
      attachment.location = frame.location;
      socket.serializeAttachment(attachment);
      return;
    }

    if (frame.type === "scope") {
      if (!isProximityScope(frame.scope)) return this.sendError(socket, "INVALID_SCOPE");
      attachment.scope = frame.scope;
      socket.serializeAttachment(attachment);
      return;
    }

    if (frame.type === "room") {
      if (!isRoomTag(frame.tag)) return this.sendError(socket, "INVALID_ROOM_TAG");
      attachment.roomTag = frame.tag;
      socket.serializeAttachment(attachment);
      return;
    }

    if (frame.type === "message") {
      await this.acceptMessage(socket, attachment, frame.body);
      return;
    }

    this.protocolError(socket, "BAD_REQUEST");
  }

  webSocketClose(): void {
    // The runtime releases the socket and its attachment automatically.
  }

  webSocketError(socket: WebSocket): void {
    try { socket.close(1011, "Socket error"); } catch { /* already closed */ }
  }

  private handleConnect(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const userId = request.headers.get("x-user-id");
    const author = request.headers.get("x-author");
    const location = request.headers.get("x-location");
    const scope = Number(request.headers.get("x-scope"));
    const roomTag = request.headers.get("x-room") ?? "";
    if (!userId || !author || !isCanonicalLocation(location)) return new Response("Unauthorized", { status: 401 });
    if (!isProximityScope(scope) || !isRoomTag(roomTag)) return new Response("Bad request", { status: 400 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: ConnectionAttachment = {
      version: 1,
      userId,
      author: author.slice(0, 8),
      location,
      scope,
      roomTag,
      connectedAt: Date.now(),
      malformedCount: 0,
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    this.send(server, { type: "ready", author: attachment.author, scope: attachment.scope, roomTag: attachment.roomTag });
    return new Response(null, { status: 101, webSocket: client });
  }

  private async acceptMessage(socket: WebSocket, attachment: ConnectionAttachment, body: unknown): Promise<void> {
    if (typeof body !== "string" || !body.trim() || Array.from(body).length > MAX_MESSAGE_CHARS) {
      return this.sendError(socket, "INVALID_MESSAGE");
    }
    if (!this.takeRateLimitToken(attachment.userId)) return this.sendError(socket, "RATE_LIMITED");
    // The local bucket only sees this shard; the binding caps a user across every shard they hold a socket in.
    const { success } = await this.env.MESSAGE_LIMITER.limit({ key: attachment.userId });
    if (!success) return this.sendError(socket, "RATE_LIMITED");

    const message: ChatMessage = {
      id: uuidv7(),
      ts: Date.now(),
      location: attachment.location,
      author: attachment.author,
      roomTag: attachment.roomTag,
      body,
    };
    this.deliverLocal(message);
    this.ctx.waitUntil(this.forwardMessage(message));
  }

  private deliverLocal(message: ChatMessage): void {
    const reach = messageReach(message.location);
    for (const socket of this.ctx.getWebSockets()) {
      const viewer = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (!hasAttachmentShape(viewer)) continue;
      if (sameRoom(viewer, message) && reachIncludes(reach, viewer.location, viewer.scope)) {
        this.send(socket, { type: "message", message });
      }
    }
  }

  private async forwardMessage(message: ChatMessage): Promise<void> {
    const origin = locationToShard(message.location);
    const calls = Array.from(candidateShardsForMessage(message.location))
      .filter((shard) => shard !== origin)
      .map((shard) => this.env.GEO_SHARD.getByName(shard).fetch("https://geo.internal/internal/deliver", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
      }));
    const results = await Promise.allSettled(calls);
    for (const result of results) if (result.status === "rejected") console.warn("Remote fanout failed", result.reason);
  }

  private takeRateLimitToken(userId: string): boolean {
    const now = Date.now();
    const row = this.ctx.storage.sql.exec<{ tokens: number; updated_at: number }>(
      "SELECT tokens, updated_at FROM rate_limits WHERE user_id = ?",
      userId,
    ).toArray()[0];
    const available = row
      ? Math.min(BURST_MESSAGES_PER_USER, row.tokens + ((now - row.updated_at) / 1_000) * MAX_MESSAGES_PER_SECOND_PER_USER)
      : BURST_MESSAGES_PER_USER;
    if (available < 1) {
      this.ctx.storage.sql.exec(
        `INSERT INTO rate_limits (user_id, tokens, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at`,
        userId, available, now,
      );
      return false;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO rate_limits (user_id, tokens, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at`,
      userId, available - 1, now,
    );
    this.pruneRateLimits(now);
    return true;
  }

  /** Idle buckets refill to full within seconds, so their rows carry no information. */
  private pruneRateLimits(now: number): void {
    this.rateLimitWrites += 1;
    if (this.rateLimitWrites % RATE_LIMIT_PRUNE_EVERY !== 0) return;
    this.ctx.storage.sql.exec("DELETE FROM rate_limits WHERE updated_at < ?", now - RATE_LIMIT_IDLE_MS);
  }

  private protocolError(socket: WebSocket, code: ErrorCode): void {
    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
    if (validAttachment(attachment)) {
      attachment.malformedCount += 1;
      socket.serializeAttachment(attachment);
      if (attachment.malformedCount >= 10) socket.close(1008, "Too many malformed frames");
    }
    this.sendError(socket, code);
  }

  private sendError(socket: WebSocket, code: ErrorCode): void {
    this.send(socket, { type: "error", code });
  }

  private send(socket: WebSocket, frame: ServerFrame): void {
    try { socket.send(JSON.stringify(frame)); } catch { /* connection closed during fanout */ }
  }
}

function validAttachment(value: unknown): value is ConnectionAttachment {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ConnectionAttachment>;
  return item.version === 1 && typeof item.userId === "string" && typeof item.author === "string"
    && isCanonicalLocation(item.location) && isProximityScope(item.scope) && isRoomTag(item.roomTag);
}

/**
 * Fanout runs this for every socket on every message, so it skips the H3 validity check.
 * Every write path (connect, position frame) has already validated the stored location.
 */
function hasAttachmentShape(value: unknown): value is ConnectionAttachment {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ConnectionAttachment>;
  return item.version === 1 && typeof item.location === "string" && isProximityScope(item.scope)
    && typeof item.roomTag === "string";
}

function validForwardedMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ChatMessage>;
  return typeof message.id === "string" && typeof message.ts === "number" && isCanonicalLocation(message.location)
    && typeof message.author === "string" && isRoomTag(message.roomTag) && typeof message.body === "string"
    && Array.from(message.body).length <= MAX_MESSAGE_CHARS;
}
