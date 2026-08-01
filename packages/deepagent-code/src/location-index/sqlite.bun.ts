import { Database } from "bun:sqlite"
import type { Connection, Value } from "./sqlite"

export function open(filename: string): Connection {
  const database = new Database(filename, { create: true, readwrite: true, strict: true })
  database.run("PRAGMA journal_mode = WAL")
  database.run("PRAGMA foreign_keys = ON")
  database.run("PRAGMA busy_timeout = 5000")
  return {
    exec: (sql) => database.exec(sql),
    run: (sql, parameters = []) => {
      database.query(sql).run(...parameters)
    },
    get: <A>(sql: string, parameters: readonly Value[] = []) => database.query(sql).get(...parameters) as A | undefined,
    all: <A>(sql: string, parameters: readonly Value[] = []) => database.query(sql).all(...parameters) as A[],
    transaction: <A>(use: () => A) => database.transaction(use)(),
    close: () => database.close(),
  }
}
