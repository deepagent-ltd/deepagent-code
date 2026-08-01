import { RepoDocument } from "@deepagent-code/core/document-intelligence/repo-document"
import { Hash } from "@deepagent-code/core/util/hash"
import { Schema } from "effect"
import { open } from "#location-index-sqlite"
import type { Connection, Value } from "../location-index/sqlite"

const SchemaVersion = 1

export class IncompatibleIndexError extends Error {}
export class CommitConflictError extends Error {}
export class CorruptIndexError extends Error {}

type Header = {
  index_space_id: string
  index_incarnation: number
  state: "cold" | "indexing" | "ready" | "degraded" | "unavailable"
  current_slot: "a" | "b"
  current_generation: number
  commit_fencing_token: number
  indexed_at: number | null
  schema_version: number
  adapter_set_version: string
}

type Manifest = {
  slot: "a" | "b"
  generation: number
  manifest_hash: string
  index_incarnation: number
  fencing_token: number
}

type Row = {
  document_id: string
  path: string
  content_sha: string
  heading_path: string
  anchor: string
  start_line: number
  end_line: number
  searchable_text: string
  rank: number
}

export function make(input: {
  readonly filename: string
  readonly indexSpaceId: string
  readonly indexIncarnation: number
  readonly adapterSetVersion: string
}): RepoDocument.Store {
  const database = open(input.filename)
  initialize(database)
  const existing = header(database)
  if (!existing) {
    database.run(
      `INSERT INTO repo_document_index_space (
        singleton, index_space_id, index_incarnation, state, current_slot, current_generation,
        commit_fencing_token, schema_version, adapter_set_version
      ) VALUES (1, ?, ?, 'cold', 'a', 0, 0, ?, ?)`,
      [input.indexSpaceId, input.indexIncarnation, SchemaVersion, input.adapterSetVersion],
    )
  } else if (
    existing.index_space_id !== input.indexSpaceId ||
    existing.index_incarnation !== input.indexIncarnation ||
    existing.schema_version !== SchemaVersion ||
    existing.adapter_set_version !== input.adapterSetVersion
  ) {
    database.close()
    throw new IncompatibleIndexError("Repo Document index header does not match the coordination record")
  }

  const fullCommit: RepoDocument.Store["fullCommit"] = (commit) =>
    database.transaction(() => {
      const current = requireCommit(database, commit)
      const slot = current.current_slot === "a" ? "b" : "a"
      const generation = current.current_generation + 1
      clearSlot(database, slot)
      insertDocuments(database, slot, generation, commit.documents)
      publish(database, input.adapterSetVersion, slot, generation, commit)
      return requireSnapshot(database)
    })

  const incrementalCommit: RepoDocument.Store["incrementalCommit"] = (commit) =>
    database.transaction(() => {
      const current = requireCommit(database, commit)
      const generation = current.current_generation + 1
      ;[...new Set([...commit.deletedPaths, ...commit.documents.map((document) => document.path)])].forEach(
        (filePath) => deletePath(database, current.current_slot, filePath),
      )
      insertDocuments(database, current.current_slot, generation, commit.documents)
      publish(database, input.adapterSetVersion, current.current_slot, generation, commit)
      return requireSnapshot(database)
    })

  const search: RepoDocument.Store["search"] = (query) =>
    database.transaction(() => {
      const current = requireHeader(database)
      const revision = snapshotOf(database)
      if (!revision || !query.query.trim() || query.limit <= 0) return { revision, hits: [] }
      const terms = query.query.toLowerCase().match(/[\p{L}\p{N}_$.-]{2,}/gu) ?? []
      if (terms.length === 0) return { revision, hits: [] }
      const match = terms.slice(0, 12).map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ")
      return {
        revision,
        hits: database
          .all<Row>(
            `SELECT d.*, bm25(repo_document_fts) AS rank FROM repo_document_fts
             JOIN repo_document d ON d.snapshot_slot = repo_document_fts.snapshot_slot
               AND d.document_id = repo_document_fts.document_id
             WHERE repo_document_fts MATCH ? AND d.snapshot_slot = ?
             ORDER BY CASE WHEN d.path = ? OR d.anchor = ? THEN 0 ELSE 1 END,
               rank, d.path, d.start_line LIMIT ?`,
            [match, current.current_slot, query.query, query.query, Math.min(query.limit, 100)],
          )
          .map((row) => ({ document: entry(row), score: 1 / (1 + Math.max(0, row.rank)) })),
      }
    })

  const lookup: RepoDocument.Store["lookup"] = (query) =>
    database.transaction(() => {
      const current = requireHeader(database)
      const revision = snapshotOf(database)
      const documentIds = [...new Set(query.documentIds)].slice(0, Math.min(query.limit, 100))
      if (!revision || documentIds.length === 0 || query.limit <= 0) return { revision, hits: [] }
      return {
        revision,
        hits: database
          .all<Row>(
            `SELECT d.*, 0 AS rank FROM repo_document d
             WHERE d.snapshot_slot = ? AND d.document_id IN (${documentIds.map(() => "?").join(",")})
             ORDER BY d.path, d.start_line LIMIT ?`,
            [current.current_slot, ...documentIds, Math.min(query.limit, 100)],
          )
          .map((row) => ({ document: entry(row), score: 1 })),
      }
    })

  return { snapshot: () => snapshotOf(database), fullCommit, incrementalCommit, search, lookup, close: () => database.close() }
}

function initialize(database: Connection) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS repo_document_index_space (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      index_space_id TEXT NOT NULL,
      index_incarnation INTEGER NOT NULL CHECK (index_incarnation > 0),
      state TEXT NOT NULL CHECK (state IN ('cold', 'indexing', 'ready', 'degraded', 'unavailable')),
      current_slot TEXT NOT NULL CHECK (current_slot IN ('a', 'b')),
      current_generation INTEGER NOT NULL CHECK (current_generation >= 0),
      commit_fencing_token INTEGER NOT NULL CHECK (commit_fencing_token >= 0),
      indexed_at INTEGER,
      schema_version INTEGER NOT NULL,
      adapter_set_version TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS repo_document_generation_manifest (
      slot TEXT NOT NULL CHECK (slot IN ('a', 'b')),
      generation INTEGER NOT NULL,
      manifest_hash TEXT NOT NULL,
      index_incarnation INTEGER NOT NULL,
      fencing_token INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      adapter_set_version TEXT NOT NULL,
      indexed_at INTEGER NOT NULL,
      PRIMARY KEY (slot, generation)
    );
    CREATE TABLE IF NOT EXISTS repo_document (
      snapshot_slot TEXT NOT NULL CHECK (snapshot_slot IN ('a', 'b')),
      document_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content_sha TEXT NOT NULL,
      heading_path TEXT NOT NULL,
      anchor TEXT NOT NULL,
      start_line INTEGER NOT NULL CHECK (start_line > 0),
      end_line INTEGER NOT NULL CHECK (end_line >= start_line),
      searchable_text TEXT NOT NULL,
      last_changed_generation INTEGER NOT NULL,
      PRIMARY KEY (snapshot_slot, document_id),
      UNIQUE (snapshot_slot, path, anchor)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS repo_document_fts USING fts5(
      snapshot_slot UNINDEXED, document_id UNINDEXED, path, heading, searchable_text,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `)
}

function insertDocuments(
  database: Connection,
  slot: "a" | "b",
  generation: number,
  documents: readonly RepoDocument.Entry[],
) {
  const decode = Schema.decodeUnknownSync(RepoDocument.Entry, { onExcessProperty: "error" })
  documents.map((value) => decode(value)).forEach((document) => {
    validatePath(document.path)
    database.run(`INSERT INTO repo_document VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      slot,
      document.documentId,
      document.path,
      document.contentSha,
      document.headingPath,
      document.anchor,
      document.startLine,
      document.endLine,
      document.searchableText,
      generation,
    ])
    database.run(`INSERT INTO repo_document_fts VALUES (?, ?, ?, ?, ?)`, [
      slot,
      document.documentId,
      document.path,
      document.headingPath,
      document.searchableText,
    ])
  })
}

function publish(
  database: Connection,
  adapterSetVersion: string,
  slot: "a" | "b",
  generation: number,
  commit: RepoDocument.Commit,
) {
  const manifestHash = Hash.sha256(
    JSON.stringify(
      database.all<Record<string, Value>>(
        `SELECT document_id, path, content_sha, heading_path, anchor, start_line, end_line
         FROM repo_document WHERE snapshot_slot = ? ORDER BY path, anchor`,
        [slot],
      ),
    ),
  )
  database.run(`INSERT INTO repo_document_generation_manifest VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
    slot,
    generation,
    manifestHash,
    commit.indexIncarnation,
    commit.fencingToken,
    SchemaVersion,
    adapterSetVersion,
    commit.indexedAt,
  ])
  database.run(
    `UPDATE repo_document_index_space SET state = 'ready', current_slot = ?, current_generation = ?,
      commit_fencing_token = ?, indexed_at = ? WHERE singleton = 1`,
    [slot, generation, commit.fencingToken, commit.indexedAt],
  )
}

function clearSlot(database: Connection, slot: "a" | "b") {
  database.run(`DELETE FROM repo_document_fts WHERE snapshot_slot = ?`, [slot])
  database.run(`DELETE FROM repo_document WHERE snapshot_slot = ?`, [slot])
  database.run(`DELETE FROM repo_document_generation_manifest WHERE slot = ?`, [slot])
}

function deletePath(database: Connection, slot: "a" | "b", filePath: string) {
  validatePath(filePath)
  database.run(`DELETE FROM repo_document_fts WHERE snapshot_slot = ? AND path = ?`, [slot, filePath])
  database.run(`DELETE FROM repo_document WHERE snapshot_slot = ? AND path = ?`, [slot, filePath])
}

function requireCommit(database: Connection, commit: RepoDocument.Commit) {
  const current = requireHeader(database)
  if (
    current.index_incarnation !== commit.indexIncarnation ||
    current.current_generation !== commit.expectedGeneration ||
    commit.fencingToken < current.commit_fencing_token
  ) {
    throw new CommitConflictError("Stale Repo Document index writer")
  }
  return current
}

function header(database: Connection) {
  return database.get<Header>(`SELECT * FROM repo_document_index_space WHERE singleton = 1`)
}

function requireHeader(database: Connection) {
  const value = header(database)
  if (!value) throw new CorruptIndexError("Missing Repo Document index header")
  return value
}

function snapshotOf(database: Connection) {
  const current = requireHeader(database)
  if (current.current_generation === 0) return
  const manifest = database.get<Manifest>(
    `SELECT * FROM repo_document_generation_manifest WHERE slot = ? AND generation = ?`,
    [current.current_slot, current.current_generation],
  )
  if (!manifest || manifest.index_incarnation !== current.index_incarnation || manifest.fencing_token !== current.commit_fencing_token) {
    throw new CorruptIndexError("Repo Document manifest does not match its header")
  }
  return {
    projectionKind: "repo_documents" as const,
    indexIncarnation: current.index_incarnation,
    generation: current.current_generation,
    manifestHash: manifest.manifest_hash,
    schemaVersion: current.schema_version,
    adapterSetVersion: current.adapter_set_version,
  }
}

function requireSnapshot(database: Connection) {
  const value = snapshotOf(database)
  if (!value) throw new CorruptIndexError("Repo Document commit did not publish a snapshot")
  return value
}

function entry(row: Row): RepoDocument.Entry {
  return {
    documentId: row.document_id,
    path: row.path,
    contentSha: row.content_sha,
    headingPath: row.heading_path,
    anchor: row.anchor,
    startLine: row.start_line,
    endLine: row.end_line,
    searchableText: row.searchable_text,
  }
}

function validatePath(filePath: string) {
  if (!filePath || filePath.startsWith("/") || filePath.includes("\\") || filePath.split("/").includes("..")) {
    throw new CorruptIndexError("Repo Document paths must be normalized Location-relative paths")
  }
}
