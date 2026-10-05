import { DurableObject } from "cloudflare:workers";
import type { EngagementResponse } from "../../../packages/protocol/index.ts";
import type { Env } from "../env.ts";
import type { UserStateApi } from "../services.ts";
import { durableSql } from "../stores/sql.ts";
import { UserStateDb, type LikeInput, type RepostInput } from "../stores/user-state-db.ts";

const SWEEP_INTERVAL_MS = 60 * 60_000;

/** One of 65,536 buckets of per-user likes and reposts. */
export class UserState extends DurableObject<Env> implements UserStateApi {
  private readonly db: UserStateDb;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new UserStateDb(durableSql(ctx.storage.sql));
    this.db.init();
  }

  async like(input: LikeInput): Promise<{ changed: boolean; first: boolean }> {
    const result = this.db.like(input);
    await this.ensureAlarm();
    return result;
  }

  async repost(input: RepostInput): Promise<{ ok: boolean; first: boolean }> {
    const result = this.db.repost(input);
    await this.ensureAlarm();
    return result;
  }

  async engagement(userId: string, threadIds: string[]): Promise<EngagementResponse> {
    return this.db.engagement(userId, threadIds);
  }

  async alarm(): Promise<void> {
    this.db.sweep(Date.now());
    if (!this.db.isEmpty()) await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }
}
