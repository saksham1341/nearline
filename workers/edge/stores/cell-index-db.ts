import { decodeCursor, type RefRecord } from "../../../packages/feed/order.ts";
import { minuteOf, type LoadSample } from "../../../packages/feed/partition.ts";
import { trendKey } from "../../../packages/feed/score.ts";
import { refCells } from "../../../packages/geo/index.ts";
import type { FeedTab } from "../../../packages/protocol/index.ts";
import { EVENT_RETENTION_MS, TREND_MIN_PARTICIPANTS, type ProximityScope } from "../../../packages/shared/constants.ts";
import type { CellEvent } from "../events.ts";
import { runAll, type SqlRunner, type SqlValue } from "./sql.ts";

export interface RefQuery {
  cells: readonly string[];
  scope: ProximityScope;
  room: string;
  tab: FeedTab;
  cursor: string | null;
  limit: number;
  now: number;
}

export interface HasRefQuery {
  threadId: string;
  cells: readonly string[];
  scope: ProximityScope;
  room: string;
  now: number;
}

export interface RefPage {
  refs: RefRecord[];
  version: number;
}

interface RefRow {
  thread_id: string;
  anchor_at: number;
  anchor_kind: "root" | "repost";
  by_author: string;
  cell11: string;
  room_tag: string;
  expires_at: number;
  score: number;
  score_at: number;
  trend_key: number;
  participant_count: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS refs (
    thread_id TEXT NOT NULL,
    anchor_at INTEGER NOT NULL,
    anchor_kind TEXT NOT NULL,
    by_author TEXT NOT NULL,
    cell9 TEXT NOT NULL,
    cell10 TEXT NOT NULL,
    cell11 TEXT NOT NULL,
    room_tag TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    score REAL NOT NULL,
    score_at INTEGER NOT NULL,
    trend_key REAL NOT NULL,
    participant_count INTEGER NOT NULL,
    PRIMARY KEY (thread_id, anchor_at, by_author)
  )`,
  "CREATE INDEX IF NOT EXISTS refs_cell9 ON refs(room_tag, cell9, anchor_at)",
  "CREATE INDEX IF NOT EXISTS refs_cell10 ON refs(room_tag, cell10, anchor_at)",
  "CREATE INDEX IF NOT EXISTS refs_cell11 ON refs(room_tag, cell11, anchor_at)",
  "CREATE INDEX IF NOT EXISTS refs_expiry ON refs(expires_at)",
  "CREATE INDEX IF NOT EXISTS refs_trend ON refs(room_tag, trend_key)",
  "CREATE INDEX IF NOT EXISTS refs_thread ON refs(thread_id)",
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS applied_events (event_id TEXT PRIMARY KEY, at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS tombstones (thread_id TEXT PRIMARY KEY, at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS load (minute INTEGER PRIMARY KEY, writes INTEGER NOT NULL, reads INTEGER NOT NULL)",
];

const CELL_COLUMN: Record<ProximityScope, "cell9" | "cell10" | "cell11"> = { 9: "cell9", 10: "cell10", 11: "cell11" };

/**
 * References to threads anchored inside one partition cell. Holds ordering data only; the summary
 * a person reads always comes from the thread's own store.
 */
export class CellIndexDb {
  constructor(private readonly sql: SqlRunner) {}

  init(): void {
    runAll(this.sql, SCHEMA);
  }

  apply(events: readonly CellEvent[], now: number): void {
    let changed = false;
    for (const event of events) {
      if (!this.markApplied(event.eventId, now)) continue;
      changed = this.applyOne(event) || changed;
    }
    if (changed) this.bumpVersion();
    this.recordLoad(now, events.length, 0);
  }

  query(q: RefQuery): RefPage {
    this.recordLoad(q.now, 0, 1);
    const column = CELL_COLUMN[q.scope];
    const order = q.tab === "latest" ? "anchor_at" : "trend_key";
    const filters = ["room_tag = ?", `${column} IN (${placeholders(q.cells)})`, "expires_at > ?"];
    const bindings: SqlValue[] = [q.room, ...q.cells, q.now];
    if (q.tab === "trending") {
      filters.push("participant_count >= ?");
      bindings.push(TREND_MIN_PARTICIPANTS);
    }
    const cursor = decodeCursor(q.cursor);
    if (cursor) {
      filters.push(`(${order} < ? OR (${order} = ? AND thread_id < ?))`);
      bindings.push(cursor.key, cursor.key, cursor.threadId);
    }
    bindings.push(q.limit);
    const rows = this.sql.exec<RefRow>(
      `SELECT thread_id, anchor_at, anchor_kind, by_author, cell11, room_tag, expires_at, score, score_at, trend_key, participant_count
         FROM refs WHERE ${filters.join(" AND ")} ORDER BY ${order} DESC, thread_id DESC LIMIT ?`,
      ...bindings,
    ).toArray();
    return { refs: rows.map(toRecord), version: this.version() };
  }

  hasRef(q: HasRefQuery): boolean {
    const column = CELL_COLUMN[q.scope];
    return this.sql.exec(
      `SELECT 1 AS found FROM refs
        WHERE thread_id = ? AND room_tag = ? AND ${column} IN (${placeholders(q.cells)}) AND expires_at > ? LIMIT 1`,
      q.threadId, q.room, ...q.cells, q.now,
    ).toArray().length > 0;
  }

  sweep(now: number): void {
    this.sql.exec("DELETE FROM refs WHERE expires_at <= ?", now);
    this.sql.exec("DELETE FROM applied_events WHERE at < ?", now - EVENT_RETENTION_MS);
    this.sql.exec("DELETE FROM tombstones WHERE at < ?", now - EVENT_RETENTION_MS);
    this.sql.exec("DELETE FROM load WHERE minute < ?", minuteOf(now) - 60);
  }

  isEmpty(): boolean {
    const refs = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM refs").toArray()[0]?.n ?? 0;
    const tombstones = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tombstones").toArray()[0]?.n ?? 0;
    return Number(refs) + Number(tombstones) === 0;
  }

  loadSamples(): LoadSample[] {
    return this.sql.exec<LoadSample>("SELECT minute, writes, reads FROM load ORDER BY minute").toArray()
      .map((row) => ({ minute: Number(row.minute), writes: Number(row.writes), reads: Number(row.reads) }));
  }

  version(): number {
    return Number(this.meta("version") ?? 0);
  }

  partition(): string | null {
    return this.meta("partition");
  }

  setPartition(partition: string): void {
    this.sql.exec("INSERT INTO meta (key, value) VALUES ('partition', ?) ON CONFLICT DO NOTHING", partition);
  }

  private applyOne(event: CellEvent): boolean {
    switch (event.type) {
      case "ref.added": {
        const ref = event.ref;
        if (this.isTombstoned(ref.threadId)) return false;
        const cells = refCells(ref.location);
        this.sql.exec(
          `INSERT INTO refs (thread_id, anchor_at, anchor_kind, by_author, cell9, cell10, cell11, room_tag,
             expires_at, score, score_at, trend_key, participant_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          ref.threadId, ref.anchorAt, ref.kind, ref.byAuthor, cells.cell9, cells.cell10, cells.cell11, ref.roomTag,
          ref.expiresAt, ref.score, ref.scoreAt, trendKey({ value: ref.score, at: ref.scoreAt }), ref.participantCount,
        );
        return true;
      }
      case "thread.updated": {
        if (this.isTombstoned(event.threadId)) return false;
        this.sql.exec(
          "UPDATE refs SET expires_at = MAX(expires_at, ?), participant_count = MAX(participant_count, ?) WHERE thread_id = ?",
          event.expiresAt, event.participantCount, event.threadId,
        );
        // An older snapshot delivered late must not overwrite a newer one.
        this.sql.exec(
          "UPDATE refs SET score = ?, score_at = ?, trend_key = ? WHERE thread_id = ? AND score_at <= ?",
          event.score, event.scoreAt, trendKey({ value: event.score, at: event.scoreAt }), event.threadId, event.scoreAt,
        );
        return true;
      }
      case "thread.expired": {
        this.sql.exec("DELETE FROM refs WHERE thread_id = ?", event.threadId);
        this.sql.exec(
          "INSERT INTO tombstones (thread_id, at) VALUES (?, ?) ON CONFLICT DO UPDATE SET at = excluded.at",
          event.threadId, event.at,
        );
        return true;
      }
    }
  }

  private isTombstoned(threadId: string): boolean {
    return this.sql.exec("SELECT 1 AS found FROM tombstones WHERE thread_id = ?", threadId).toArray().length > 0;
  }

  private markApplied(eventId: string, now: number): boolean {
    return this.sql.exec(
      "INSERT INTO applied_events (event_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING event_id",
      eventId, now,
    ).toArray().length > 0;
  }

  private bumpVersion(): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('version', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
    );
  }

  private recordLoad(now: number, writes: number, reads: number): void {
    this.sql.exec(
      `INSERT INTO load (minute, writes, reads) VALUES (?, ?, ?)
       ON CONFLICT(minute) DO UPDATE SET writes = writes + excluded.writes, reads = reads + excluded.reads`,
      minuteOf(now), writes, reads,
    );
  }

  private meta(key: string): string | null {
    return this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
  }
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function toRecord(row: RefRow): RefRecord {
  return {
    threadId: row.thread_id,
    anchorAt: Number(row.anchor_at),
    kind: row.anchor_kind,
    byAuthor: row.by_author,
    cell11: row.cell11,
    roomTag: row.room_tag,
    expiresAt: Number(row.expires_at),
    score: Number(row.score),
    scoreAt: Number(row.score_at),
    trendKey: Number(row.trend_key),
    participantCount: Number(row.participant_count),
  };
}
