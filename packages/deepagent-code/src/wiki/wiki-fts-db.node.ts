import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { mkdirSync } from "node:fs"
import path from "node:path"
import type { OpenWikiFtsDb, WikiFtsDb, WikiFtsStatement } from "./wiki-fts-db"

/**
 * V3.9 §B.4 — the Node implementation of the Wiki FTS SQLite handle (node:sqlite `DatabaseSync`).
 * Selected under the `node` import condition — this is what the desktop server (electron main /
 * `dist/node`) uses. node:sqlite supports FTS5 + bm25; the API delta vs bun:sqlite (no `run`/`query`/
 * `transaction` on the db object, only `exec` + `prepare`) is normalized here. See `wiki-fts-db.ts`.
 */
export const openWikiFtsDb: OpenWikiFtsDb = (dbPath: string): WikiFtsDb => {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath, { open: true })
  db.exec("PRAGMA journal_mode = WAL;")
  return {
    exec(sql: string): void {
      db.exec(sql)
    },
    prepare(sql: string): WikiFtsStatement {
      const stmt = db.prepare(sql)
      return {
        run(...params: unknown[]): void {
          stmt.run(...(params as SQLInputValue[]))
        },
        all<T = Record<string, unknown>>(...params: unknown[]): T[] {
          return stmt.all(...(params as SQLInputValue[])) as T[]
        },
      }
    },
    close(): void {
      db.close()
    },
  }
}
