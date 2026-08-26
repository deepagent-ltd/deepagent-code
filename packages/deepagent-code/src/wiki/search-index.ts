import { Effect } from "effect"
import type { Doc, DocType } from "@deepagent-code/core/deepagent/document-store"
import { WikiGraph } from "./wiki-service"
// Runtime-split SQLite handle (bun:sqlite under bun, node:sqlite under node). NEVER import a
// `bun:`/`node:` sqlite module directly here — that would pull a runtime-specific builtin into the
// wrong module graph (the desktop server runs under Node/Electron). See wiki-fts-db.ts.
import { openWikiFtsDb } from "#wiki-fts-db"
import type { WikiFtsDb } from "./wiki-fts-db"

/**
 * V3.9 §B.4 — WikiSearchIndex: embedded full-text search over the Wiki projection.
 *
 * "图是唯一真相" (§B.4): the graph is the single source of truth. This index is a rebuildable
 * PROJECTION built FROM the DocumentStore file tree — it holds NO authoritative data. If it is
 * corrupted or deleted it is rebuilt from the graph with zero data loss. It therefore lives in a
 * DEDICATED small sqlite file, NOT the main application DB, so a corrupt/rebuilt wiki index can never
 * risk the primary database (see the storage-decision note in the module footer).
 *
 * Index content (§B.4): Wiki page title (description) + body + tags, PLUS code_symbol symbol names
 * (so a code-symbol search surfaces the function/class). sealed docs are NEVER indexed (INV-7) — the
 * WikiGraph.allDocs() feed already excludes them, and rebuild() re-confirms.
 *
 * Storage: SQLite FTS5 (built into both bun:sqlite and node:sqlite — no external search engine, §B.4;
 * the driver is runtime-selected via #wiki-fts-db). One FTS5 virtual table
 * `wiki_fts(doc_id UNINDEXED, type UNINDEXED, scope UNINDEXED, title, body, tags)`. `doc_id`, `type`,
 * `scope` are UNINDEXED columns so exact scope/type filtering is a cheap WHERE, while the text columns
 * feed the MATCH.
 */

export type WikiSearchHit = {
  readonly docId: string
  readonly type: DocType
  readonly scope: string
  readonly title: string
  readonly score: number // -bm25 (higher = more relevant), normalized so callers sort desc
}

export type WikiSearchQuery = {
  readonly text: string
  readonly scope?: string
  readonly type?: DocType
  readonly limit?: number
}

const DEFAULT_LIMIT = 50

// FTS5 treats many characters as syntax (", *, :, -, AND/OR/NOT, parens). To search arbitrary user
// text safely we tokenize into bare words and OR-quote each as a phrase, so "foo-bar (x)" becomes
// `"foo" OR "bar" OR "x"`. Empty query → no match (returns nothing) rather than an FTS syntax error.
const toMatchExpr = (text: string): string | null => {
  const terms = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 1)
  if (terms.length === 0) return null
  // escape embedded double-quotes (none survive the split above, but be defensive) then phrase-quote.
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ")
}

// The searchable text a code_symbol contributes: its symbol path (e.g. "Foo.bar") + host file path.
const codeSymbolTokens = (doc: Doc): string => {
  const ext = doc.extensions ?? {}
  const symbolPath = typeof ext.symbol_path === "string" ? ext.symbol_path : ""
  const hostPath = typeof ext.host_path === "string" ? ext.host_path : doc.description
  return `${symbolPath} ${hostPath}`.trim()
}

const bodyText = (doc: Doc): string => (doc.type === "code_symbol" ? codeSymbolTokens(doc) : doc.body)

export class WikiSearchIndex {
  private readonly db: WikiFtsDb

  // `dbPath` is the dedicated wiki index file; `graph` is the projection source for rebuild(). The
  // caller wires both (production: openWikiSearchIndex; tests: an in-memory or tmp path + stub graph).
  // The SQLite handle is opened via the runtime-split factory (bun:sqlite / node:sqlite) — WAL and
  // the dir are handled inside openWikiFtsDb.
  constructor(
    dbPath: string,
    private readonly graph: WikiGraph,
  ) {
    this.db = openWikiFtsDb(dbPath)
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
         doc_id UNINDEXED, type UNINDEXED, scope UNINDEXED, title, body, tags,
         tokenize = 'unicode61'
       );`,
    )
  }

  // §B.4 rebuild: idempotent full rebuild from the graph. Clears then re-inserts every live,
  // non-sealed doc. Idempotent — running twice yields the same index (asserted in tests). Never fails
  // (a per-doc insert error is swallowed so one bad row can't abort the whole rebuild).
  rebuild(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      const docs = this.graph.allDocs()
      const insert = this.db.prepare(
        "INSERT INTO wiki_fts (doc_id, type, scope, title, body, tags) VALUES (?, ?, ?, ?, ?, ?)",
      )
      // Wrap the clear+reinsert in an explicit transaction (BEGIN/COMMIT via exec — portable across
      // bun:sqlite and node:sqlite, neither of which shares the other's transaction helper). On any
      // failure roll back so a partial rebuild never leaves the index half-populated.
      this.db.exec("BEGIN;")
      try {
        this.db.exec("DELETE FROM wiki_fts;")
        for (const doc of docs) {
          if (doc.scope === "sealed") continue // defense-in-depth: never index sealed (INV-7)
          try {
            insert.run(doc.id, doc.type, doc.scope, doc.description, bodyText(doc), doc.tags.join(" "))
          } catch {
            /* skip a single un-insertable row; the graph remains the source of truth */
          }
        }
        this.db.exec("COMMIT;")
      } catch {
        try {
          this.db.exec("ROLLBACK;")
        } catch {
          /* already rolled back / no active tx */
        }
      }
    })
  }

  // §B.4 search: full-text MATCH with optional scope/type filter. Ranked by bm25 (FTS5), best first.
  // Never fails: a malformed/empty query or a corrupt index yields [] rather than throwing.
  search(query: WikiSearchQuery): Effect.Effect<readonly WikiSearchHit[], never> {
    return Effect.sync(() => {
      const match = toMatchExpr(query.text)
      if (match === null) return []
      const clauses = ["wiki_fts MATCH ?"]
      const params: unknown[] = [match]
      if (query.scope !== undefined) {
        clauses.push("scope = ?")
        params.push(query.scope)
      }
      if (query.type !== undefined) {
        clauses.push("type = ?")
        params.push(query.type)
      }
      params.push(query.limit ?? DEFAULT_LIMIT)
      try {
        const rows = this.db
          .prepare(
            `SELECT doc_id AS docId, type, scope, title, bm25(wiki_fts) AS rank
               FROM wiki_fts
              WHERE ${clauses.join(" AND ")}
              ORDER BY rank ASC
              LIMIT ?`,
          )
          .all<{ docId: string; type: DocType; scope: string; title: string; rank: number }>(...params)
        // bm25 returns a negative number where MORE negative = more relevant; flip so higher = better.
        return rows.map((r) => ({ docId: r.docId, type: r.type, scope: r.scope, title: r.title, score: -r.rank }))
      } catch {
        return [] // corrupt index / bad match expr → empty, never throw (caller rebuilds)
      }
    })
  }

  close(): void {
    this.db.close()
  }
}
