import {
  DurableKnowledgeStore,
  openUserGlobalStore,
  openProjectStore,
  projectIdForWorkspace,
  statusToApproval,
  type ScoredDoc,
} from "./durable-knowledge-store"
import type { DocType } from "./document-store"

// V3.2.1 decision B (docs/34 §8): the read-side adapter between the knowledge retriever and the
// durable DocumentStore. Durable knowledge lives in TWO roots under the single injected base
// (Global.Path.agent.data): user-global (public/knowledge, visible everywhere) and per-project
// (project/<pid>/knowledge, project-shared isolation). A retrieval for a workspace UNIONS both.
//
// Mirrors the old memory-store module pattern: a single configured base + a clearable cache, so the
// retriever stays a pure-ish function (retrieve(input)) and approve/reject is reflected after
// invalidateCache(). This module is the ONLY durable read path the retriever uses.

let baseDir: string | null = null
let userGlobalCache: DurableKnowledgeStore | null = null
const projectCache = new Map<string, DurableKnowledgeStore>()

// Configure the durable knowledge base dir (the gateway calls this alongside SessionState/MemoryStore
// configure, from the injected baseDir — never a self-resolved home).
export const configure = (dir: string): void => {
  baseDir = dir
  userGlobalCache = null
  projectCache.clear()
}

export const isConfigured = (): boolean => baseDir !== null

// Clear cached stores so a subsequent query re-reads from disk (after approve/reject/seed).
export const invalidateCache = (): void => {
  userGlobalCache = null
  projectCache.clear()
}

const ensureBase = (): string => {
  if (!baseDir) throw new Error("knowledge-source: not configured. Call configure(baseDir) first.")
  return baseDir
}

const userGlobalStore = (): DurableKnowledgeStore => {
  if (!userGlobalCache) userGlobalCache = openUserGlobalStore(ensureBase())
  return userGlobalCache
}

const projectStore = (workspacePath: string): DurableKnowledgeStore => {
  const pid = projectIdForWorkspace(workspacePath)
  let store = projectCache.get(pid)
  if (!store) {
    store = openProjectStore(ensureBase(), workspacePath)
    projectCache.set(pid, store)
  }
  return store
}

export type SourceQuery = {
  readonly types: readonly DocType[]
  readonly domain?: string | null
  readonly keywords?: readonly string[]
  readonly workspacePath?: string // when set, project-shared docs for this workspace are unioned in
  readonly activePackIds?: readonly string[]
  // Tag prefixes to exclude. During the S2 transition the LEARNED query excludes seed/pack-tagged
  // docs ("provenance:deepagent_core", "pack:") so seeded core/domain knowledge — still served
  // in-code until S4 — is not double-injected. Removed once S4 moves core/domain to the store.
  readonly excludeTagPrefixes?: readonly string[]
  readonly limit: number
}

const excluded = (tags: readonly string[], prefixes: readonly string[]): boolean =>
  prefixes.length > 0 && tags.some((t) => prefixes.some((p) => t.startsWith(p)))

// Union user-global + (optional) project-scoped active docs, re-scored and merged. Throws if not
// configured (callers in the retriever catch and degrade to []).
export const queryKnowledge = (query: SourceQuery): readonly ScoredDoc[] => {
  const projectId = query.workspacePath ? projectIdForWorkspace(query.workspacePath) : undefined
  const ug = userGlobalStore().retrieve({
    types: query.types,
    ...(query.domain !== undefined ? { domain: query.domain } : {}),
    ...(query.keywords ? { keywords: query.keywords } : {}),
    ...(query.activePackIds ? { activePackIds: query.activePackIds } : {}),
    limit: query.limit,
  })
  const proj = query.workspacePath
    ? projectStore(query.workspacePath).retrieve({
        types: query.types,
        ...(query.domain !== undefined ? { domain: query.domain } : {}),
        ...(query.keywords ? { keywords: query.keywords } : {}),
        ...(query.activePackIds ? { activePackIds: query.activePackIds } : {}),
        projectId,
        limit: query.limit,
      })
    : []
  const prefixes = query.excludeTagPrefixes ?? []
  // Merge, dedupe by id (user-global wins on tie), drop excluded-tag docs, re-sort.
  const byId = new Map<string, ScoredDoc>()
  for (const s of [...ug, ...proj]) {
    if (excluded(s.doc.tags, prefixes)) continue
    const existing = byId.get(s.doc.id)
    if (!existing || s.score > existing.score) byId.set(s.doc.id, s)
  }
  return [...byId.values()].sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id)).slice(0, query.limit)
}

// --- review-path write helpers (docs/34 §7.3, §9 S3c) ---
// The Review UI operates per-workspace across BOTH durable stores (a candidate may sit in the
// project store from auto-learning, or user-global from a broad promotion). These helpers locate a
// doc by id across both and flip its status, or union the review queue. The gateway must be
// configured first.

// Open the user-global store for direct writes (e.g. persistPromoted). Throws if not configured.
export const userGlobalStoreFor = (): DurableKnowledgeStore => userGlobalStore()

// Open the project store for a workspace path. Throws if not configured.
export const projectStoreFor = (workspacePath: string): DurableKnowledgeStore => projectStore(workspacePath)

// Flip approval across both stores for a workspace; returns true if a matching durable doc was found
// (so the caller can distinguish a real flip from an in-code/no-op id — V3.2.1 P1-2).
export const setApprovalForWorkspace = (
  workspacePath: string,
  id: string,
  status: "pending" | "approved" | "rejected",
): boolean => {
  const proj = projectStore(workspacePath).setApproval(id, status)
  const ug = userGlobalStore().setApproval(id, status)
  return proj || ug
}

// Union the review queue across ALL review-relevant statuses (candidate/active/rejected) for the
// workspace — the Review UI shows all three so an already-approved doc can be revoked (DAP-7 P0-1b).
export const listAllForWorkspace = (workspacePath: string): readonly ReviewItem[] => {
  const out: ReviewItem[] = []
  const seen = new Set<string>()
  for (const status of ["candidate", "active", "rejected"] as const) {
    for (const item of listByStatusForWorkspace(workspacePath, status)) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      out.push(item)
    }
  }
  return out
}
export type ReviewItem = {
  readonly id: string
  readonly type: import("./document-store").DocType
  readonly summary: string
  readonly evidence_strength: import("./document-store").EvidenceStrength
  readonly evidence_refs: readonly string[]
  readonly approval_status: "pending" | "approved" | "rejected"
}

// A built-in seeded pack doc carries a pack id (extensions.pack_id or a "pack:" tag). These are the
// curated, pre-approved domain-pack documents imported by the seeder on every boot — they are NOT
// user-learned candidates. The retriever already excludes them via activePackIds scoping; the Review
// queue must likewise hide them so a fresh install does not surface ~3k "already-approved" seed docs
// as if they were the user's own learned knowledge (V3.6 P0-2). Only genuinely learned docs
// (no pack id) belong in the review queue.
const isSeededPackDoc = (doc: import("./document-store").Doc): boolean => {
  if (typeof doc.extensions?.pack_id === "string" && doc.extensions.pack_id.length > 0) return true
  return doc.tags.some((tag) => tag.startsWith("pack:"))
}

// Union the review queue (a given status) across user-global + this workspace's project store.
// Built-in seeded pack docs are filtered out (see isSeededPackDoc).
export const listByStatusForWorkspace = (
  workspacePath: string,
  status: import("./document-store").DocStatus,
): readonly ReviewItem[] => {
  const seen = new Set<string>()
  const out: ReviewItem[] = []
  const stores = [userGlobalStore(), projectStore(workspacePath)]
  for (const store of stores) {
    for (const ref of store.listByStatus(status)) {
      if (seen.has(ref.id)) continue
      seen.add(ref.id)
      const doc = store.documentStore.get(ref.id)
      if (!doc) continue
      if (isSeededPackDoc(doc)) continue
      out.push({
        id: doc.id,
        type: doc.type,
        summary: doc.description,
        evidence_strength: doc.confidence?.evidence_strength ?? "none",
        evidence_refs: doc.provenance.evidence_refs ?? [],
        approval_status: statusToApproval(doc.status),
      })
    }
  }
  return out
}
