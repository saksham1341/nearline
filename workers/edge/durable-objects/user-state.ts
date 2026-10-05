import { DurableObject } from "cloudflare:workers";
import type { EngagementResponse } from "../../../packages/protocol/index.ts";
import type { Env } from "../env.ts";
import type { UserStateApi } from "../services.ts";
import { durableSql } from "../stores/sql.ts";
import { UserStateDb, type LikeInput, type RepostInput } from "../stores/user-state-db.ts";
import { flushOutbox, OUTBOX_RETRY_MS } from "./flush.ts";

const SWEEP_INTERVAL_MS = 60 * 60_000;

/** One of 65,536 buckets of per-user likes and reposts. Their events leave through an outbox. */
export class UserState extends DurableObject<Env> implements UserStateApi {
  private readonly db: UserStateDb;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new UserStateDb(durableSql(ctx.storage.sql));
    this.db.init();
  }

  async like(input: LikeInput): Promise<{ changed: boolean; first: boolean; threadId: string }> {
    const result = this.db.like(input);
    await this.settle();
    return result;
  }

  async repost(input: RepostInput): Promise<{ ok: boolean; first: boolean }> {
    const result = this.db.repost(input);
    await this.settle();
    return result;
  }

  async engagement(userId: string, threadIds: string[]): Promise<EngagementResponse> {
    return this.db.engagement(userId, threadIds);
  }

  async alarm(): Promise<void> {
    this.db.sweep(Date.now());
    await this.settle();
  }

  private async settle(): Promise<void> {
    const sent = await flushOutbox(this.db, this.env.FEED_EVENTS);
    if (!sent) {
      await this.ctx.storage.setAlarm(Date.now() + OUTBOX_RETRY_MS);
      return;
    }
    if (this.db.isEmpty()) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > Date.now() + SWEEP_INTERVAL_MS) await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }
}
