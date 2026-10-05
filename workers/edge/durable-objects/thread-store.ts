import { DurableObject } from "cloudflare:workers";
import type { DeletionOutcome } from "../../../packages/feed/tree.ts";
import type { PostView, ThreadSummary } from "../../../packages/protocol/index.ts";
import type { Env } from "../env.ts";
import type { ThreadLikedEvent, ThreadRepostedEvent } from "../events.ts";
import type { ThreadStoreApi } from "../services.ts";
import type { Outcome } from "../stores/outcome.ts";
import { durableSql } from "../stores/sql.ts";
import { ThreadDb, type CreateThreadInput, type RemoveInput, type ReplyInput } from "../stores/thread-db.ts";
import { flushOutbox, OUTBOX_RETRY_MS } from "./flush.ts";

/**
 * One thread per object. Every change and the events describing it are written together; the
 * events are then sent from the outbox, retried by alarm if the queue is unavailable. When the
 * thread is gone and its last events are sent, the object deletes all of its storage.
 */
export class ThreadStore extends DurableObject<Env> implements ThreadStoreApi {
  private db: ThreadDb;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // No schema here: an id that is only ever looked up must not leave storage behind.
    this.db = new ThreadDb(durableSql(ctx.storage.sql));
  }

  async create(input: CreateThreadInput): Promise<Outcome<{ summary: ThreadSummary }>> {
    const result = this.db.create(input);
    await this.settle();
    return result.outcome;
  }

  async reply(input: ReplyInput): Promise<Outcome<{ post: PostView; summary: ThreadSummary }>> {
    const result = this.db.reply(input);
    await this.settle();
    return result.outcome;
  }

  async remove(input: RemoveInput): Promise<Outcome<{ outcome: DeletionOutcome }>> {
    const result = this.db.remove(input);
    await this.settle();
    return result.outcome;
  }

  async summary(now: number): Promise<Outcome<{ summary: ThreadSummary }>> {
    return this.db.summary(now);
  }

  async thread(now: number): Promise<Outcome<{ summary: ThreadSummary; posts: PostView[] }>> {
    return this.db.thread(now);
  }

  async applyLikes(events: ThreadLikedEvent[], now: number): Promise<void> {
    this.db.applyLikes(events, now);
    await this.settle();
  }

  async applyReposts(events: ThreadRepostedEvent[], now: number): Promise<void> {
    this.db.applyReposts(events, now);
    await this.settle();
  }

  async alarm(): Promise<void> {
    this.db.expireIfDue(Date.now());
    await this.settle();
  }

  /** Sends pending events, then deletes the object if it is finished, or sets the next alarm. */
  private async settle(): Promise<void> {
    const sent = await flushOutbox(this.db, this.env.FEED_EVENTS);
    if (sent && this.db.isGone()) {
      await this.ctx.storage.deleteAll();
      this.db = new ThreadDb(durableSql(this.ctx.storage.sql));
      return;
    }
    const next = sent ? this.db.expiresAt() : Date.now() + OUTBOX_RETRY_MS;
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}
