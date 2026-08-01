import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import type { Connection, Value } from "./sqlite"

export function open(filename: string): Connection {
  const database = new DatabaseSync(filename, { open: true, enableForeignKeyConstraints: true, timeout: 5_000 })
  database.exec("PRAGMA journal_mode = WAL")
  return {
    exec: (sql) => database.exec(sql),
    run: (sql, parameters = []) => {
      database.prepare(sql).run(...(parameters as readonly SQLInputValue[]))
    },
    get: <A>(sql: string, parameters: readonly Value[] = []) =>
      database.prepare(sql).get(...(parameters as readonly SQLInputValue[])) as A | undefined,
    all: <A>(sql: string, parameters: readonly Value[] = []) =>
      database.prepare(sql).all(...(parameters as readonly SQLInputValue[])) as A[],
    transaction: <A>(use: () => A) => {
      database.exec("BEGIN IMMEDIATE")
      try {
        const value = use()
        database.exec("COMMIT")
        return value
      } catch (error) {
        database.exec("ROLLBACK")
        throw error
      }
    },
    close: () => database.close(),
  }
}
