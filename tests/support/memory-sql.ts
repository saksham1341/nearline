import { DatabaseSync } from "node:sqlite";
import type { SqlRunner, SqlValue } from "../../workers/edge/stores/sql.ts";

/** A SqlRunner over an in-memory node:sqlite database, matching Durable Object SQLite semantics. */
export function memorySql(): SqlRunner {
  const db = new DatabaseSync(":memory:");
  return {
    exec<T extends object>(query: string, ...bindings: SqlValue[]) {
      const statement = db.prepare(query);
      const returnsRows = /^\s*(select|with)\b/iu.test(query) || /\breturning\b/iu.test(query);
      if (returnsRows) {
        const rows = statement.all(...bindings) as T[];
        return { toArray: () => rows };
      }
      statement.run(...bindings);
      return { toArray: () => [] as T[] };
    },
  };
}
