import type { EngagementResponse } from "../../../packages/protocol/index.ts";
import { USER_STATE_RETENTION_MS } from "../../../packages/shared/constants.ts";
import { bytesToHex, sha256 } from "../../../packages/shared/encoding.ts";
import { uuidv7 } from "../../../packages/shared/uuid.ts";
import type { FeedEvent } from "../events.ts";
import { Outbox, OUTBOX_SCHEMA } from "./outbox.ts";
import { runAll, type SqlRunner } from "./sql.ts";

export interface LikeInput {
  userId: string;
  postId: string;
  threadId: string;
  on: boolean;
  now: number;
}

export interface RepostInput {
  userId: string;
  threadId: string;
  now: number;
  /** The reposter's resolution-11 cell: the new anchor. */
  location: string;
  partition: string;
  byAuthor: string;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS likes (
    user_id TEXT NOT NULL, post_id TEXT NOT NULL, thread_id TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (user_id, post_id)
  )`,
  "CREATE INDEX IF NOT EXISTS likes_thread ON likes(user_id, thread_id)",
  `CREATE TABLE IF NOT EXISTS reposts (
    user_id TEXT NOT NULL, thread_id TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (user_id, thread_id)
  )`,
  `CREATE TABLE IF NOT EXISTS engaged (
    user_id TEXT NOT NULL, thread_id TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (user_id, thread_id, kind)
  )`,
  OUTBOX_SCHEMA,
];

/** "Did I like this" lives with the user, so a viral thread never answers per-viewer questions. */
export class UserStateDb {
  private readonly outbox: Outbox;

  constructor(private readonly sql: SqlRunner) {
    this.outbox = new Outbox(sql);
  }

  init(): void {
    runAll(this.sql, SCHEMA);
  }

  /**
   * `threadId` in the result is the thread the like is recorded under, never the one the client named
   * on an unlike: otherwise liking under one thread and unliking under another would leave a +1 that
   * is never taken back.
   */
  like(input: LikeInput): { changed: boolean; first: boolean; threadId: string } {
    if (!input.on) {
      const removed = this.sql.exec<{ thread_id: string }>(
        "DELETE FROM likes WHERE user_id = ? AND post_id = ? RETURNING thread_id",
        input.userId, input.postId,
      ).toArray()[0];
      if (!removed) return { changed: false, first: false, threadId: input.threadId };
      this.queueLike(input, removed.thread_id, -1, false);
      return { changed: true, first: false, threadId: removed.thread_id };
    }
    const inserted = this.sql.exec(
      "INSERT INTO likes (user_id, post_id, thread_id, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING post_id",
      input.userId, input.postId, input.threadId, input.now,
    ).toArray().length > 0;
    if (!inserted) return { changed: false, first: false, threadId: input.threadId };
    const first = this.firstEngagement(input.userId, input.threadId, "like", input.now);
    this.queueLike(input, input.threadId, 1, first);
    return { changed: true, first, threadId: input.threadId };
  }

  repost(input: RepostInput): { ok: boolean; first: boolean } {
    const inserted = this.sql.exec(
      "INSERT INTO reposts (user_id, thread_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING thread_id",
      input.userId, input.threadId, input.now,
    ).toArray().length > 0;
    if (!inserted) return { ok: false, first: false };
    const first = this.firstEngagement(input.userId, input.threadId, "repost", input.now);
    this.outbox.add([{
      eventId: uuidv7(input.now), type: "thread.reposted", threadId: input.threadId, userId: input.userId, first,
      location: input.location, partition: input.partition, byAuthor: input.byAuthor, at: input.now,
    }]);
    return { ok: true, first };
  }

  pendingEvents(limit: number): FeedEvent[] {
    return this.outbox.pending(limit);
  }

  ackEvents(eventIds: readonly string[]): void {
    this.outbox.ack(eventIds);
  }

  private queueLike(input: LikeInput, threadId: string, delta: 1 | -1, first: boolean): void {
    this.outbox.add([{
      eventId: uuidv7(input.now), type: "thread.liked", threadId, postId: input.postId,
      userId: input.userId, delta, first, at: input.now,
    }]);
  }

  engagement(userId: string, threadIds: readonly string[]): EngagementResponse {
    if (threadIds.length === 0) return { liked: [], reposted: [] };
    const list = threadIds.map(() => "?").join(", ");
    const liked = this.sql.exec<{ post_id: string }>(
      `SELECT post_id FROM likes WHERE user_id = ? AND thread_id IN (${list}) ORDER BY post_id`,
      userId, ...threadIds,
    ).toArray().map((row) => row.post_id);
    const reposted = this.sql.exec<{ thread_id: string }>(
      `SELECT thread_id FROM reposts WHERE user_id = ? AND thread_id IN (${list}) ORDER BY thread_id`,
      userId, ...threadIds,
    ).toArray().map((row) => row.thread_id);
    return { liked, reposted };
  }

  sweep(now: number): void {
    const cutoff = now - USER_STATE_RETENTION_MS;
    this.sql.exec("DELETE FROM likes WHERE at < ?", cutoff);
    this.sql.exec("DELETE FROM reposts WHERE at < ?", cutoff);
    this.sql.exec("DELETE FROM engaged WHERE at < ?", cutoff);
  }

  isEmpty(): boolean {
    const rows = this.sql.exec<{ n: number }>(
      "SELECT (SELECT COUNT(*) FROM likes) + (SELECT COUNT(*) FROM reposts) + (SELECT COUNT(*) FROM engaged) + (SELECT COUNT(*) FROM outbox) AS n",
    ).toArray()[0];
    return Number(rows?.n ?? 0) === 0;
  }

  private firstEngagement(userId: string, threadId: string, kind: "like" | "repost", now: number): boolean {
    return this.sql.exec(
      "INSERT INTO engaged (user_id, thread_id, kind, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING kind",
      userId, threadId, kind, now,
    ).toArray().length > 0;
  }
}

/** 65,536 buckets: enough to spread any load, few enough to stay cheap. */
export async function userStateName(userId: string): Promise<string> {
  return `u:${bytesToHex(await sha256(userId)).slice(0, 4)}`;
}
