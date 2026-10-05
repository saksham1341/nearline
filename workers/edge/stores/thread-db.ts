import { addEngagement, replyEngagement } from "../../../packages/feed/score.ts";
import { deletionOutcome, type DeletionOutcome } from "../../../packages/feed/tree.ts";
import type { ErrorCode, PostView, ThreadSummary } from "../../../packages/protocol/index.ts";
import {
  EVENT_RETENTION_MS,
  MAX_POSTS_PER_THREAD,
  THREAD_TTL_MS,
  type EngagementKind,
} from "../../../packages/shared/constants.ts";
import { uuidv7 } from "../../../packages/shared/uuid.ts";
import type { CellEvent, FeedEvent, ThreadLikedEvent, ThreadRepostedEvent } from "../events.ts";
import { Outbox, OUTBOX_SCHEMA } from "./outbox.ts";
import { fail, type Outcome } from "./outcome.ts";
import { runAll, type SqlRunner } from "./sql.ts";

export interface Actor {
  userId: string;
  author: string;
}

export interface Result<T> {
  outcome: Outcome<T>;
  events: CellEvent[];
}

export interface CreateThreadInput {
  id: string;
  actor: Actor;
  roomTag: string;
  location: string;
  partition: string;
  body: string;
  now: number;
}

export interface ReplyInput {
  postId: string;
  parentId: string;
  actor: Actor;
  body: string;
  now: number;
}

export interface RemoveInput {
  postId: string;
  actor: Actor;
  now: number;
}

interface AnchorInput {
  anchorAt: number;
  kind: "root" | "repost";
  byAuthor: string;
  location: string;
}

interface ThreadRow {
  id: string;
  room_tag: string;
  author: string;
  author_user_id: string;
  root_location: string;
  created_at: number;
  last_activity_at: number;
  expires_at: number;
  score: number;
  score_at: number;
  reply_count: number;
  repost_count: number;
  participant_count: number;
  version: number;
}

interface PostRow {
  id: string;
  parent_id: string | null;
  author: string;
  author_user_id: string;
  body: string;
  created_at: number;
  deleted: number;
  like_count: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS thread (
    id TEXT PRIMARY KEY,
    room_tag TEXT NOT NULL,
    author TEXT NOT NULL,
    author_user_id TEXT NOT NULL,
    root_location TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    score REAL NOT NULL,
    score_at INTEGER NOT NULL,
    reply_count INTEGER NOT NULL,
    repost_count INTEGER NOT NULL,
    participant_count INTEGER NOT NULL,
    version INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    author TEXT NOT NULL,
    author_user_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    like_count INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE TABLE IF NOT EXISTS participants (user_id TEXT PRIMARY KEY)",
  "CREATE TABLE IF NOT EXISTS repliers (user_id TEXT PRIMARY KEY)",
  "CREATE TABLE IF NOT EXISTS reply_engagements (user_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (user_id, kind))",
  "CREATE TABLE IF NOT EXISTS ref_partitions (partition TEXT PRIMARY KEY)",
  "CREATE TABLE IF NOT EXISTS applied_events (event_id TEXT PRIMARY KEY, at INTEGER NOT NULL)",
  OUTBOX_SCHEMA,
];

/** Cleared on expiry; the outbox is kept until the expiry events have been sent. */
const TABLES = ["thread", "posts", "participants", "repliers", "reply_engagements", "ref_partitions", "applied_events"];

/**
 * One thread: the single source of truth for its posts, counts, score and expiry.
 * Every change that other components care about comes back as cell events for the queue.
 */
export class ThreadDb {
  private readonly outbox: Outbox;
  private schemaReady = false;

  constructor(private readonly sql: SqlRunner) {
    this.outbox = new Outbox(sql);
  }

  /** Creates the tables. Only `create` calls it, so looking up an unknown thread stores nothing. */
  init(): void {
    runAll(this.sql, SCHEMA);
    this.schemaReady = true;
  }

  create(input: CreateThreadInput): Result<{ summary: ThreadSummary }> {
    this.init();
    const { id, actor, roomTag, location, partition, body, now } = input;
    if (this.row()) return { outcome: fail("BAD_REQUEST"), events: [] };
    this.sql.exec(
      `INSERT INTO thread (id, room_tag, author, author_user_id, root_location, created_at, last_activity_at, expires_at,
         score, score_at, reply_count, repost_count, participant_count, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 1, 1)`,
      id, roomTag, actor.author, actor.userId, location, now, now, now + THREAD_TTL_MS, now,
    );
    this.sql.exec(
      "INSERT INTO posts (id, parent_id, author, author_user_id, body, created_at) VALUES (?, NULL, ?, ?, ?, ?)",
      id, actor.author, actor.userId, body, now,
    );
    this.sql.exec("INSERT INTO participants (user_id) VALUES (?)", actor.userId);
    const summary = this.requireSummary();
    const root: AnchorInput = { anchorAt: now, kind: "root", byAuthor: actor.author, location };
    return { outcome: { ok: true, summary }, events: this.emit([this.refAdded(partition, root, summary)]) };
  }

  reply(input: ReplyInput): Result<{ post: PostView; summary: ThreadSummary }> {
    if (!this.hasSchema()) return { outcome: fail("THREAD_NOT_FOUND"), events: [] };
    const live = this.live(input.now);
    if (!live.ok) return { outcome: live, events: [] };
    if (!this.post(input.parentId)) return { outcome: fail("PARENT_NOT_FOUND"), events: [] };
    if (this.count("SELECT COUNT(*) AS n FROM posts") >= MAX_POSTS_PER_THREAD) {
      return { outcome: fail("THREAD_FULL"), events: [] };
    }
    const { actor, now } = input;
    const isAuthor = actor.userId === live.row.author_user_id;
    const othersHaveReplied = this.count("SELECT COUNT(*) AS n FROM repliers") > 0;
    this.sql.exec(
      "INSERT INTO posts (id, parent_id, author, author_user_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      input.postId, input.parentId, actor.author, actor.userId, input.body, now,
    );
    this.sql.exec("UPDATE thread SET reply_count = reply_count + 1");
    if (!isAuthor) this.sql.exec("INSERT INTO repliers (user_id) VALUES (?) ON CONFLICT DO NOTHING", actor.userId);
    const kind = replyEngagement(isAuthor, othersHaveReplied);
    const firstOfKind = kind !== null && this.sql.exec(
      "INSERT INTO reply_engagements (user_id, kind) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING kind",
      actor.userId, kind,
    ).toArray().length > 0;
    this.engage(actor.userId, firstOfKind ? kind : null, now);
    this.touch(now);
    this.bump();
    const summary = this.requireSummary();
    const post = this.postView(this.post(input.postId)!, summary.id);
    return { outcome: { ok: true, post, summary }, events: this.emit(this.updatedEvents(summary)) };
  }

  remove(input: RemoveInput): Result<{ outcome: DeletionOutcome }> {
    if (!this.hasSchema()) return { outcome: fail("THREAD_NOT_FOUND"), events: [] };
    const row = this.row();
    if (!row) return { outcome: fail("THREAD_NOT_FOUND"), events: [] };
    if (row.expires_at <= input.now) return { outcome: fail("THREAD_EXPIRED"), events: [] };
    const target = this.post(input.postId);
    if (!target || target.deleted === 1) return { outcome: fail("POST_NOT_FOUND"), events: [] };
    if (target.author_user_id !== input.actor.userId) return { outcome: fail("NOT_AUTHOR"), events: [] };
    const posts = this.sql.exec<{ id: string; parentId: string | null }>("SELECT id, parent_id AS parentId FROM posts").toArray();
    const outcome = deletionOutcome(posts, input.postId)!;
    if (outcome === "remove_thread") {
      const events = this.emit(this.expiredEvents(input.now));
      this.clear();
      return { outcome: { ok: true, outcome }, events };
    }
    if (outcome === "remove") {
      this.sql.exec("DELETE FROM posts WHERE id = ?", input.postId);
      this.sql.exec("UPDATE thread SET reply_count = reply_count - 1");
    } else {
      this.sql.exec("UPDATE posts SET body = '', deleted = 1, like_count = 0 WHERE id = ?", input.postId);
    }
    this.bump();
    return { outcome: { ok: true, outcome }, events: this.emit(this.updatedEvents(this.requireSummary())) };
  }

  applyLikes(events: readonly ThreadLikedEvent[], now: number): CellEvent[] {
    if (!this.hasSchema()) return [];
    const row = this.row();
    if (!row || row.expires_at <= now) return [];
    let changed = false;
    let lastActivity: number | null = null;
    for (const event of events) {
      if (!this.markApplied(event.eventId, now)) continue;
      const target = this.post(event.postId);
      if (!target || target.deleted === 1) continue;
      // Stored raw so an unlike delivered before its like still sums correctly; clamped when displayed.
      this.sql.exec("UPDATE posts SET like_count = like_count + ? WHERE id = ?", event.delta, event.postId);
      changed = true;
      if (event.delta > 0) {
        this.engage(event.userId, event.first ? "like" : null, event.at);
        lastActivity = Math.max(lastActivity ?? 0, event.at);
      }
    }
    if (!changed) return [];
    if (lastActivity !== null) this.touch(lastActivity);
    this.bump();
    return this.emit(this.updatedEvents(this.requireSummary()));
  }

  applyReposts(events: readonly ThreadRepostedEvent[], now: number): CellEvent[] {
    if (!this.hasSchema()) return [];
    const row = this.row();
    if (!row || row.expires_at <= now) return [];
    const anchors: { partition: string; anchor: AnchorInput }[] = [];
    for (const event of events) {
      if (!this.markApplied(event.eventId, now)) continue;
      this.sql.exec("UPDATE thread SET repost_count = repost_count + 1");
      this.engage(event.userId, event.first ? "repost" : null, event.at);
      this.touch(event.at);
      anchors.push({
        partition: event.partition,
        anchor: { anchorAt: event.at, kind: "repost", byAuthor: event.byAuthor, location: event.location },
      });
    }
    if (anchors.length === 0) return [];
    this.bump();
    const summary = this.requireSummary();
    const added = anchors.map(({ partition, anchor }) => this.refAdded(partition, anchor, summary));
    return this.emit([...added, ...this.updatedEvents(summary)]);
  }

  summary(now: number): Outcome<{ summary: ThreadSummary }> {
    if (!this.hasSchema()) return fail("THREAD_NOT_FOUND");
    const live = this.live(now);
    return live.ok ? { ok: true, summary: this.summaryOf(live.row) } : live;
  }

  thread(now: number): Outcome<{ summary: ThreadSummary; posts: PostView[] }> {
    if (!this.hasSchema()) return fail("THREAD_NOT_FOUND");
    const live = this.live(now);
    if (!live.ok) return live;
    const rows = this.sql.exec<PostRow>("SELECT * FROM posts ORDER BY created_at, id").toArray();
    return { ok: true, summary: this.summaryOf(live.row), posts: rows.map((row) => this.postView(row, live.row.id)) };
  }

  expiresAt(): number | null {
    if (!this.hasSchema()) return null;
    return this.row()?.expires_at ?? null;
  }

  /** Returns the expiry events and empties the store when the thread is due; null otherwise. */
  expireIfDue(now: number): CellEvent[] | null {
    if (!this.hasSchema()) return null;
    const row = this.row();
    if (!row || row.expires_at > now) return null;
    const events = this.emit(this.expiredEvents(now));
    this.clear();
    return events;
  }

  /** Events not yet accepted by the queue, oldest first. */
  pendingEvents(limit: number): FeedEvent[] {
    return this.hasSchema() ? this.outbox.pending(limit) : [];
  }

  ackEvents(eventIds: readonly string[]): void {
    if (this.hasSchema()) this.outbox.ack(eventIds);
  }

  /** True once the thread was removed or expired and every event about it has been sent. */
  isGone(): boolean {
    return this.hasSchema() && this.row() === null && this.outbox.size() === 0;
  }

  private hasSchema(): boolean {
    if (!this.schemaReady) {
      this.schemaReady = this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread'").toArray().length > 0;
    }
    return this.schemaReady;
  }

  private emit(events: CellEvent[]): CellEvent[] {
    this.outbox.add(events);
    return events;
  }

  private live(now: number): { ok: true; row: ThreadRow } | { ok: false; code: ErrorCode } {
    const row = this.row();
    if (!row) return fail("THREAD_NOT_FOUND");
    if (row.expires_at <= now) return fail("THREAD_EXPIRED");
    return { ok: true, row };
  }

  private row(): ThreadRow | null {
    return this.sql.exec<ThreadRow>("SELECT * FROM thread LIMIT 1").toArray()[0] ?? null;
  }

  private requireSummary(): ThreadSummary {
    return this.summaryOf(this.row()!);
  }

  private post(id: string): PostRow | null {
    return this.sql.exec<PostRow>("SELECT * FROM posts WHERE id = ?", id).toArray()[0] ?? null;
  }

  private count(query: string): number {
    return Number(this.sql.exec<{ n: number }>(query).toArray()[0]?.n ?? 0);
  }

  private engage(userId: string, kind: EngagementKind | null, at: number): void {
    const joined = this.sql.exec(
      "INSERT INTO participants (user_id) VALUES (?) ON CONFLICT DO NOTHING RETURNING user_id",
      userId,
    ).toArray().length > 0;
    if (joined) this.sql.exec("UPDATE thread SET participant_count = participant_count + 1");
    if (kind === null) return;
    const row = this.row()!;
    // Late events never move the score's clock backwards.
    const next = addEngagement({ value: row.score, at: row.score_at }, kind, Math.max(at, row.score_at));
    this.sql.exec("UPDATE thread SET score = ?, score_at = ?", next.value, next.at);
  }

  private touch(at: number): void {
    this.sql.exec(
      "UPDATE thread SET last_activity_at = MAX(last_activity_at, ?), expires_at = MAX(expires_at, ?)",
      at, at + THREAD_TTL_MS,
    );
  }

  private bump(): void {
    this.sql.exec("UPDATE thread SET version = version + 1");
  }

  private markApplied(eventId: string, now: number): boolean {
    this.sql.exec("DELETE FROM applied_events WHERE at < ?", now - EVENT_RETENTION_MS);
    return this.sql.exec(
      "INSERT INTO applied_events (event_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING event_id",
      eventId, now,
    ).toArray().length > 0;
  }

  private partitions(): string[] {
    return this.sql.exec<{ partition: string }>("SELECT partition FROM ref_partitions").toArray().map((row) => row.partition);
  }

  private refAdded(partition: string, anchor: AnchorInput, summary: ThreadSummary): CellEvent {
    this.sql.exec("INSERT INTO ref_partitions (partition) VALUES (?) ON CONFLICT DO NOTHING", partition);
    return {
      eventId: uuidv7(),
      type: "ref.added",
      partition,
      ref: {
        threadId: summary.id,
        ...anchor,
        roomTag: summary.roomTag,
        expiresAt: summary.expiresAt,
        score: summary.score,
        scoreAt: summary.scoreAt,
        participantCount: summary.participantCount,
      },
    };
  }

  private updatedEvents(summary: ThreadSummary): CellEvent[] {
    return this.partitions().map((partition): CellEvent => ({
      eventId: uuidv7(),
      type: "thread.updated",
      partition,
      threadId: summary.id,
      expiresAt: summary.expiresAt,
      score: summary.score,
      scoreAt: summary.scoreAt,
      participantCount: summary.participantCount,
    }));
  }

  private expiredEvents(now: number): CellEvent[] {
    const threadId = this.row()!.id;
    return this.partitions().map((partition): CellEvent => ({
      eventId: uuidv7(),
      type: "thread.expired",
      partition,
      threadId,
      at: now,
    }));
  }

  private clear(): void {
    for (const table of TABLES) this.sql.exec(`DELETE FROM ${table}`);
  }

  private summaryOf(row: ThreadRow): ThreadSummary {
    const root = this.postView(this.post(row.id)!, row.id);
    return {
      id: row.id,
      roomTag: row.room_tag,
      root,
      replyCount: row.reply_count,
      likeCount: root.likeCount,
      repostCount: row.repost_count,
      participantCount: row.participant_count,
      score: row.score,
      scoreAt: row.score_at,
      lastActivityAt: row.last_activity_at,
      expiresAt: row.expires_at,
      version: row.version,
    };
  }

  private postView(row: PostRow, threadId: string): PostView {
    return {
      id: row.id,
      threadId,
      parentId: row.parent_id,
      author: row.author,
      body: row.deleted === 1 ? "" : row.body,
      createdAt: row.created_at,
      deleted: row.deleted === 1,
      likeCount: Math.max(0, row.like_count),
    };
  }
}
