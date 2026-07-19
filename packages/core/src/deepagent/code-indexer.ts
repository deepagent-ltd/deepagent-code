import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { DurableKnowledgeStore } from "./durable-knowledge-store"
import type { Doc, DocType, LinkRel, Provenance } from "./document-store"

// V3.8 Phase 3 (v3.8.1 §B.3): the MINIMAL lightweight code indexer. It registers project files as
// file-level `code_symbol` nodes in a per-project DurableKnowledgeStore and, where a knowledge/doc
// node carries EXPLICIT evidence (its text references a file path), links the code node to that doc
// via a `references` edge. It is deliberately NOT an LSP: no semantic parse, no call graph. Its only
// job is to put real code nodes on the graph so UnifiedContextGraph can traverse into them (the V4.0
// prerequisite). Deeper symbol/semantic indexing is a later version.
//
// Version-bloat mitigation (the ⚠ Phase 3 TODO left in document-store.ts): document-store is
// append-only (upsert()/update() bump version+1 on any fingerprint change) and MUST NOT be modified.
// So the mitigation lives HERE: CONTENT-SHA GATING. Every code_symbol node stores its file's content
// sha256 in `extensions.content_sha`. Before writing, the indexer compares the incoming sha to the
// stored one and SKIPS the write entirely when unchanged — so re-indexing an unchanged tree produces
// ZERO new versions (idempotent), and a version bump happens only on a genuine content change (which
// is semantically correct). Content sha is the sole skip authority. An optional `mtimeMs` is recorded
// on each node for a future fs-walking caller to decide whether to READ + hash a file at all (the only
// layer where mtime avoids real I/O); it is intentionally NOT used to short-circuit here, because a
// rewound/non-monotonic mtime (git checkout/stash/rebase) must never mask a genuine content change.

const CODE_SYMBOL: DocType = "code_symbol"
// Registered code nodes are indexer-derived, so we mark provenance as tool-sourced with a stable
// run_ref. Not knowledge-class, so no confidence is required (KNOWLEDGE_TYPES excludes code_symbol).
const INDEXER_PROV: Provenance = { source: "tool", run_ref: "code-indexer", evidence_refs: [] }

export type CodeFile = {
  // Repo-relative (or absolute) path — used as the node's stable logical identity and its description.
  readonly path: string
  readonly content: string
  // Optional filesystem mtime in ms. Recorded on the node (extensions.mtime_ms) for a future
  // fs-walking caller to decide whether to READ + hash a file at all. It is NOT a skip authority in
  // registerFile — content sha is (a rewound/non-monotonic mtime must never mask a real content change).
  readonly mtimeMs?: number
  // Optional language hint (e.g. "ts"). Defaults to the file extension.
  readonly language?: string
}

// Per-file outcome of a file-level index pass. V3.9 §A: exposed so the symbol-pass caller (the
// deepagent-code trigger) can run the expensive LSP extraction ONLY on files whose content-sha
// actually CHANGED this pass (created/updated), not the whole tree (§A.4 "仅对 content-sha 变化的文件跑 LSP").
export type FileOutcome = {
  readonly path: string
  readonly nodeId: string
  readonly outcome: "created" | "updated" | "unchanged"
  readonly contentSha: string
}

export type IndexResult = {
  // code_symbol node ids that exist after indexing (created, updated, or unchanged).
  readonly nodeIds: readonly string[]
  // How many files were newly created / updated / skipped-unchanged this pass.
  readonly created: number
  readonly updated: number
  readonly unchanged: number
  // code->doc `references` edges created this pass.
  readonly edgesCreated: number
  // Per-file outcome + content sha, in the same order as the input files (V3.9 §A symbol-pass gating).
  readonly outcomes: readonly FileOutcome[]
}

const sha256 = (text: string): string => "sha256:" + createHash("sha256").update(text).digest("hex")

// Content sha of a file's text — the same algorithm registerFile uses internally, exported so a caller
// gating the symbol pass can compute the sha it must pass to indexSymbols without re-hashing differently.
export const contentShaOf = (content: string): string => sha256(content)

const languageOf = (path: string, explicit?: string): string => {
  if (explicit) return explicit
  const dot = path.lastIndexOf(".")
  return dot >= 0 && dot < path.length - 1 ? path.slice(dot + 1) : "unknown"
}

// Signature-summary body for a code node: path + language + a bounded content head. Intentionally
// small — the identity is the path, not the body; the body only contributes keyword surface for
// similarity scoring and a human-readable snippet.
const bodyFor = (file: CodeFile): string => {
  const lang = languageOf(file.path, file.language)
  const head = file.content.slice(0, 800)
  return `path: ${file.path}\nlanguage: ${lang}\n---\n${head}`
}

// Find the existing (latest, non-superseded/rejected) code_symbol node for a path within one store.
// Logical identity = code_symbol node whose description === path. Returns null if none.
const findByPath = (store: DurableKnowledgeStore, path: string): Doc | null => {
  const ds = store.documentStore
  for (const ref of ds.list({ type: CODE_SYMBOL })) {
    if (ref.description !== path) continue
    const doc = ds.get(ref.id)
    if (!doc || doc.status === "rejected") continue
    return doc
  }
  return null
}

// Register (create or content-gated upsert) a single file as a code_symbol node. Returns the node id
// plus whether it was created/updated/unchanged. CONTENT-SHA gating avoids version bloat.
export const registerFile = (
  store: DurableKnowledgeStore,
  file: CodeFile,
): { readonly id: string; readonly outcome: "created" | "updated" | "unchanged" } => {
  const ds = store.documentStore
  const existing = findByPath(store, file.path)
  const contentSha = sha256(file.content)

  if (existing) {
    const priorSha = existing.extensions?.content_sha
    // Content sha is AUTHORITATIVE: skip the write only when the content is provably unchanged. No
    // upsert() call means no version+1 and no supersede link written. mtime is deliberately NOT a
    // skip authority here — a stale/non-monotonic mtime (git checkout, stash pop, rebase all rewind
    // mtimes) with genuinely changed content must NOT be dropped, or the graph would serve a stale
    // body. The mtime_ms is still recorded (below) so a future fs-walking caller can use it to decide
    // whether to READ + hash a file at all (the only layer where mtime avoids real I/O — here the
    // content is already in memory, so hashing is free and the mtime shortcut buys nothing).
    if (priorSha === contentSha) {
      return { id: existing.id, outcome: "unchanged" }
    }
  }

  const next = ds.upsert({
    type: CODE_SYMBOL,
    scope: "durable",
    description: file.path,
    body: bodyFor(file),
    domain: null,
    tags: ["code"],
    provenance: INDEXER_PROV,
    idSlug: file.path,
    extensions: {
      content_sha: contentSha,
      language: languageOf(file.path, file.language),
      ...(typeof file.mtimeMs === "number" ? { mtime_ms: file.mtimeMs } : {}),
    },
  })

  return { id: next.id, outcome: existing ? "updated" : "created" }
}

// Build code->doc `references` edges from EXPLICIT evidence only: a non-code doc in the SAME store
// whose text (description + body) contains the file path is linked from the code node. Same-store is
// required by INV-3 (cross-store links throw); the indexer only ever links within the project store.
// Returns the number of edges newly created.
const linkDocEvidence = (store: DurableKnowledgeStore, codeId: string, path: string): number => {
  const ds = store.documentStore
  const code = ds.get(codeId)
  if (!code) return 0
  let created = 0
  for (const ref of ds.list()) {
    if (ref.type === CODE_SYMBOL) continue
    const doc = ds.get(ref.id)
    if (!doc || doc.status === "rejected") continue
    const haystack = `${doc.description}\n${doc.body}`
    if (!haystack.includes(path)) continue
    const already = ds.get(codeId)?.links.some((l) => l.rel === "references" && l.to === doc.id)
    if (already) continue
    ds.link(codeId, "references", doc.id)
    created++
  }
  return created
}

// Index a batch of files into one store: register each as a code_symbol node (content-gated), then
// build explicit code->doc reference edges. Pure over the given store + file list (no filesystem
// access) so it is fully unit-testable; a filesystem-walking caller is a thin wrapper on top.
export const indexFiles = (
  store: DurableKnowledgeStore,
  files: readonly CodeFile[],
  options: { readonly buildDocEdges?: boolean } = {},
): IndexResult => {
  const buildDocEdges = options.buildDocEdges ?? true
  const nodeIds: string[] = []
  const outcomes: FileOutcome[] = []
  let created = 0
  let updated = 0
  let unchanged = 0
  let edgesCreated = 0

  for (const file of files) {
    const { id, outcome } = registerFile(store, file)
    nodeIds.push(id)
    outcomes.push({ path: file.path, nodeId: id, outcome, contentSha: sha256(file.content) })
    if (outcome === "created") created++
    else if (outcome === "updated") updated++
    else unchanged++
    if (buildDocEdges) edgesCreated += linkDocEvidence(store, id, file.path)
  }

  return { nodeIds, created, updated, unchanged, edgesCreated, outcomes }
}

// ============================================================================================
// V3.9 §A — AST-level symbol index + code→code edges (imports/calls) + file→symbol contains edges.
// ============================================================================================
//
// LAYERING (deviation from spec §A.3 shape, deliberate): the spec sketched `indexSymbols({file, lsp,
// store})` — i.e. core calls LSP directly. But `@deepagent-code/core` is a LOWER layer than
// deepagent-code (where lsp/lsp.ts lives) and MUST NOT depend on it. So the split is:
//   - THIS pure function consumes ALREADY-EXTRACTED symbol data (SymbolExtraction) and writes the
//     symbol subtree + edges. No LSP import, fully unit-testable, default-safe.
//   - The deepagent-code trigger (code-index-trigger.ts) runs the LSP extraction (it CAN import both
//     LSP.Service and this module) and feeds the result here.
//
// CONTENT-SHA GATING (§A.2/§A.5): the file node carries `extensions.symbols_sha`, a marker set after a
// successful symbol pass. When the incoming content sha equals the stored symbols_sha, the ENTIRE
// symbol subtree rebuild is skipped (zero upsert()/link() calls ⇒ zero new versions), so re-indexing
// an unchanged file is a true no-op. `symbols_sha` is set as the LAST step, so a partial failure leaves
// it unset and the next pass retries.

// The kinds of code_symbol node the AST index produces (a real subset of the spec's union). "file" is
// the existing file-level parent; the rest are symbol children.
export type CodeSymbolKind = "file" | "module" | "class" | "function" | "method" | "interface" | "type"

// One extracted symbol within a host file. `symbolPath` is the file-internal path (e.g. "Foo.bar" for a
// method `bar` on class `Foo`); it becomes the child node identity segment after the `#`.
export type ExtractedSymbol = {
  readonly symbolPath: string
  readonly kind: CodeSymbolKind
  // 0-based inclusive line range, for file:line cross-linking (§A.3 range).
  readonly range?: { readonly start: number; readonly end: number }
  readonly signature?: string
  // 0-based position of the symbol's NAME/identifier (LSP selectionRange start), when known. Used ONLY
  // by the caller's callHierarchy probe (`prepareCallHierarchy` must point at the identifier, not at
  // column 0 of the declaration line which is usually indentation) — it is NOT persisted on the node.
  readonly nameLine?: number
  readonly nameChar?: number
}

// One call edge: the calling symbol (in the host file) → the called symbol (possibly in another file).
export type ExtractedCall = {
  readonly fromSymbolPath: string
  readonly toPath: string
  readonly toSymbolPath: string
}

// The fully-extracted symbol data for ONE host file. `contentSha` (if given) gates the whole pass; if
// omitted, the caller is responsible for having gated already (indexSymbols then always rebuilds).
export type SymbolExtraction = {
  readonly path: string
  readonly contentSha?: string
  readonly symbols: readonly ExtractedSymbol[]
  // Host-file paths this file imports (→ `imports` file-node→file-node edges; only when the target
  // file node already exists in the store).
  readonly imports?: readonly string[]
  // Call edges (→ `calls` symbol-node→symbol-node edges; only when BOTH endpoints exist).
  readonly calls?: readonly ExtractedCall[]
}

export type SymbolIndexResult = {
  // Was the whole pass skipped by the symbols_sha gate?
  readonly skipped: boolean
  // The file-level (parent) node id, or null if no file node exists for the path (nothing done).
  readonly fileNodeId: string | null
  // code_symbol child node ids created or already-present after this pass.
  readonly symbolNodeIds: readonly string[]
  readonly symbolsCreated: number
  readonly symbolsUpdated: number
  readonly symbolsUnchanged: number
  // Edges created this pass, by relation.
  readonly containsEdges: number
  readonly importsEdges: number
  readonly callsEdges: number
  // Edge targets that did not resolve to an existing node (skipped gracefully, not an error).
  readonly importsSkipped: number
  readonly callsSkipped: number
}

const emptySymbolResult = (fileNodeId: string | null, skipped: boolean): SymbolIndexResult => ({
  skipped,
  fileNodeId,
  symbolNodeIds: [],
  symbolsCreated: 0,
  symbolsUpdated: 0,
  symbolsUnchanged: 0,
  containsEdges: 0,
  importsEdges: 0,
  callsEdges: 0,
  importsSkipped: 0,
  callsSkipped: 0,
})

// The child-node logical identity for a symbol: "<path>#<symbolPath>". Also the description + idSlug.
export const symbolNodeKey = (path: string, symbolPath: string): string => `${path}#${symbolPath}`

// Find the existing (latest, non-rejected) symbol child node by its "<path>#<symbolPath>" description.
const findSymbolNode = (store: DurableKnowledgeStore, key: string): Doc | null => {
  const ds = store.documentStore
  for (const ref of ds.list({ type: CODE_SYMBOL })) {
    if (ref.description !== key) continue
    const doc = ds.get(ref.id)
    if (!doc || doc.status === "rejected") continue
    return doc
  }
  return null
}

// The leaf segment of a dotted symbol path ("Foo.bar" → "bar", "bar" → "bar").
const leafOf = (symbolPath: string): string => {
  const dot = symbolPath.lastIndexOf(".")
  return dot >= 0 ? symbolPath.slice(dot + 1) : symbolPath
}

/**
 * Resolve a call TARGET symbol node. LSP callHierarchy reports a target by its LEAF name (e.g. "bar"),
 * but symbol nodes are keyed by the DOTTED path ("<file>#Foo.bar"). So:
 *   1. exact match on "<toPath>#<toSymbolPath>" (works when the extractor already had the dotted path);
 *   2. FALLBACK — among the symbol nodes hosted by `toPath`, the UNIQUE one whose dotted symbol_path has
 *      a leaf equal to `toSymbolPath` (resolves a leaf-only target like "bar" → node "…#Foo.bar").
 * The fallback is deliberately conservative: if it is AMBIGUOUS (two hosted symbols share the leaf,
 * e.g. `Foo.bar` and `Baz.bar`), it returns null and the caller skips the edge — guessing would be
 * non-deterministic and could draw a wrong call edge. `toSymbolPath` given as a dotted path still hits
 * case 1 first, so the fallback only ever fires for leaf-only targets.
 */
const resolveCallTarget = (store: DurableKnowledgeStore, toPath: string, toSymbolPath: string): Doc | null => {
  const exact = findSymbolNode(store, symbolNodeKey(toPath, toSymbolPath))
  if (exact) return exact
  // Leaf-name fallback, scoped to the target file's symbol nodes.
  const ds = store.documentStore
  const leaf = leafOf(toSymbolPath)
  let match: Doc | null = null
  for (const ref of ds.list({ type: CODE_SYMBOL })) {
    const doc = ds.get(ref.id)
    if (!doc || doc.status === "rejected") continue
    if (doc.extensions?.host_path !== toPath) continue // only symbol children of the target file
    const sp = doc.extensions?.symbol_path
    if (typeof sp !== "string" || leafOf(sp) !== leaf) continue
    if (match) return null // ambiguous leaf → skip rather than guess (determinism)
    match = doc
  }
  return match
}

const symbolBodyFor = (path: string, sym: ExtractedSymbol): string => {
  const range = sym.range ? `\nlines: ${sym.range.start + 1}-${sym.range.end + 1}` : ""
  const sig = sym.signature ? `\nsignature: ${sym.signature}` : ""
  return `symbol: ${sym.symbolPath}\nkind: ${sym.kind}\nfile: ${path}${range}${sig}`
}

// Register (create or content-gated upsert) ONE symbol child node. The node fingerprint is derived from
// kind/range/signature/host so a genuine change to the symbol bumps the version and an identical re-run
// is a no-op. The file's content_sha is deliberately NOT stored here: gating is at the FILE level (the
// parent node's symbols_sha), so putting content_sha on every symbol would churn every symbol's version
// on any unrelated edit elsewhere in the file. A symbol node bumps only when its own kind/range/
// signature actually changes.
// Disambiguate the node key for symbols that share a symbolPath within ONE file (function overloads,
// `interface Foo` + `namespace Foo`, etc.). Without this they collide on `path#symbolPath` and the
// later occurrence silently OVERWRITES the earlier one (data loss for every overload but the last).
// The FIRST occurrence keeps the clean `path#symbolPath` key — so the overwhelmingly common
// non-overloaded case is unchanged (stable keys, call edges resolve as before) — and each subsequent
// same-path occurrence gets a deterministic `~N` suffix (N = 2,3,… in document order, which
// LSP documentSymbol + flattenSymbols preserve). Deterministic per file content; the content-sha gate
// means any re-numbering only happens on a genuine content change (the whole file rebuilds anyway).
const assignSymbolKeys = (path: string, symbols: readonly ExtractedSymbol[]): string[] => {
  const seen = new Map<string, number>()
  return symbols.map((sym) => {
    const base = symbolNodeKey(path, sym.symbolPath)
    const n = (seen.get(sym.symbolPath) ?? 0) + 1
    seen.set(sym.symbolPath, n)
    return n === 1 ? base : `${base}~${n}`
  })
}

const registerSymbol = (
  store: DurableKnowledgeStore,
  path: string,
  sym: ExtractedSymbol,
  // The (possibly disambiguated) node key — see assignSymbolKeys. Defaults to the plain key for the
  // non-colliding case and direct callers.
  key: string = symbolNodeKey(path, sym.symbolPath),
): { readonly id: string; readonly outcome: "created" | "updated" | "unchanged" } => {
  const ds = store.documentStore
  const existing = findSymbolNode(store, key)

  const next = ds.upsert({
    type: CODE_SYMBOL,
    scope: "durable",
    description: key,
    body: symbolBodyFor(path, sym),
    domain: null,
    tags: ["code", "symbol"],
    provenance: INDEXER_PROV,
    idSlug: key,
    extensions: {
      kind: sym.kind,
      symbol_path: sym.symbolPath,
      host_path: path,
      ...(sym.range ? { range: { start: sym.range.start, end: sym.range.end } } : {}),
      ...(sym.signature ? { signature: sym.signature } : {}),
    },
  })

  const outcome: "created" | "updated" | "unchanged" = !existing
    ? "created"
    : next.id === existing.id && next.version === existing.version
      ? "unchanged"
      : "updated"
  return { id: next.id, outcome }
}

// Set the `symbols_sha` marker on the file node so the next pass with identical content is skipped.
// Preserves all of the file node's existing fields + links (the contains/imports edges just written).
const markSymbolsSha = (store: DurableKnowledgeStore, fileNodeId: string, symbolsSha: string): void => {
  const ds = store.documentStore
  const file = ds.get(fileNodeId)
  if (!file) return
  if (file.extensions?.symbols_sha === symbolsSha) return
  ds.upsert({
    type: file.type,
    scope: file.scope,
    description: file.description,
    body: file.body,
    domain: file.domain,
    tags: file.tags,
    links: file.links,
    provenance: file.provenance,
    ...(file.confidence ? { confidence: file.confidence } : {}),
    idSlug: file.description, // file node idSlug === path === description (registerFile invariant)
    extensions: { ...(file.extensions ?? {}), symbols_sha: symbolsSha },
  })
}

// Ensure a `rel` edge from -> to exists (idempotent). Returns 1 if newly created, else 0.
const ensureEdge = (store: DurableKnowledgeStore, from: string, rel: LinkRel, to: string): number => {
  const ds = store.documentStore
  const cur = ds.get(from)
  if (!cur) return 0
  if (cur.links.some((l) => l.rel === rel && l.to === to)) return 0
  ds.link(from, rel, to)
  return 1
}

// Index the AST-level symbol subtree for ONE already-extracted file. PURE over the store + extraction
// (no LSP, no filesystem). default-safe: never throws on a missing file node or an unresolved edge
// target — it skips and counts. Writes: symbol child nodes, file→symbol `contains` edges, file→file
// `imports` edges (only when the target file node exists), symbol→symbol `calls` edges (only when both
// endpoints exist). content-sha gated via the file node's `symbols_sha` marker.
export const indexSymbols = (
  store: DurableKnowledgeStore,
  extraction: SymbolExtraction,
  options: { readonly buildCallEdges?: boolean } = {},
): SymbolIndexResult => {
  const buildCallEdges = options.buildCallEdges ?? true
  const fileNode = findByPath(store, extraction.path)
  // No file-level parent → nothing to hang symbols off. Not an error (§A default-safe): the file-level
  // pass either hasn't run or the file was excluded; skip cleanly.
  if (!fileNode) return emptySymbolResult(null, false)

  // content-sha gate: identical content already symbol-indexed → skip the whole subtree (zero versions).
  if (extraction.contentSha && fileNode.extensions?.symbols_sha === extraction.contentSha) {
    return emptySymbolResult(fileNode.id, true)
  }

  const symbolNodeIds: string[] = []
  let symbolsCreated = 0
  let symbolsUpdated = 0
  let symbolsUnchanged = 0
  let containsEdges = 0
  let importsEdges = 0
  let callsEdges = 0
  let importsSkipped = 0
  let callsSkipped = 0

  // 1. Symbol child nodes + file→symbol contains edges. Keys are disambiguated so same-symbolPath
  // occurrences (overloads / declaration merging) each get a distinct node instead of overwriting.
  const keys = assignSymbolKeys(extraction.path, extraction.symbols)
  extraction.symbols.forEach((sym, i) => {
    const { id, outcome } = registerSymbol(store, extraction.path, sym, keys[i])
    symbolNodeIds.push(id)
    if (outcome === "created") symbolsCreated++
    else if (outcome === "updated") symbolsUpdated++
    else symbolsUnchanged++
    containsEdges += ensureEdge(store, fileNode.id, "contains", id)
  })

  // 2. file→file imports edges — only when the target file node already exists in this store.
  for (const importPath of extraction.imports ?? []) {
    const target = findByPath(store, importPath)
    if (!target || target.id === fileNode.id) {
      if (!target) importsSkipped++
      continue
    }
    importsEdges += ensureEdge(store, fileNode.id, "imports", target.id)
  }

  // 3. symbol→symbol calls edges — only when BOTH endpoints resolve to existing symbol nodes. The
  // caller side is exact (we own the dotted path); the target side uses the leaf-name fallback because
  // callHierarchy reports a target by its leaf name.
  if (buildCallEdges) {
    for (const call of extraction.calls ?? []) {
      const fromNode = findSymbolNode(store, symbolNodeKey(extraction.path, call.fromSymbolPath))
      const toNode = resolveCallTarget(store, call.toPath, call.toSymbolPath)
      if (!fromNode || !toNode) {
        callsSkipped++
        continue
      }
      callsEdges += ensureEdge(store, fromNode.id, "calls", toNode.id)
    }
  }

  // 4. LAST: stamp symbols_sha so an unchanged re-run is a true no-op. Done last so a partial failure
  // above leaves the marker unset and the next pass retries the rebuild.
  if (extraction.contentSha) markSymbolsSha(store, fileNode.id, extraction.contentSha)

  return {
    skipped: false,
    fileNodeId: fileNode.id,
    symbolNodeIds,
    symbolsCreated,
    symbolsUpdated,
    symbolsUnchanged,
    containsEdges,
    importsEdges,
    callsEdges,
    importsSkipped,
    callsSkipped,
  }
}

// Link ONLY the symbol→symbol call edges for an extraction, WITHOUT touching the symbols_sha gate or
// rebuilding symbol nodes. Exposed so a batch caller can create ALL symbol nodes across many files
// first (pass 1) and then resolve cross-file calls (pass 2), guaranteeing both endpoints exist even
// when caller and callee live in different files indexed in the same batch. Idempotent + default-safe.
export const linkCallEdges = (
  store: DurableKnowledgeStore,
  fromPath: string,
  calls: readonly ExtractedCall[],
): { readonly callsEdges: number; readonly callsSkipped: number } => {
  let callsEdges = 0
  let callsSkipped = 0
  for (const call of calls) {
    const fromNode = findSymbolNode(store, symbolNodeKey(fromPath, call.fromSymbolPath))
    const toNode = resolveCallTarget(store, call.toPath, call.toSymbolPath)
    if (!fromNode || !toNode) {
      callsSkipped++
      continue
    }
    callsEdges += ensureEdge(store, fromNode.id, "calls", toNode.id)
  }
  return { callsEdges, callsSkipped }
}

// V4.0 §C3.3 — resolve the FULLY-QUALIFIED symbol keys ("<host_path>#<symbol_path>") of the symbol
// nodes hosted by a set of files, from an already-open project store. This is the code-graph feed for
// the ConflictArbiter's semantic layer: two subtasks touching the same symbol conflict, and qualifying
// the key by host_path means the SAME symbol name in DIFFERENT files does NOT false-conflict. It scans
// the store's code_symbol nodes and collects the symbol children whose `extensions.host_path` matches a
// requested file (the file-level parent node carries no symbol_path, so it is naturally excluded).
// PURE over the store + no filesystem; default-safe — a missing/empty graph yields []. Wrapped in Effect
// so the runtime's resolver can catch any store defect and fall back to file-level detection.
export const symbolsForFilePaths = (
  store: DurableKnowledgeStore,
  files: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.sync(() => {
    if (files.length === 0) return []
    const wanted = new Set(files)
    const ds = store.documentStore
    const keys: string[] = []
    for (const ref of ds.list({ type: CODE_SYMBOL })) {
      const doc = ds.get(ref.id)
      if (!doc || doc.status === "rejected") continue
      const hostPath = doc.extensions?.host_path
      const symbolPath = doc.extensions?.symbol_path
      // only symbol CHILD nodes carry host_path + symbol_path; file-level parents have neither.
      if (typeof hostPath !== "string" || typeof symbolPath !== "string") continue
      if (!wanted.has(hostPath)) continue
      keys.push(symbolNodeKey(hostPath, symbolPath))
    }
    return keys
  })
