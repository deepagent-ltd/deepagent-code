/**
 * V3.9 §B.4 — a minimal SQLite handle abstraction for the Wiki FTS index, split by runtime.
 *
 * WHY THIS EXISTS: the desktop server runs under Node/Electron (the electron main process loads the
 * server from `dist/node`, resolved with the `node` import condition), while tests + the CLI run under
 * Bun. `bun:sqlite` does NOT exist in Node — statically importing it crashes the Node/Electron ESM
 * loader at module-eval ("Only URLs with a scheme in: file, data, node, and electron … Received
 * protocol 'bun:'"). So the concrete driver MUST be selected per runtime, exactly like the core
 * `#sqlite` / `#db` splits. This module is the SHARED interface; `wiki-fts-db.bun.ts` (bun:sqlite) and
 * `wiki-fts-db.node.ts` (node:sqlite) are the implementations, wired via the `#wiki-fts-db` package.json
 * imports condition. search-index.ts imports the factory from `#wiki-fts-db`, never a `bun:`/`node:`
 * module directly, so no runtime-specific sqlite ever enters the wrong module graph.
 *
 * The interface is intentionally tiny — only what the FTS index needs (DDL + parameterized
 * insert/select). Both drivers support FTS5 + bm25; the only real API delta they hide is bun's
 * `db.run`/`db.transaction` vs node's `db.exec`.
 */

/** A prepared statement: bound + executed with positional params (spread). */
export interface WikiFtsStatement {
  /** Execute a non-SELECT (INSERT/DELETE). */
  run(...params: unknown[]): void
  /** Execute a SELECT and return all rows as plain objects. */
  all<T = Record<string, unknown>>(...params: unknown[]): T[]
}

/** A minimal SQLite handle over the dedicated wiki FTS file. */
export interface WikiFtsDb {
  /** Run raw SQL with no params (DDL, DELETE-all, transaction control). */
  exec(sql: string): void
  /** Prepare a parameterized statement. */
  prepare(sql: string): WikiFtsStatement
  /** Close the underlying handle. */
  close(): void
}

/**
 * Open a WikiFtsDb at `dbPath` (or `":memory:"`). WAL is enabled for on-disk files. Resolved to the
 * runtime-specific implementation via the `#wiki-fts-db` imports condition.
 */
export type OpenWikiFtsDb = (dbPath: string) => WikiFtsDb
