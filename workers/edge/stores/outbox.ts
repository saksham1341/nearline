import type { FeedEvent } from "../events.ts";
import type { SqlRunner } from "./sql.ts";

export const OUTBOX_SCHEMA = `CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL
)`;

/**
 * Events written in the same synchronous block as the state change they describe, and deleted only
 * after the queue accepted them. A failed send therefore delays an event; it never loses one.
 */
export class Outbox {
  constructor(private readonly sql: SqlRunner) {}

  add(events: readonly FeedEvent[]): void {
    for (const event of events) {
      this.sql.exec("INSERT INTO outbox (event_id, body) VALUES (?, ?) ON CONFLICT DO NOTHING", event.eventId, JSON.stringify(event));
    }
  }

  pending(limit: number): FeedEvent[] {
    return this.sql.exec<{ body: string }>("SELECT body FROM outbox ORDER BY seq LIMIT ?", limit).toArray()
      .map((row) => JSON.parse(row.body) as FeedEvent);
  }

  ack(eventIds: readonly string[]): void {
    for (const eventId of eventIds) this.sql.exec("DELETE FROM outbox WHERE event_id = ?", eventId);
  }

  size(): number {
    return Number(this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox").toArray()[0]?.n ?? 0);
  }
}
