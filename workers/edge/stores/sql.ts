export type SqlValue = string | number | null;

/**
 * The slice of Durable Object SQLite the stores use. Tests implement it over node:sqlite,
 * so every query is exercised against a real SQLite engine.
 */
export interface SqlRunner {
  exec<T extends object = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): { toArray(): T[] };
}

export function durableSql(sql: SqlStorage): SqlRunner {
  return {
    exec<T extends object>(query: string, ...bindings: SqlValue[]) {
      return sql.exec(query, ...bindings) as unknown as { toArray(): T[] };
    },
  };
}

/** One statement per call: node:sqlite prepares a single statement at a time. */
export function runAll(sql: SqlRunner, statements: readonly string[]): void {
  for (const statement of statements) sql.exec(statement);
}
