import {
  DurableKnowledgeStore,
  openUserGlobalStore,
  openProjectStore,
  projectIdForWorkspace,
  isVisibleToWorkspace,
  statusToApproval,
  type ScoredDoc,
} from "./durable-knowledge-store"
import {
  DocumentConflictError,
  DocumentRevisionConflictError,
  documentRevision,
  getGovernanceEnvelope,
  governanceFingerprint,
  type Doc,
  type DocType,
  type DocumentStore,
  type GovernanceActor,
} from "./document-store"
import { DeepAgentReleasedSnapshot, SnapshotIntegrityError } from "./released-snapshot"
import { DeepAgentCodeHome } from "./workspace"
import { EnvironmentFactAdoption } from "./environment-fact-adoption"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import path from "node:path"

// V3.2.1 decision B (docs/34 §8): the read-side adapter between the knowledge retriever and the
// durable DocumentStore. Durable knowledge lives in TWO roots under the single injected base
// (Global.Path.agent.data): user-global (public/knowledge, visible everywhere) and per-project
// (project/<pid>/knowledge, project-shared isolation). A retrieval for a workspace UNIONS both.
//
// The configured stores are process-long-lived. All in-process writers use these same handles, so
// changes are immediately visible without rebuilding the disk index. invalidateCache() is reserved
// for explicit cold-reload/testing paths. This module is the ONLY durable read path the retriever uses.

let baseDir: string | null = null
let userGlobalCache: DurableKnowledgeStore | null = null
const projectCache = new Map<string, DurableKnowledgeStore>()
// H32-1: optional shared DocumentStore injected by the gateway so knowledge operations participate
// in the same CAS/SSOT instance as plan/session docs. When null, each store creates its own
// DocumentStore (existing behaviour, backward-compatible).
let sharedDocumentStore: DocumentStore | null = null

// Configure the durable knowledge base dir (the gateway calls this alongside SessionState/MemoryStore
// configure, from the injected baseDir — never a self-resolved home).
// H32-1: optional sharedStore accepted; passed through to openUserGlobalStore/openProjectStore.
export const configure = (dir: string, sharedStore?: DocumentStore): void => {
  const nextBaseDir = path.resolve(dir)
  const nextSharedDocumentStore = sharedStore ?? null
  if (baseDir === nextBaseDir && sharedDocumentStore === nextSharedDocumentStore) return
  baseDir = nextBaseDir
  sharedDocumentStore = nextSharedDocumentStore
  userGlobalCache = null
  projectCache.clear()
}

export const isConfigured = (): boolean => baseDir !== null

export const isConfiguredFor = (dir: string): boolean => baseDir === path.resolve(dir)

// Reset to the unconfigured state (baseDir=null + caches cleared). `configure` is a process-global
// setter with no other way back to null; tests that assert the UNCONFIGURED path (isConfigured()===false
// → callers fall back to empty results) need this to guarantee their precondition regardless of a prior
// test in the same process having called configure(). Not used by production wiring (the gateway only
// ever configures forward).
export const reset = (): void => {
  baseDir = null
  sharedDocumentStore = null
  userGlobalCache = null
  projectCache.clear()
}

// Clear cached stores so a subsequent query re-reads from disk. Normal in-process writes must use
// the cached handles instead; this cold path is only for explicit external-change recovery/tests.
export const invalidateCache = (): void => {
  userGlobalCache = null
  projectCache.clear()
}

const ensureBase = (): string => {
  if (!baseDir) throw new Error("knowledge-source: not configured. Call configure(baseDir) first.")
  return baseDir
}

const userGlobalStore = (): DurableKnowledgeStore => {
  if (!userGlobalCache) userGlobalCache = openUserGlobalStore(ensureBase(), sharedDocumentStore ?? undefined)
  return userGlobalCache
}

const projectStore = (workspacePath: string): DurableKnowledgeStore => {
  const pid = projectIdForWorkspace(workspacePath)
  let store = projectCache.get(pid)
  if (!store) {
    store = openProjectStore(ensureBase(), workspacePath, sharedDocumentStore ?? undefined)
    projectCache.set(pid, store)
  }
  return store
}

// Shared store-union accessor (V3.8 Phase 1, roadmap C5). The ordered set of durable stores a
// workspace query spans — user-global first, then this workspace's project store when a path is
// given — reusing the SAME cached DurableKnowledgeStore instances queryKnowledge uses. Federation and
// human-facing archive adapters read the documentStore getter, while queryKnowledge keeps its own
// retrieve()-based union below. Throws if not configured; callers guard with isConfigured().
export const storesForWorkspace = (workspacePath?: string): readonly DurableKnowledgeStore[] =>
  workspacePath ? [userGlobalStore(), projectStore(workspacePath)] : [userGlobalStore()]

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
  readonly releasedSelection: DeepAgentReleasedSnapshot.Selection
  readonly limit: number
}

export type ReleasedScoredDoc = ScoredDoc & {
  readonly documentRef: DeepAgentReleasedSnapshot.DocumentRef
}

const excluded = (tags: readonly string[], prefixes: readonly string[]): boolean =>
  prefixes.length > 0 && tags.some((t) => prefixes.some((p) => t.startsWith(p)))

// Union user-global + (optional) project-scoped active docs, re-scored and merged. Throws if not
// configured (callers in the retriever catch and degrade to []).
export const queryKnowledge = (query: SourceQuery): readonly ReleasedScoredDoc[] => {
  const projectId = query.workspacePath ? projectIdForWorkspace(query.workspacePath) : undefined
  if (query.releasedSelection.legacyProjectId !== (projectId ?? "global")) {
    throw new SnapshotIntegrityError({
      snapshotId: query.releasedSelection.snapshotId,
      docId: "<selection>",
      reason: `selection project ${query.releasedSelection.legacyProjectId} does not match query project ${projectId ?? "global"}`,
    })
  }
  const project = query.workspacePath ? projectStore(query.workspacePath) : undefined
  const released = validateReleasedSelection(query.releasedSelection, userGlobalStore(), project, projectId)
  const ug = userGlobalStore()
    .retrieve({
      types: query.types,
      ...(query.domain !== undefined ? { domain: query.domain } : {}),
      ...(query.keywords ? { keywords: query.keywords } : {}),
      ...(query.activePackIds ? { activePackIds: query.activePackIds } : {}),
      releasedDocuments: released.userGlobal,
      limit: query.limit,
    })
    .map((result) => ({
      ...result,
      documentRef: DeepAgentReleasedSnapshot.documentRef(result.doc, "user_global"),
    }))
  const proj = project
    ? project
        .retrieve({
          types: query.types,
          ...(query.domain !== undefined ? { domain: query.domain } : {}),
          ...(query.keywords ? { keywords: query.keywords } : {}),
          ...(query.activePackIds ? { activePackIds: query.activePackIds } : {}),
          releasedDocuments: released.project,
          projectId,
          limit: query.limit,
        })
        .map((result) => ({
          ...result,
          documentRef: DeepAgentReleasedSnapshot.documentRef(result.doc, "project"),
        }))
    : []
  const prefixes = query.excludeTagPrefixes ?? []
  // Merge only duplicate observations from the same durable authority. A user-global and a
  // project document may intentionally share the same document id because each store allocates
  // ids independently; collapsing by bare id would silently discard one exact released ref.
  const byAuthority = new Map<string, ReleasedScoredDoc>()
  for (const s of [...ug, ...proj]) {
    if (excluded(s.doc.tags, prefixes)) continue
    const authorityKey = `${s.documentRef.sourceStore}:${s.documentRef.id}`
    const existing = byAuthority.get(authorityKey)
    if (!existing || s.score > existing.score) byAuthority.set(authorityKey, s)
  }
  return [...byAuthority.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.documentRef.sourceStore.localeCompare(b.documentRef.sourceStore) ||
        a.doc.id.localeCompare(b.doc.id),
    )
    .slice(0, query.limit)
}

function validateReleasedSelection(
  selection: DeepAgentReleasedSnapshot.Selection,
  userGlobal: DurableKnowledgeStore,
  project: DurableKnowledgeStore | undefined,
  projectId: string | undefined,
) {
  const validate = (sourceStore: "user_global" | "project", store: DurableKnowledgeStore | undefined) =>
    selection.documents
      .filter((ref) => ref.sourceStore === sourceStore)
      .map((ref) => {
        const doc = store?.documentStore.get(ref.id, ref.version)
        if (
          !doc ||
          doc.hash !== ref.hash ||
          doc.type !== ref.type ||
          doc.scope !== ref.scope ||
          !isVisibleToWorkspace(doc, projectId)
        ) {
          throw new SnapshotIntegrityError({
            snapshotId: selection.snapshotId,
            docId: ref.id,
            reason: !doc
              ? `${sourceStore} document revision is missing`
              : "document hash, type, scope, or workspace visibility does not match the released snapshot",
          })
        }
        return ref
      })
  return {
    userGlobal: validate("user_global", userGlobal),
    project: validate("project", project),
  }
}

// --- review-path write helpers (docs/34 §7.3, §9 S3c) ---
// The Review UI operates per-workspace across BOTH durable stores (a candidate may sit in the
// project store from auto-learning, or user-global from a broad promotion). These helpers locate a
// doc by id across both and flip its status, or union the review queue. The gateway must be
// configured first.

// Open the user-global store for direct writes (e.g. persistPromoted). Throws if not configured.
export const userGlobalStoreFor = (): DurableKnowledgeStore => userGlobalStore()

// --- V3.8.1 §G environment-fact use-gate adapter ----------------------------------------------
// Build the per-project use-gate service for a workspace, rooted at the same injected baseDir the
// retriever reads. Kept here (the single configured durable adapter) so the HTTP handler never
// self-resolves a home. Throws if not configured (callers guard with isConfigured()).
export const environmentFactAdoptionFor = (workspacePath: string): EnvironmentFactAdoption => {
  const base = ensureBase()
  const home = new DeepAgentCodeHome(base)
  const paths = home.ensureProject(projectIdForWorkspace(workspacePath), workspacePath)
  return new EnvironmentFactAdoption(base, paths, workspacePath, {
    userGlobal: userGlobalStore(),
    project: projectStore(workspacePath),
  })
}

// Open the project store for a workspace path. Throws if not configured.
export const projectStoreFor = (workspacePath: string): DurableKnowledgeStore => projectStore(workspacePath)

// Union the review queue across ALL review-relevant statuses (candidate/active/rejected) for the
// workspace — the Review UI shows all three so an already-approved doc can be revoked (DAP-7 P0-1b).
export const listAllForWorkspace = (workspacePath: string): readonly ReviewItem[] => {
  const out: ReviewItem[] = []
  const seen = new Set<string>()
  for (const status of ["candidate", "active", "rejected"] as const) {
    for (const item of listByStatusForWorkspace(workspacePath, status)) {
      const authorityKey = `${item.sourceStore}:${item.id}`
      if (seen.has(authorityKey)) continue
      seen.add(authorityKey)
      out.push(item)
    }
  }
  return out
}

export const reviewSummaryForWorkspace = (workspacePath: string): { readonly pendingCount: number } => ({
  pendingCount: listByStatusForWorkspace(workspacePath, "candidate").filter((item) => item.type !== "skill").length,
})
export type ReviewItem = {
  readonly sourceStore: "user_global" | "project"
  readonly id: string
  readonly version: number
  readonly hash: string
  readonly candidateId: string
  readonly fingerprint: string
  readonly governanceRevision: string
  readonly type: import("./document-store").DocType
  readonly summary: string
  readonly evidence_strength: import("./document-store").EvidenceStrength
  readonly evidence_refs: readonly string[]
  readonly approval_status: "pending" | "approved" | "rejected"
  // The doc's storage scope, so the Review UI can group by project vs global:
  //   "durable" (or legacy untagged)  → user-global bucket
  //   "durable:project:<project_id>"  → that project's bucket
  readonly scope: string
}

export type ReviewAuthority = Pick<
  ReviewItem,
  "sourceStore" | "id" | "version" | "hash" | "candidateId" | "fingerprint" | "governanceRevision"
>

export class ReviewAuthorityConflictError extends Error {
  readonly _tag = "ReviewAuthorityConflictError"
  constructor(readonly detail: string) {
    super(`knowledge review authority conflict: ${detail}`)
    this.name = "ReviewAuthorityConflictError"
  }
}

export const commitReviewDecisionForWorkspace = (
  workspacePath: string,
  expected: ReviewAuthority,
  decision: "approve" | "reject",
  actor: GovernanceActor,
): ReviewItem => {
  const store = expected.sourceStore === "user_global" ? userGlobalStore() : projectStore(workspacePath)
  const current = store.documentStore.get(expected.id)
  if (!current) throw new ReviewAuthorityConflictError(`${expected.sourceStore}:${expected.id} is missing`)
  const actual = reviewAuthority(expected.sourceStore, current)
  if (!sameReviewAuthority(expected, actual)) {
    if (decision === "reject" && isExactRejectReplay(store.documentStore, expected, current, actor)) {
      return reviewItem(expected.sourceStore, current)
    }
    throw new ReviewAuthorityConflictError(
      `${expected.sourceStore}:${expected.id} changed since it was listed; refresh the review queue`,
    )
  }
  try {
    return reviewItem(
      expected.sourceStore,
      decision === "approve"
        ? store.approveCandidate(current.id, documentRevision(current), actor, { fingerprint: expected.fingerprint })
        : store.rejectCandidate(current.id, documentRevision(current), actor, "human review rejected", {
            fingerprint: expected.fingerprint,
          }),
    )
  } catch (error) {
    if (error instanceof DocumentConflictError || error instanceof DocumentRevisionConflictError)
      throw new ReviewAuthorityConflictError(
        `${expected.sourceStore}:${expected.id} changed while the decision was committing; refresh the review queue`,
      )
    throw error
  }
}

function isExactRejectReplay(
  store: DocumentStore,
  expected: ReviewAuthority,
  current: Doc,
  actor: GovernanceActor,
) {
  const original = store.get(expected.id, expected.version)
  const governance = getGovernanceEnvelope(current)
  return (
    original !== null &&
    sameReviewAuthority(expected, reviewAuthority(expected.sourceStore, original)) &&
    current.version === expected.version + 1 &&
    current.status === "rejected" &&
    governance?.review_status === "rejected" &&
    governance.fingerprint === expected.fingerprint &&
    governance.actor_type === actor.type &&
    governance.actor_id === actor.id &&
    governance.reason === "human review rejected" &&
    governance.source_doc_ref === `${expected.id}@v${expected.version}`
  )
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
  const stores = [
    { sourceStore: "user_global" as const, store: userGlobalStore() },
    { sourceStore: "project" as const, store: projectStore(workspacePath) },
  ]
  for (const entry of stores) {
    const store = entry.store
    for (const ref of store.listByStatus(status)) {
      const authorityKey = `${entry.sourceStore}:${ref.id}`
      if (seen.has(authorityKey)) continue
      seen.add(authorityKey)
      const doc = store.documentStore.get(ref.id, ref.version)
      if (!doc) continue
      if (isSeededPackDoc(doc)) continue
      out.push(reviewItem(entry.sourceStore, doc))
    }
  }
  return out
}

const reviewItem = (sourceStore: ReviewAuthority["sourceStore"], doc: Doc): ReviewItem => ({
  ...reviewAuthority(sourceStore, doc),
  type: doc.type,
  summary: doc.description,
  evidence_strength: doc.confidence?.evidence_strength ?? "none",
  evidence_refs: doc.provenance.evidence_refs ?? [],
  approval_status: statusToApproval(doc.status),
  scope: doc.scope,
})

const reviewAuthority = (sourceStore: ReviewAuthority["sourceStore"], doc: Doc): ReviewAuthority => {
  const governance = getGovernanceEnvelope(doc)
  const candidateId =
    governance?.candidate_id ??
    (typeof doc.extensions?.candidate_id === "string" ? doc.extensions.candidate_id : doc.id)
  const fingerprint = governance?.fingerprint ?? governanceFingerprint(doc)
  return {
    sourceStore,
    id: doc.id,
    version: doc.version,
    hash: doc.hash,
    candidateId,
    fingerprint,
    governanceRevision: Hash.sha256(
      CanonicalJson.stringify({
        sourceStore,
        id: doc.id,
        status: doc.status,
        candidateId,
        fingerprint,
        governance: governance ?? null,
      }),
    ),
  }
}

const sameReviewAuthority = (expected: ReviewAuthority, actual: ReviewAuthority) =>
  expected.sourceStore === actual.sourceStore &&
  expected.id === actual.id &&
  expected.version === actual.version &&
  expected.hash === actual.hash &&
  expected.candidateId === actual.candidateId &&
  expected.fingerprint === actual.fingerprint &&
  expected.governanceRevision === actual.governanceRevision
