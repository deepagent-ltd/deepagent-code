import { createHash } from "node:crypto"
import type { DurableKnowledgeStore } from "./durable-knowledge-store"
import type { Doc, DocType, Provenance } from "./document-store"

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

export type IndexResult = {
  // code_symbol node ids that exist after indexing (created, updated, or unchanged).
  readonly nodeIds: readonly string[]
  // How many files were newly created / updated / skipped-unchanged this pass.
  readonly created: number
  readonly updated: number
  readonly unchanged: number
  // code->doc `references` edges created this pass.
  readonly edgesCreated: number
}

const sha256 = (text: string): string => "sha256:" + createHash("sha256").update(text).digest("hex")

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
  let created = 0
  let updated = 0
  let unchanged = 0
  let edgesCreated = 0

  for (const file of files) {
    const { id, outcome } = registerFile(store, file)
    nodeIds.push(id)
    if (outcome === "created") created++
    else if (outcome === "updated") updated++
    else unchanged++
    if (buildDocEdges) edgesCreated += linkDocEvidence(store, id, file.path)
  }

  return { nodeIds, created, updated, unchanged, edgesCreated }
}
