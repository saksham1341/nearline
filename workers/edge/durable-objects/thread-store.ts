import { DurableObject } from "cloudflare:workers";
import type { DeletionOutcome } from "../../../packages/feed/tree.ts";
import type { PostView, ThreadSummary } from "../../../packages/protocol/index.ts";
import type { Env } from "../env.ts";
import type { CellEvent, ThreadLikedEvent, ThreadRepostedEvent } from "../events.ts";
import type { ThreadStoreApi } from "../services.ts";
import type { Outcome } from "../stores/outcome.ts";
import { durableSql } from "../stores/sql.ts";
import { ThreadDb, type CreateThreadInput, type RemoveInput, type ReplyInput, type Result } from "../stores/thread-db.ts";

/** One thread per object. Sends follow-on events to the queue and deletes itself when it expires. */
export class ThreadStore extends DurableObject<Env> implements ThreadStoreApi {
  private readonly db: ThreadDb;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new ThreadDb(durableSql(ctx.storage.sql));
    this.db.init();
  }

  async create(input: CreateThreadInput): Promise<Outcome<{ summary: ThreadSummary }>> {
    return this.finish(this.db.create(input));
  }

  async reply(input: ReplyInput): Promise<Outcome<{ post: PostView; summary: ThreadSummary }>> {
    return this.finish(this.db.reply(input));
  }

  async remove(input: RemoveInput): Promise<Outcome<{ outcome: DeletionOutcome }>> {
    const result = this.db.remove(input);
    if (result.outcome.ok && result.outcome.outcome === "remove_thread") {
      await this.send(result.events);
      await this.wipe();
      return result.outcome;
    }
    return this.finish(result);
  }

  async summary(now: number): Promise<Outcome<{ summary: ThreadSummary }>> {
    return this.db.summary(now);
  }

  async thread(now: number): Promise<Outcome<{ summary: ThreadSummary; posts: PostView[] }>> {
    return this.db.thread(now);
  }

  async applyLikes(events: ThreadLikedEvent[], now: number): Promise<void> {
    await this.send(this.db.applyLikes(events, now));
    await this.schedule();
  }

  async applyReposts(events: ThreadRepostedEvent[], now: number): Promise<void> {
    await this.send(this.db.applyReposts(events, now));
    await this.schedule();
  }

  async alarm(): Promise<void> {
    const events = this.db.expireIfDue(Date.now());
    if (events) {
      await this.send(events);
      await this.wipe();
      return;
    }
    await this.schedule();
  }

  private async finish<T>(result: Result<T>): Promise<Outcome<T>> {
    await this.send(result.events);
    await this.schedule();
    return result.outcome;
  }

  private async send(events: CellEvent[]): Promise<void> {
    if (events.length > 0) await this.env.FEED_EVENTS.sendBatch(events.map((body) => ({ body })));
  }

  private async schedule(): Promise<void> {
    const at = this.db.expiresAt();
    if (at !== null) await this.ctx.storage.setAlarm(at);
  }

  /** deleteAll drops every table, so recreate them for any late call this instance still receives. */
  private async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.db.init();
  }
}
