import type { FeedEvent } from "../../workers/edge/events.ts";
import { memorySql } from "./memory-sql.ts";

/** Durable Object storage: SQL over in-memory SQLite, an alarm slot, and deleteAll. */
export function fakeStorage() {
  let db = memorySql();
  let alarm: number | null = null;
  let deletions = 0;
  return {
    get sql() { return db as never; },
    async setAlarm(at: number) { alarm = at; },
    async getAlarm() { return alarm; },
    async deleteAll() { db = memorySql(); alarm = null; deletions += 1; },
    get alarm() { return alarm; },
    get deletions() { return deletions; },
    tables(): string[] {
      return (db.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray() as { name: string }[]).map((row) => row.name);
    },
  };
}

/** A queue producer that records what it accepts, and can be told to fail. */
export function fakeQueue() {
  const sent: FeedEvent[] = [];
  let failing = false;
  return {
    sent,
    fail(value: boolean) { failing = value; },
    async sendBatch(messages: { body: FeedEvent }[]) {
      if (failing) throw new Error("queue unavailable");
      if (messages.length > 100) throw new Error("too many messages");
      sent.push(...messages.map((message) => message.body));
    },
  };
}
