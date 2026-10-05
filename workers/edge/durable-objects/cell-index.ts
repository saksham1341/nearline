import { DurableObject } from "cloudflare:workers";
import { minuteOf } from "../../../packages/feed/partition.ts";
import { MERGE_QUIET_MINUTES } from "../../../packages/shared/constants.ts";
import type { Env } from "../env.ts";
import type { CellEvent } from "../events.ts";
import type { CellIndexApi } from "../services.ts";
import { CellIndexDb, type HasRefQuery, type RefPage, type RefQuery } from "../stores/cell-index-db.ts";
import { durableSql } from "../stores/sql.ts";
import { maintainPartition, markDrained } from "./partition-maintenance.ts";

const ALARM_INTERVAL_MS = 60_000;

/** References for one partition cell. A once-a-minute alarm sweeps expired rows while there is anything to sweep. */
export class CellIndex extends DurableObject<Env> implements CellIndexApi {
  private readonly db: CellIndexDb;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new CellIndexDb(durableSql(ctx.storage.sql));
    this.db.init();
  }

  async apply(partition: string, events: CellEvent[], now: number): Promise<void> {
    this.db.setPartition(partition);
    this.db.apply(events, now);
    await this.ensureAlarm();
  }

  async query(partition: string, query: RefQuery): Promise<RefPage> {
    this.db.setPartition(partition);
    const page = this.db.query(query);
    await this.ensureAlarm();
    return page;
  }

  async hasRef(_partition: string, query: HasRefQuery): Promise<boolean> {
    return this.db.hasRef(query);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.db.sweep(now);
    try {
      await maintainPartition(this.db, this.env.PARTITION_MAP, now);
      await markDrained(this.db, this.env.PARTITION_MAP, now);
    } catch (error) {
      // Partition tuning is best-effort; sweeping must keep running.
      console.warn("Partition maintenance failed", error);
    }
    const recentLoad = this.db.loadSamples().some((sample) => sample.minute >= minuteOf(now) - MERGE_QUIET_MINUTES);
    if (!this.db.isEmpty() || recentLoad) await this.ctx.storage.setAlarm(now + ALARM_INTERVAL_MS);
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }
}
