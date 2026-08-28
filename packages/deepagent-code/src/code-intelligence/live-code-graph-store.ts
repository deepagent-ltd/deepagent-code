import { CodeGraph } from "@deepagent-code/core/code-intelligence/code-graph"
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
  canonical_root: string
  state: "cold" | "indexing" | "ready" | "degraded" | "unavailable"
  current_slot: "a" | "b"
  current_generation: number
  commit_fencing_token: number
  indexed_at: number | null
  schema_version: number
  adapter_set_version: string
  last_error_code: string | null
  last_error_message: string | null
}

type Manifest = {
  slot: "a" | "b"
  generation: number
  manifest_hash: string
  index_incarnation: number
  fencing_token: number
  schema_version: number
  adapter_set_version: string
  indexed_at: number
}

type EntityRow = {
  entity_id: string
  entity_kind: CodeGraph.EntityKind
  stable_key: string
  display_name: string
  language: string
  file_path: string | null
  identity_stability: "durable" | "generation"
}

type FileRow = {
  entity_id: string
  path: string
  language: string
  content_sha: string
  mtime_ns: string | null
  semantic_level: CodeGraph.SemanticLevel
  searchable_text: string
}

type SymbolRow = {
  entity_id: string
  owning_entity_id: string
  symbol_path: string
  kind: string
  start_line: number
  end_line: number
  signature: string
}

type DegreeRow = {
  in_degree: number
  out_degree: number
  calls_in: number
  calls_out: number
}

type NeighborRow = EntityRow & FileRow & SymbolRow & DegreeRow & {
  from_entity_id: string
  to_entity_id: string
  relation: CodeGraph.EdgeRelation
  evidence: string
}

export function make(input: {
  readonly filename: string
  readonly indexSpaceId: string
  readonly indexIncarnation: number
  readonly canonicalRoot: string
  readonly adapterSetVersion: string
}): CodeGraph.Store {
  const database = open(input.filename)
  initialize(database)
  const existing = header(database)
  if (!existing) {
    database.run(
      `INSERT INTO code_index_space (
        singleton, index_space_id, index_incarnation, canonical_root, state, current_slot,
        current_generation, commit_fencing_token, schema_version, adapter_set_version
      ) VALUES (1, ?, ?, ?, 'cold', 'a', 0, 0, ?, ?)`,
      [input.indexSpaceId, input.indexIncarnation, input.canonicalRoot, SchemaVersion, input.adapterSetVersion],
    )
  } else if (
    existing.index_space_id !== input.indexSpaceId ||
    existing.index_incarnation !== input.indexIncarnation ||
    existing.canonical_root !== input.canonicalRoot ||
    existing.schema_version !== SchemaVersion ||
    existing.adapter_set_version !== input.adapterSetVersion
  ) {
    database.close()
    throw new IncompatibleIndexError("Code index header does not match the coordination record")
  }

  const snapshot = () => snapshotOf(database)

  const status = (dirtyPathCount = 0): CodeGraph.IndexStatus => {
    const current = requireHeader(database)
    const coverage = Object.fromEntries(
      database
        .all<{ language: string; semantic_level: CodeGraph.SemanticLevel }>(
          `SELECT language,
             CASE MAX(CASE semantic_level WHEN 'semantic' THEN 3 WHEN 'syntax' THEN 2 ELSE 1 END)
               WHEN 3 THEN 'semantic' WHEN 2 THEN 'syntax' ELSE 'file' END AS semantic_level
           FROM code_file WHERE snapshot_slot = ? GROUP BY language ORDER BY language`,
          [current.current_slot],
        )
        .map((row) => [row.language, row.semantic_level]),
    )
    return Schema.decodeUnknownSync(CodeGraph.IndexStatus, { onExcessProperty: "error" })({
      state: current.state,
      ...(snapshotOf(database) ? { revision: snapshotOf(database) } : {}),
      generation: current.current_generation,
      ...(current.indexed_at === null ? {} : { indexedAt: current.indexed_at }),
      dirtyPathCount,
      semanticCoverage: coverage,
      ...(current.last_error_code && current.last_error_message
        ? { lastError: { code: current.last_error_code, message: current.last_error_message } }
        : {}),
    })
  }

  const fullCommit = (commit: CodeGraph.Commit & { readonly build: CodeGraph.Build }) =>
    database.transaction(() => {
      const current = requireCommit(database, commit)
      const slot = current.current_slot === "a" ? "b" : "a"
      const generation = current.current_generation + 1
      clearSlot(database, slot)
      insertBuild(database, slot, generation, commit.build)
      const manifestHash = calculateManifest(database, slot)
      insertManifest(database, {
        slot,
        generation,
        manifest_hash: manifestHash,
        index_incarnation: commit.indexIncarnation,
        fencing_token: commit.fencingToken,
        schema_version: SchemaVersion,
        adapter_set_version: input.adapterSetVersion,
        indexed_at: commit.indexedAt,
      })
      database.run(
        `UPDATE code_index_space SET state = 'ready', current_slot = ?, current_generation = ?,
          commit_fencing_token = ?, indexed_at = ?, last_error_code = NULL, last_error_message = NULL
         WHERE singleton = 1`,
        [slot, generation, commit.fencingToken, commit.indexedAt],
      )
      return requireSnapshot(database)
    })

  const incrementalCommit = (
    commit: CodeGraph.Commit & {
      readonly files: readonly CodeGraph.FileProjection[]
      readonly deletedPaths: readonly string[]
      readonly externalEntities?: readonly CodeGraph.Entity[]
      readonly edges?: readonly CodeGraph.Edge[]
      readonly aliases?: readonly CodeGraph.Alias[]
    },
  ) =>
    database.transaction(() => {
      const current = requireCommit(database, commit)
      const generation = current.current_generation + 1
      const paths = [...new Set([...commit.deletedPaths, ...commit.files.map((file) => file.file.path)])]
      paths.forEach((filePath) => deletePath(database, current.current_slot, filePath))
      insertBuild(database, current.current_slot, generation, {
        files: commit.files,
        externalEntities: commit.externalEntities ?? [],
        edges: commit.edges ?? [],
        aliases: commit.aliases ?? [],
      })
      database.run(
        `DELETE FROM code_entity WHERE snapshot_slot = ? AND entity_kind = 'external_package'
          AND entity_id NOT IN (
            SELECT from_entity_id FROM code_edge WHERE snapshot_slot = ?
            UNION SELECT to_entity_id FROM code_edge WHERE snapshot_slot = ?
          )`,
        [current.current_slot, current.current_slot, current.current_slot],
      )
      const manifestHash = calculateManifest(database, current.current_slot)
      insertManifest(database, {
        slot: current.current_slot,
        generation,
        manifest_hash: manifestHash,
        index_incarnation: commit.indexIncarnation,
        fencing_token: commit.fencingToken,
        schema_version: SchemaVersion,
        adapter_set_version: input.adapterSetVersion,
        indexed_at: commit.indexedAt,
      })
      database.run(
        `UPDATE code_index_space SET state = 'ready', current_generation = ?, commit_fencing_token = ?,
          indexed_at = ?, last_error_code = NULL, last_error_message = NULL WHERE singleton = 1`,
        [generation, commit.fencingToken, commit.indexedAt],
      )
      return requireSnapshot(database)
    })

  const search: CodeGraph.Store["search"] = (query) =>
    database.transaction(() => {
      const current = requireHeader(database)
      const revision = snapshotOf(database)
      if (!revision || !query.query.trim() || query.limit <= 0) return { revision, hits: [] }
      const limit = Math.min(query.limit, 100)
      const terms = query.query.toLowerCase().match(/[\p{L}\p{N}_$.-]{2,}/gu) ?? []
      if (terms.length === 0) return { revision, hits: [] }
      const match = terms.slice(0, 12).map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ")
      const rows = database.all<EntityRow & FileRow & SymbolRow & DegreeRow & { rank: number }>(
        `SELECT e.entity_id, e.entity_kind, e.stable_key, e.display_name, e.language, e.file_path,
          e.identity_stability, f.path, f.content_sha, f.mtime_ns, f.semantic_level, f.searchable_text,
          s.owning_entity_id, s.symbol_path, s.kind, s.start_line, s.end_line, s.signature,
          (SELECT COUNT(*) FROM code_edge d WHERE d.snapshot_slot = e.snapshot_slot AND d.to_entity_id = e.entity_id) AS in_degree,
          (SELECT COUNT(*) FROM code_edge d WHERE d.snapshot_slot = e.snapshot_slot AND d.from_entity_id = e.entity_id) AS out_degree,
          (SELECT COUNT(*) FROM code_edge d WHERE d.snapshot_slot = e.snapshot_slot AND d.to_entity_id = e.entity_id AND d.relation = 'calls') AS calls_in,
          (SELECT COUNT(*) FROM code_edge d WHERE d.snapshot_slot = e.snapshot_slot AND d.from_entity_id = e.entity_id AND d.relation = 'calls') AS calls_out,
          bm25(code_search_fts) AS rank
        FROM code_search_fts
        JOIN code_entity e ON e.snapshot_slot = code_search_fts.snapshot_slot
          AND e.entity_id = code_search_fts.entity_id
        LEFT JOIN code_symbol s ON s.snapshot_slot = e.snapshot_slot AND s.entity_id = e.entity_id
        LEFT JOIN code_file f ON f.snapshot_slot = e.snapshot_slot
          AND f.entity_id = CASE WHEN s.owning_entity_id IS NULL THEN e.entity_id ELSE s.owning_entity_id END
        WHERE code_search_fts MATCH ? AND e.snapshot_slot = ?
        ORDER BY CASE WHEN e.stable_key = ? OR e.display_name = ? THEN 0 ELSE 1 END,
          rank, e.entity_id LIMIT ?`,
        [match, current.current_slot, query.query, query.query, limit],
      )
      return {
        revision,
        hits: rows.map((row) => ({
          entity: entity(row),
          ...(row.path === null ? {} : { file: file(row) }),
          ...(row.symbol_path === null ? {} : { symbol: symbol(row) }),
          degree: degree(row),
          score: 1 / (1 + Math.max(0, row.rank)),
        })),
      }
    })

  const neighbors: CodeGraph.Store["neighbors"] = (query) =>
    database.transaction(() => {
      const current = requireHeader(database)
      const revision = snapshotOf(database)
      if (!revision || !query.entityId || query.limit <= 0) return { revision, hits: [] }
      const relations = query.relations?.filter((relation) => CodeGraph.EdgeRelation.literals.includes(relation)) ?? []
      const endpoint = query.direction === "outgoing" ? "from_entity_id" : "to_entity_id"
      const neighbor = query.direction === "outgoing" ? "to_entity_id" : "from_entity_id"
      const relationFilter = relations.length > 0 ? ` AND edge.relation IN (${relations.map(() => "?").join(", ")})` : ""
      const rows = database.all<NeighborRow>(
        `SELECT e.entity_id, e.entity_kind, e.stable_key, e.display_name, e.language, e.file_path,
          e.identity_stability, f.path, f.content_sha, f.mtime_ns, f.semantic_level, f.searchable_text,
          s.owning_entity_id, s.symbol_path, s.kind, s.start_line, s.end_line, s.signature,
          (SELECT COUNT(*) FROM code_edge d WHERE d.snapshot_slot = e.snapshot_slot AND d.to_entity_id = e.entity_id) AS in_degree,
          (SELECT COUNT(*) FROM code_edge d WHERE d.snapshot_slot = e.snapshot_slot AND d.from_entity_id = e.entity_id) AS out_degree,
          (SELECT COUNT(*) FROM code_edge d WHERE d.snapshot_slot = e.snapshot_slot AND d.to_entity_id = e.entity_id AND d.relation = 'calls') AS calls_in,
          (SELECT COUNT(*) FROM code_edge d WHERE d.snapshot_slot = e.snapshot_slot AND d.from_entity_id = e.entity_id AND d.relation = 'calls') AS calls_out,
          edge.from_entity_id, edge.to_entity_id, edge.relation, edge.evidence
         FROM code_edge edge
         JOIN code_entity e ON e.snapshot_slot = edge.snapshot_slot AND e.entity_id = edge.${neighbor}
         LEFT JOIN code_symbol s ON s.snapshot_slot = e.snapshot_slot AND s.entity_id = e.entity_id
         LEFT JOIN code_file f ON f.snapshot_slot = e.snapshot_slot
           AND f.entity_id = CASE WHEN s.owning_entity_id IS NULL THEN e.entity_id ELSE s.owning_entity_id END
         WHERE edge.snapshot_slot = ? AND edge.${endpoint} = ?${relationFilter}
         ORDER BY edge.relation, e.entity_id LIMIT ?`,
        [current.current_slot, query.entityId, ...relations, Math.min(query.limit, 100)],
      )
      return {
        revision,
        hits: rows.map((row) => ({
          entity: entity(row),
          ...(row.path === null ? {} : { file: file(row) }),
          ...(row.symbol_path === null ? {} : { symbol: symbol(row) }),
          degree: degree(row),
          edge: {
            fromEntityId: row.from_entity_id,
            toEntityId: row.to_entity_id,
            relation: row.relation,
            evidence: row.evidence,
          },
          direction: query.direction,
          score: 1,
        })),
      }
    })

  return { snapshot, status, fullCommit, incrementalCommit, search, neighbors, close: () => database.close() }
}

function initialize(database: Connection) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS code_index_space (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      index_space_id TEXT NOT NULL,
      index_incarnation INTEGER NOT NULL CHECK (index_incarnation > 0),
      canonical_root TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('cold', 'indexing', 'ready', 'degraded', 'unavailable')),
      current_slot TEXT NOT NULL CHECK (current_slot IN ('a', 'b')),
      current_generation INTEGER NOT NULL CHECK (current_generation >= 0),
      commit_fencing_token INTEGER NOT NULL CHECK (commit_fencing_token >= 0),
      indexed_at INTEGER,
      schema_version INTEGER NOT NULL,
      adapter_set_version TEXT NOT NULL,
      last_error_code TEXT,
      last_error_message TEXT
    );
    CREATE TABLE IF NOT EXISTS code_generation_manifest (
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
    CREATE TABLE IF NOT EXISTS code_entity (
      snapshot_slot TEXT NOT NULL CHECK (snapshot_slot IN ('a', 'b')),
      entity_id TEXT NOT NULL,
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('file', 'module', 'package', 'external_package', 'symbol')),
      stable_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      language TEXT NOT NULL,
      file_path TEXT,
      identity_stability TEXT NOT NULL CHECK (identity_stability IN ('durable', 'generation')),
      last_changed_generation INTEGER NOT NULL,
      PRIMARY KEY (snapshot_slot, entity_id),
      UNIQUE (snapshot_slot, stable_key)
    );
    CREATE TABLE IF NOT EXISTS code_file (
      snapshot_slot TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      path TEXT NOT NULL,
      language TEXT NOT NULL,
      content_sha TEXT NOT NULL,
      mtime_ns TEXT,
      semantic_level TEXT NOT NULL CHECK (semantic_level IN ('file', 'syntax', 'semantic')),
      searchable_text TEXT NOT NULL,
      last_changed_generation INTEGER NOT NULL,
      PRIMARY KEY (snapshot_slot, entity_id),
      UNIQUE (snapshot_slot, path),
      FOREIGN KEY (snapshot_slot, entity_id) REFERENCES code_entity(snapshot_slot, entity_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS code_symbol (
      snapshot_slot TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      owning_entity_id TEXT NOT NULL,
      symbol_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_line INTEGER NOT NULL CHECK (start_line > 0),
      end_line INTEGER NOT NULL CHECK (end_line >= start_line),
      signature TEXT NOT NULL,
      last_changed_generation INTEGER NOT NULL,
      PRIMARY KEY (snapshot_slot, entity_id),
      FOREIGN KEY (snapshot_slot, entity_id) REFERENCES code_entity(snapshot_slot, entity_id) ON DELETE CASCADE,
      FOREIGN KEY (snapshot_slot, owning_entity_id) REFERENCES code_entity(snapshot_slot, entity_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS code_edge (
      snapshot_slot TEXT NOT NULL,
      from_entity_id TEXT NOT NULL,
      to_entity_id TEXT NOT NULL,
      relation TEXT NOT NULL CHECK (relation IN ('contains', 'imports', 'exports', 'calls', 'references', 'implements', 'depends_on')),
      evidence TEXT NOT NULL,
      last_changed_generation INTEGER NOT NULL,
      PRIMARY KEY (snapshot_slot, from_entity_id, to_entity_id, relation, evidence),
      FOREIGN KEY (snapshot_slot, from_entity_id) REFERENCES code_entity(snapshot_slot, entity_id) ON DELETE CASCADE,
      FOREIGN KEY (snapshot_slot, to_entity_id) REFERENCES code_entity(snapshot_slot, entity_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS code_edge_from_idx ON code_edge (snapshot_slot, from_entity_id, relation);
    CREATE INDEX IF NOT EXISTS code_edge_to_idx ON code_edge (snapshot_slot, to_entity_id, relation);
    CREATE TABLE IF NOT EXISTS code_entity_alias (
      from_entity_id TEXT NOT NULL,
      to_entity_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('trusted_rename', 'git_rename', 'parser_continuity')),
      evidence TEXT NOT NULL,
      created_generation INTEGER NOT NULL,
      PRIMARY KEY (from_entity_id, to_entity_id, reason)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS code_search_fts USING fts5(
      snapshot_slot UNINDEXED, entity_id UNINDEXED, path, symbol, signature, searchable_text,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `)
}

function insertBuild(database: Connection, slot: "a" | "b", generation: number, build: CodeGraph.Build) {
  const decodeEntity = Schema.decodeUnknownSync(CodeGraph.Entity, { onExcessProperty: "error" })
  const decodeFile = Schema.decodeUnknownSync(CodeGraph.File, { onExcessProperty: "error" })
  const decodeSymbol = Schema.decodeUnknownSync(CodeGraph.Symbol, { onExcessProperty: "error" })
  const decodeEdge = Schema.decodeUnknownSync(CodeGraph.Edge, { onExcessProperty: "error" })
  const decodeAlias = Schema.decodeUnknownSync(CodeGraph.Alias, { onExcessProperty: "error" })
  build.externalEntities.map((value) => decodeEntity(value)).forEach((item) => insertEntity(database, slot, generation, item))
  build.files.forEach((projection) => {
    const item = { entity: decodeEntity(projection.entity), file: decodeFile(projection.file) }
    if (item.entity.entityKind !== "file" || item.entity.entityId !== item.file.entityId || item.entity.filePath !== item.file.path) {
      throw new CorruptIndexError("Invalid file projection identity")
    }
    validatePath(item.file.path)
    insertEntity(database, slot, generation, item.entity)
    database.run(
      `INSERT INTO code_file VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [slot, item.file.entityId, item.file.path, item.file.language, item.file.contentSha, item.file.mtimeNs ?? null,
        item.file.semanticLevel, item.file.searchableText, generation],
    )
    database.run(`INSERT INTO code_search_fts VALUES (?, ?, ?, '', '', ?)`, [
      slot, item.file.entityId, item.file.path, item.file.searchableText,
    ])
    projection.symbols.forEach((value) => {
      const symbolEntity = decodeEntity(value.entity)
      const symbolValue = decodeSymbol(value.symbol)
      if (symbolEntity.entityKind !== "symbol" || symbolEntity.entityId !== symbolValue.entityId || symbolValue.owningEntityId !== item.file.entityId) {
        throw new CorruptIndexError("Invalid symbol projection identity")
      }
      insertEntity(database, slot, generation, symbolEntity)
      database.run(`INSERT INTO code_symbol VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        slot, symbolValue.entityId, symbolValue.owningEntityId, symbolValue.symbolPath, symbolValue.kind,
        symbolValue.startLine, symbolValue.endLine, symbolValue.signature, generation,
      ])
      database.run(`INSERT INTO code_search_fts VALUES (?, ?, ?, ?, ?, ?)`, [
        slot, symbolValue.entityId, item.file.path, symbolValue.symbolPath, symbolValue.signature,
        `${symbolEntity.displayName} ${symbolValue.signature}`,
      ])
    })
    projection.edges.map((value) => decodeEdge(value)).forEach((edge) => insertEdge(database, slot, generation, edge))
  })
  build.edges.map((value) => decodeEdge(value)).forEach((edge) => insertEdge(database, slot, generation, edge))
  build.aliases.map((value) => decodeAlias(value)).forEach((alias) =>
    database.run(`INSERT OR REPLACE INTO code_entity_alias VALUES (?, ?, ?, ?, ?)`, [
      alias.fromEntityId, alias.toEntityId, alias.reason, alias.evidence, generation,
    ]),
  )
}

function insertEntity(database: Connection, slot: "a" | "b", generation: number, item: CodeGraph.Entity) {
  database.run(`INSERT OR REPLACE INTO code_entity VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    slot, item.entityId, item.entityKind, item.stableKey, item.displayName, item.language,
    item.filePath ?? null, item.identityStability, generation,
  ])
}

function insertEdge(database: Connection, slot: "a" | "b", generation: number, item: CodeGraph.Edge) {
  database.run(`INSERT OR REPLACE INTO code_edge VALUES (?, ?, ?, ?, ?, ?)`, [
    slot, item.fromEntityId, item.toEntityId, item.relation, item.evidence, generation,
  ])
}

function deletePath(database: Connection, slot: "a" | "b", filePath: string) {
  validatePath(filePath)
  database.run(`DELETE FROM code_search_fts WHERE snapshot_slot = ? AND path = ?`, [slot, filePath])
  database.run(`DELETE FROM code_entity WHERE snapshot_slot = ? AND file_path = ?`, [slot, filePath])
}

function clearSlot(database: Connection, slot: "a" | "b") {
  database.run(`DELETE FROM code_search_fts WHERE snapshot_slot = ?`, [slot])
  database.run(`DELETE FROM code_entity WHERE snapshot_slot = ?`, [slot])
  database.run(`DELETE FROM code_generation_manifest WHERE slot = ?`, [slot])
}

function insertManifest(database: Connection, manifest: Manifest) {
  database.run(`INSERT INTO code_generation_manifest VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
    manifest.slot, manifest.generation, manifest.manifest_hash, manifest.index_incarnation,
    manifest.fencing_token, manifest.schema_version, manifest.adapter_set_version, manifest.indexed_at,
  ])
}

function calculateManifest(database: Connection, slot: "a" | "b") {
  return Hash.sha256(JSON.stringify({
    entities: database.all<Record<string, Value>>(
      `SELECT entity_id, entity_kind, stable_key, display_name, language, file_path, identity_stability
       FROM code_entity WHERE snapshot_slot = ? ORDER BY entity_id`, [slot]),
    files: database.all<Record<string, Value>>(
      `SELECT entity_id, path, language, content_sha, mtime_ns, semantic_level
       FROM code_file WHERE snapshot_slot = ? ORDER BY path`, [slot]),
    symbols: database.all<Record<string, Value>>(
      `SELECT entity_id, owning_entity_id, symbol_path, kind, start_line, end_line, signature
       FROM code_symbol WHERE snapshot_slot = ? ORDER BY entity_id`, [slot]),
    edges: database.all<Record<string, Value>>(
      `SELECT from_entity_id, to_entity_id, relation, evidence
       FROM code_edge WHERE snapshot_slot = ? ORDER BY from_entity_id, to_entity_id, relation, evidence`, [slot]),
  }))
}

function requireCommit(database: Connection, commit: CodeGraph.Commit) {
  const current = requireHeader(database)
  if (
    current.index_incarnation !== commit.indexIncarnation ||
    current.current_generation !== commit.expectedGeneration ||
    commit.fencingToken < current.commit_fencing_token
  ) throw new CommitConflictError("Stale Code index writer")
  return current
}

function header(database: Connection) {
  return database.get<Header>(`SELECT * FROM code_index_space WHERE singleton = 1`)
}

function requireHeader(database: Connection) {
  const value = header(database)
  if (!value) throw new CorruptIndexError("Missing Code index header")
  return value
}

function snapshotOf(database: Connection) {
  const current = requireHeader(database)
  if (current.current_generation === 0) return
  const manifest = database.get<Manifest>(
    `SELECT * FROM code_generation_manifest WHERE slot = ? AND generation = ?`,
    [current.current_slot, current.current_generation],
  )
  if (!manifest || manifest.index_incarnation !== current.index_incarnation || manifest.fencing_token !== current.commit_fencing_token) {
    throw new CorruptIndexError("Code index manifest does not match its header")
  }
  return {
    projectionKind: "code" as const,
    indexIncarnation: current.index_incarnation,
    generation: current.current_generation,
    manifestHash: manifest.manifest_hash,
    schemaVersion: current.schema_version,
    adapterSetVersion: current.adapter_set_version,
  }
}

function requireSnapshot(database: Connection) {
  const value = snapshotOf(database)
  if (!value) throw new CorruptIndexError("Code index commit did not publish a snapshot")
  return value
}

function entity(row: EntityRow): CodeGraph.Entity {
  return {
    entityId: row.entity_id,
    entityKind: row.entity_kind,
    stableKey: row.stable_key,
    displayName: row.display_name,
    language: row.language,
    ...(row.file_path === null ? {} : { filePath: row.file_path }),
    identityStability: row.identity_stability,
  }
}

function file(row: FileRow): CodeGraph.File {
  return {
    entityId: row.entity_id,
    path: row.path,
    language: row.language,
    contentSha: row.content_sha,
    ...(row.mtime_ns === null ? {} : { mtimeNs: row.mtime_ns }),
    semanticLevel: row.semantic_level,
    searchableText: row.searchable_text,
  }
}

function symbol(row: SymbolRow): CodeGraph.Symbol {
  return {
    entityId: row.entity_id,
    owningEntityId: row.owning_entity_id,
    symbolPath: row.symbol_path,
    kind: row.kind,
    startLine: row.start_line,
    endLine: row.end_line,
    signature: row.signature,
  }
}

function degree(row: DegreeRow): CodeGraph.Degree {
  return {
    inDegree: row.in_degree,
    outDegree: row.out_degree,
    callsIn: row.calls_in,
    callsOut: row.calls_out,
  }
}

function validatePath(filePath: string) {
  if (!filePath || filePath.startsWith("/") || filePath.includes("\\") || filePath.split("/").includes("..")) {
    throw new CorruptIndexError("Code index paths must be normalized Location-relative paths")
  }
}
