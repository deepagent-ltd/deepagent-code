import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import path from "node:path"
import type { OpenWikiFtsDb, WikiFtsDb, WikiFtsStatement } from "./wiki-fts-db"

/**
 * V3.9 §B.4 — the Bun implementation of the Wiki FTS SQLite handle (bun:sqlite). Selected under the
 * `bun` import condition (tests + CLI). See `wiki-fts-db.ts` for why this is runtime-split.
 */
export const openWikiFtsDb: OpenWikiFtsDb = (dbPath: string): WikiFtsDb => {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath, { create: true })
  db.run("PRAGMA journal_mode = WAL;")
  return {
    exec(sql: string): void {
      db.run(sql)
    },
    prepare(sql: string): WikiFtsStatement {
      const stmt = db.query(sql)
      return {
        run(...params: unknown[]): void {
          stmt.run(...(params as never[]))
        },
        all<T = Record<string, unknown>>(...params: unknown[]): T[] {
          return (stmt.all(...(params as never[])) ?? []) as T[]
        },
      }
    },
    close(): void {
      db.close()
    },
  }
}
