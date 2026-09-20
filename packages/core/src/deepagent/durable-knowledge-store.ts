import {
  DocumentConflictError,
  DocumentStore,
  documentRevision,
  getGovernanceEnvelope,
  type Doc,
  type DocRef,
  type DocStatus,
  type DocType,
  type DocLink,
  type Confidence,
  type DocumentRevision,
  type GovernanceActor,
  type Provenance,
  type EvidenceStrength,
} from "./document-store"
import path from "node:path"
import { createHash } from "node:crypto"
import type { DocumentRef as ReleasedDocumentRef } from "./released-snapshot"
import { CanonicalJson } from "../util/canonical-json"
import { readonlySet } from "../util/readonly-collections"

// V3.2.1 decision B (docs/34 §7-§8): the SINGLE durable-knowledge body is the DocumentStore.
// This facade is the ONLY durable read/write entry for domain knowledge — it replaces the retired
// memory-store + ProjectMemoryIndex. Workspace isolation is by SCOPE string + project_id, never by
// separate stores. Accessibility is the latest immutable governance revision on the SAME document
// identity. Review decisions append vN+1 with expected-revision CAS; they never move/copy the body
// into a second store and never overwrite a prior revision.

// Knowledge-class doc types the retriever may surface. anti_pattern is NOT here: failed patterns
// live as `failure_dossier` and only ever feed do_not_use / blocked refs (docs/34 §2.1, DAP-12).
// The V3.8 Phase 0 types code_symbol/ledger/bridge are deliberately NOT here (roadmap C3, decision
// #4): they are non-knowledge derived data, so retrieve()'s whitelist (line ~212) must keep filtering
// them out — the shared GraphQuery service (Phase 1) reaches them via the documentStore getter, not
// retrieve(). Adding them here would leak derived data into knowledge retrieval; do not add.
export const KNOWLEDGE_DOC_TYPES = readonlySet(new Set<DocType>([
  "knowledge",
  "strategy",
  "methodology",
  "memory",
  "skill",
]))

export type KnowledgeScope = "user-global" | "project-shared" | "session-private"
export type Sensitivity = "public" | "source_code" | "pii" | "secret_adjacent" | "secret"
export type RiskLevel = "low" | "medium" | "high" | "regulated"

// V3.1 approval_status <-> DocStatus mapping (docs/34 §7.3). isApproved collapses to status==="active".
export type ApprovalStatus = "pending" | "approved" | "rejected"
export const statusToApproval = (status: DocStatus): ApprovalStatus =>
  status === "active" ? "approved" : status === "rejected" ? "rejected" : "pending"

export type KnowledgeDocInput = {
  readonly type: DocType // must be in KNOWLEDGE_DOC_TYPES (or failure_dossier for negative knowledge)
  readonly description: string // legacy "summary"
  readonly body: string
  readonly domain: string | null
  readonly tags?: readonly string[]
  readonly packId?: string
  readonly scope: KnowledgeScope
  readonly projectId?: string // required for project-shared
  readonly sensitivity: Sensitivity
  readonly risk: RiskLevel
  readonly confidence: Confidence
  readonly provenance: Provenance
  readonly links?: readonly DocLink[]
  readonly idSlug?: string
  readonly createdRound?: number | null
}

export type KnowledgeQuery = {
  readonly types: readonly DocType[]
  readonly domain?: string | null
  readonly tags?: readonly string[]
  readonly keywords?: readonly string[]
  readonly projectId?: string // workspace-visibility filter
  readonly activePackIds?: readonly string[]
  readonly releasedDocuments?: readonly ReleasedDocumentRef[]
  readonly limit?: number
}

export type ScoredDoc = { readonly doc: Doc; readonly score: number }

export class CandidateIdentityConflictError extends Error {
  readonly _tag = "CandidateIdentityConflictError"
  constructor(
    readonly candidateId: string,
    readonly detail: string,
  ) {
    super(`DurableKnowledgeStore candidate identity conflict for ${candidateId}: ${detail}`)
    this.name = "CandidateIdentityConflictError"
  }
}

// Scope string encoding on the durable doc (docs/34 §7.2):
//   user-global    -> "durable"
//   project-shared -> "durable:project:<project_id>"
//   session-private -> NOT stored here (stays run-scope); rejected at stage time.
const DURABLE = "durable"
const projectScope = (projectId: string): string => `${DURABLE}:project:${projectId}`

export const scopeStringFor = (scope: KnowledgeScope, projectId?: string): string => {
  if (scope === "session-private") {
    throw new Error("DurableKnowledgeStore: session-private knowledge is not durable (keep it run-scope)")
  }
  if (scope === "project-shared") {
    if (!projectId) throw new Error("DurableKnowledgeStore: project-shared requires projectId")
    return projectScope(projectId)
  }
  return DURABLE
}

// A durable doc is visible to a workspace when it is user-global (scope==="durable") or it is
// project-shared for THIS project. session/sealed are never visible. Untagged/legacy is treated as
// user-global. This is the single read/write-agreed visibility rule (docs/34 §8.1).
export const isVisibleToWorkspace = (doc: Doc, projectId?: string): boolean => {
  if (doc.scope === "sealed") return false
  if (doc.scope === DURABLE) return true
  if (doc.scope.startsWith(`${DURABLE}:project:`))
    return projectId !== undefined && doc.scope === projectScope(projectId)
  return false
}

// Keyword-adjusted relevance over a doc's description, clamped to [0,1] (mirrors the prior
// memory-store searchScored so retriever thresholds compose unchanged, docs/34 §8.4).
const scoreDoc = (doc: Doc, query: KnowledgeQuery): number => {
  let score = doc.confidence?.evidence_strength ? EVIDENCE_BASE[doc.confidence.evidence_strength] : 0.5
  const haystack = `${doc.description} ${doc.tags.join(" ")}`.toLowerCase()
  const keywords = (query.keywords ?? []).map((k) => k.toLowerCase()).filter((k) => k.length > 0)
  if (keywords.length > 0) {
    let hits = 0
    for (const kw of keywords) if (haystack.includes(kw)) hits++
    score += hits > 0 ? 0.1 * hits : -0.5
  }
  if (query.domain && doc.domain && doc.domain.toLowerCase() === query.domain.toLowerCase()) score += 0.2
  return Math.max(0, Math.min(1, score))
}

const EVIDENCE_BASE: Record<EvidenceStrength, number> = { strong: 0.9, medium: 0.7, weak: 0.5, none: 0.2 }

export class DurableKnowledgeStore {
  private readonly store: DocumentStore

  // root is a per-workspace durable knowledge dir (<...>/project/<pid>/knowledge) OR the user-global
  // dir (<...>/public/knowledge). The caller wires the correct root from Global.Path.agent.data; this
  // class never self-resolves a home (docs/34 §7.2; no-parallel-impl guard).
  //
  // H32-1 (v4.0.4): accepts an OPTIONAL shared DocumentStore instance. When supplied, that instance is
  // used directly (enabling CAS/SSOT participation with the rest of the system). When omitted, a new
  // isolated DocumentStore is created as before (backward-compatible; tests and callers that don't yet
  // pass a shared handle continue working).
  constructor(root: string, sharedStore?: DocumentStore) {
    this.store = sharedStore ?? new DocumentStore(root)
  }

  // Underlying store escape hatch for run-graph/integrity callers (read-only intent).
  get documentStore(): DocumentStore {
    return this.store
  }

  // Stage a candidate. Status is ALWAYS "candidate" — durable knowledge can never be written
  // directly as active (DAP-8). The scope string carries workspace isolation; pack/risk/sensitivity
  // travel as tags + extensions so the rebuildable index can project them.
  stageCandidate(
    input: KnowledgeDocInput,
    options: { readonly allowActiveReinforcement?: boolean; readonly requireExactCandidate?: boolean } = {},
  ): Doc {
    const scope = scopeStringFor(input.scope, input.projectId)
    if (options.requireExactCandidate && input.idSlug) {
      const exact = this.exactCandidate(input, scope)
      if (exact) return this.completeExactCandidateStage(exact)
    }
    // Dedup-and-merge: if an equivalent (exact logical match) or near-duplicate ("same point,
    // different wording") non-rejected knowledge doc already exists, reinforce it (bump
    // support_count + raise evidence_strength) instead of creating a duplicate row. Without this the
    // self-learning write path created a fresh row for every run, flooding the durable store with
    // near-identical knowledge. RejectedBuffer still blocks re-learning rejected patterns upstream.
    const existing = this.store.findSimilarKnowledge({
      type: input.type,
      scope,
      domain: input.domain ?? null,
      description: input.description,
    })
    if (existing && options.requireExactCandidate) {
      throw new CandidateIdentityConflictError(
        input.idSlug ?? input.description,
        `near-duplicate candidate ${existing.id} is bound to ${String(existing.extensions?.candidate_id ?? "legacy")}`,
      )
    }
    if (existing && (existing.status !== "active" || options.allowActiveReinforcement !== false))
      return this.store.reinforceConfidence(existing.id, input.confidence)

    return this.createCandidate(input, scope)
  }

  stageReviewCandidate(input: KnowledgeDocInput): Doc {
    const scope = scopeStringFor(input.scope, input.projectId)
    if (!input.idSlug) throw new CandidateIdentityConflictError(input.description, "review candidate requires an ID")
    const exact = this.exactCandidate(input, scope)
    if (exact) return this.completeExactCandidateStage(exact)
    return this.createCandidate(input, scope)
  }

  private createCandidate(input: KnowledgeDocInput, scope: string): Doc {
    const tags = dedupeTags([
      ...(input.tags ?? []),
      ...(input.packId ? [`pack:${input.packId}`] : []),
      `risk:${input.risk}`,
      `sensitivity:${input.sensitivity}`,
    ])
    const doc = this.store.create({
      type: input.type,
      scope,
      body: input.body,
      description: input.description,
      domain: input.domain,
      tags,
      links: input.links ?? [],
      provenance: input.provenance,
      confidence: input.confidence,
      createdRound: input.createdRound ?? null,
      ...(input.idSlug ? { idSlug: input.idSlug } : {}),
      extensions: {
        ...(input.idSlug ? { candidate_id: input.idSlug } : {}),
        pack_id: input.packId ?? null,
        risk: input.risk,
        sensitivity: input.sensitivity,
        knowledge_scope: input.scope,
        ...(input.projectId ? { project_id: input.projectId } : {}),
      },
    })
    return this.store.commitGovernance(doc.id, documentRevision(doc), {
      kind: "stage",
      actor: { type: "system", id: "durable-knowledge-store" },
    })
  }

  private exactCandidate(input: KnowledgeDocInput, scope: string): Doc | null {
    const documents = this.store
      .list({ type: input.type, scope })
      .map((ref) => this.store.get(ref.id))
      .filter((doc): doc is Doc => doc !== null)
      .filter((doc) => doc.extensions?.candidate_id === input.idSlug)
    if (documents.length > 1)
      throw new CandidateIdentityConflictError(input.idSlug!, "candidate ID resolves to multiple documents")
    const exact = documents[0]
    if (!exact) return null
    const expectedTags = dedupeTags([
      ...(input.tags ?? []),
      ...(input.packId ? [`pack:${input.packId}`] : []),
      `risk:${input.risk}`,
      `sensitivity:${input.sensitivity}`,
    ])
    const matches =
      exact.type === input.type &&
      exact.scope === scope &&
      exact.body === input.body &&
      exact.description === input.description &&
      exact.domain === input.domain &&
      JSON.stringify(exact.tags) === JSON.stringify(expectedTags) &&
      JSON.stringify(exact.links) === JSON.stringify(input.links ?? []) &&
      JSON.stringify(exact.provenance) === JSON.stringify(input.provenance) &&
      JSON.stringify(exact.confidence) === JSON.stringify(input.confidence) &&
      exact.created_round === (input.createdRound ?? null) &&
      exact.extensions?.pack_id === (input.packId ?? null) &&
      exact.extensions?.risk === input.risk &&
      exact.extensions?.sensitivity === input.sensitivity &&
      exact.extensions?.knowledge_scope === input.scope &&
      exact.extensions?.project_id === input.projectId
    if (!matches)
      throw new CandidateIdentityConflictError(input.idSlug!, `${exact.id}@v${exact.version} has different material`)
    return exact
  }

  private completeExactCandidateStage(doc: Doc): Doc {
    if (doc.status === "candidate" && getGovernanceEnvelope(doc)?.review_status === "pending") return doc
    if (doc.status !== "draft")
      throw new CandidateIdentityConflictError(
        String(doc.extensions?.candidate_id),
        `${doc.id}@v${doc.version} is already ${doc.status}`,
      )
    try {
      return this.store.commitGovernance(doc.id, documentRevision(doc), {
        kind: "stage",
        actor: { type: "system", id: "durable-knowledge-store" },
      })
    } catch (error) {
      if (!(error instanceof DocumentConflictError)) throw error
      const current = this.store.get(doc.id)
      if (current?.status === "candidate" && getGovernanceEnvelope(current)?.review_status === "pending") return current
      throw error
    }
  }

  autoAdmitExactCandidate(
    input: KnowledgeDocInput,
    actor: GovernanceActor,
    options: { readonly reviewRef: string; readonly transitionedAt?: number },
  ): Doc {
    const exact = input.idSlug ? this.exactCandidate(input, scopeStringFor(input.scope, input.projectId)) : null
    if (exact?.status === "active") {
      const governance = getGovernanceEnvelope(exact)
      if (
        governance?.review_status === "approved" &&
        governance.actor_type === actor.type &&
        governance.actor_id === actor.id &&
        governance.review_ref === options.reviewRef
      )
        return exact
      throw new CandidateIdentityConflictError(input.idSlug!, `${exact.id}@v${exact.version} has another approval`)
    }
    const staged = this.stageCandidate(input, { allowActiveReinforcement: false, requireExactCandidate: true })
    return this.approveCandidate(staged.id, documentRevision(staged), actor, options)
  }

  approveCandidate(
    id: string,
    expected: DocumentRevision,
    actor: GovernanceActor,
    options: { readonly fingerprint?: string; readonly reviewRef?: string; readonly transitionedAt?: number } = {},
  ): Doc {
    return this.store.commitGovernance(id, expected, {
      kind: "approve",
      actor,
      ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
      ...(options.reviewRef ? { reviewRef: options.reviewRef } : {}),
      ...(options.transitionedAt !== undefined ? { transitionedAt: options.transitionedAt } : {}),
    })
  }

  rejectCandidate(
    id: string,
    expected: DocumentRevision,
    actor: GovernanceActor,
    reason: string,
    options: { readonly fingerprint?: string; readonly reviewRef?: string; readonly transitionedAt?: number } = {},
  ): Doc {
    return this.store.commitGovernance(id, expected, {
      kind: "reject",
      actor,
      reason,
      ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
      ...(options.reviewRef ? { reviewRef: options.reviewRef } : {}),
      ...(options.transitionedAt !== undefined ? { transitionedAt: options.transitionedAt } : {}),
    })
  }

  compensateGovernanceAction(
    input: KnowledgeDocInput,
    result: { readonly ref: string; readonly hash: string } | undefined,
    options: { readonly planId: string; readonly actionId: string; readonly transitionedAt?: number },
  ): { readonly ref: string; readonly hash: string } {
    const match = result ? /^(.*)@v([1-9][0-9]*)$/.exec(result.ref) : undefined
    if (result && !match) throw new CandidateIdentityConflictError(result.ref, "governance result ref is invalid")
    const source = match
      ? this.store.get(match[1]!, Number(match[2]))
      : input.idSlug
        ? this.exactCandidate(input, scopeStringFor(input.scope, input.projectId))
        : null
    if (!source) {
      const content = CanonicalJson.stringify({
        candidate_id: input.idSlug,
        state: "absent",
        plan_id: options.planId,
        action_id: options.actionId,
      })
      const hash = createHash("sha256").update(content).digest("hex")
      return { ref: `learning-compensation-absent:${hash}`, hash }
    }
    if (result && createHash("sha256").update(CanonicalJson.stringify(source)).digest("hex") !== result.hash)
      throw new CandidateIdentityConflictError(result.ref, "governance result material is missing or changed")
    const current = this.store.get(source.id)
    const compensationRef = `learning-compensation:${options.planId}:${options.actionId}`
    if (current?.status === "quarantined") {
      const governance = getGovernanceEnvelope(current)
      if (
        governance?.actor_type === "system" &&
        governance.actor_id === "durable-learning-compensation" &&
        governance.review_ref === compensationRef &&
        governance.source_doc_ref === `${source.id}@v${source.version}`
      )
        return {
          ref: `${current.id}@v${current.version}`,
          hash: createHash("sha256").update(CanonicalJson.stringify(current)).digest("hex"),
        }
    }
    if (!current || current.version !== source.version || current.hash !== source.hash)
      throw new CandidateIdentityConflictError(
        result?.ref ?? input.idSlug ?? input.description,
        "governance result was advanced before compensation",
      )
    const quarantined = this.store.commitGovernance(source.id, documentRevision(source), {
      kind: "quarantine",
      actor: { type: "system", id: "durable-learning-compensation" },
      reason: "governance plan failed after this action settled",
      reviewRef: compensationRef,
      ...(options.transitionedAt === undefined ? {} : { transitionedAt: options.transitionedAt }),
    })
    return {
      ref: `${quarantined.id}@v${quarantined.version}`,
      hash: createHash("sha256").update(CanonicalJson.stringify(quarantined)).digest("hex"),
    }
  }

  findCandidate(candidateId: string, type: DocType, summary: string): Doc | null {
    const docs = this.store
      .list({ type })
      .map((ref) => this.store.get(ref.id))
      .filter((doc): doc is Doc => doc !== null)
      .filter((doc) => {
        const materialMatches = doc.description === summary && doc.body === summary
        if (doc.extensions?.candidate_id !== undefined)
          return doc.extensions.candidate_id === candidateId && materialMatches
        return materialMatches && doc.tags.includes("learned")
      })
    if (docs.length > 1) throw new Error(`findCandidate: ambiguous durable candidate ${candidateId}`)
    return docs[0] ?? null
  }

  // Compatibility adapters read the current revision and immediately delegate to strict CAS.
  // New governance callers should use approveCandidate/rejectCandidate with a captured revision.
  approve(id: string): boolean {
    const doc = this.store.get(id)
    if (!doc) return false
    this.approveCandidate(id, documentRevision(doc), { type: "system", id: "legacy-approve-adapter" })
    return true
  }
  reject(id: string): boolean {
    const doc = this.store.get(id)
    if (!doc) return false
    this.rejectCandidate(id, documentRevision(doc), { type: "system", id: "legacy-reject-adapter" }, "legacy rejection")
    return true
  }
  setApproval(id: string, status: ApprovalStatus): boolean {
    const doc = this.store.get(id)
    if (!doc) return false
    if (status === "approved") {
      this.approveCandidate(id, documentRevision(doc), { type: "system", id: "legacy-approval-adapter" })
      return true
    }
    if (status === "rejected") {
      this.rejectCandidate(
        id,
        documentRevision(doc),
        { type: "system", id: "legacy-approval-adapter" },
        "legacy rejection",
      )
      return true
    }
    this.store.commitGovernance(id, documentRevision(doc), {
      kind: "stage",
      actor: { type: "system", id: "legacy-approval-adapter" },
    })
    return true
  }

  isApproved(id: string): boolean {
    const doc = this.store.get(id)
    return doc?.status === "active"
  }

  // Retrieve only active, workspace-visible, non-sealed knowledge docs of the requested types,
  // scored + sorted with a stable id tiebreaker, capped to limit (docs/34 §8.1/§8.4).
  retrieve(query: KnowledgeQuery): readonly ScoredDoc[] {
    const wanted = new Set(query.types.filter((t) => KNOWLEDGE_DOC_TYPES.has(t)))
    const scored: ScoredDoc[] = []
    const documents = query.releasedDocuments
      ? query.releasedDocuments
          .map((ref) => this.store.get(ref.id, ref.version))
          .filter((doc): doc is Doc => doc !== null)
      : this.store
          .list({ status: "active" })
          .map((ref) => this.store.get(ref.id))
          .filter((doc): doc is Doc => doc !== null)
    for (const doc of documents) {
      if (!wanted.has(doc.type)) continue
      if (!doc) continue
      if (!isVisibleToWorkspace(doc, query.projectId)) continue
      if (query.activePackIds && query.activePackIds.length > 0) {
        const packId =
          typeof doc.extensions?.pack_id === "string"
            ? doc.extensions.pack_id
            : (doc.tags.find((tag) => tag.startsWith("pack:"))?.slice("pack:".length) ?? null)
        if (packId && !query.activePackIds.includes(packId)) continue
      }
      if (query.domain !== undefined && query.domain !== null && doc.domain !== null && doc.domain !== query.domain) {
        // domain mismatch only filters when both sides are concrete; null domain = domain-agnostic.
        continue
      }
      const score = scoreDoc(doc, query)
      if (score > 0) scored.push({ doc, score })
    }
    scored.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
    return query.limit === undefined ? scored : scored.slice(0, query.limit)
  }

  // Review queue source: list refs by status, optionally narrowed to a workspace scope.
  listByStatus(status: DocStatus, scope?: KnowledgeScope, projectId?: string): readonly DocRef[] {
    const refs = this.store.list({ status })
    if (!scope) return refs
    const want = scope === "session-private" ? null : scopeStringFor(scope, projectId)
    if (want === null) return []
    return refs.filter((r) => r.scope === want)
  }

  hasRejectedFingerprint(fingerprint: string): boolean {
    return this.store
      .list({ status: "rejected" })
      .some((ref) => getGovernanceEnvelope(this.store.get(ref.id, ref.version)!)?.fingerprint === fingerprint)
  }

  // Load a doc body on demand (progressive disclosure). The caller is responsible for recording the
  // load in the run graph (docs/34 §8.1, DAP-6); this returns the body or null for unknown id.
  loadBody(id: string): string | null {
    return this.store.get(id)?.body ?? null
  }

  // --- V3.8.1 §G environment-fact fast path -----------------------------------------------------
  // Write an already-desensitized environment_fact straight to user-global `provisional` WITHOUT
  // human review (§G.4). This intentionally does NOT go through stageCandidate/approve: environment
  // facts are non-knowledge, credential-free operational facts that must NOT be silently injected
  // (provisional is excluded from retrieve()); each project adopts them at the use-gate (§G.5).
  // The caller (governance/handler) MUST have run environment-fact.decideFastPath first — this method
  // trusts that the body carries no credential values (only secret_ref pointers).
  stageProvisionalEnvironmentFact(input: {
    readonly description: string
    readonly body: string // serialized EnvironmentFactBody (already desensitized)
    readonly domain?: string | null
    readonly tags?: readonly string[]
    readonly provenance: Provenance
    readonly idSlug?: string
  }): Doc {
    // Idempotent on (description, domain): re-declaring the same fact updates in place instead of
    // piling up rows. environment_fact is derived/operational data, so an in-place body update is the
    // right semantic (mirrors seedActive's upsert intent, but lands at `provisional`, not `active`).
    const doc = this.store.upsert({
      type: "environment_fact",
      scope: DURABLE, // user-global; a project makes it usable by adopting, not by re-scoping
      body: input.body,
      description: input.description,
      domain: input.domain ?? null,
      tags: dedupeTags([...(input.tags ?? []), "provenance:environment_fact"]),
      provenance: input.provenance,
      ...(input.idSlug ? { idSlug: input.idSlug } : {}),
    })
    if (doc.status !== "provisional") return this.store.setStatus(doc.id, "provisional", documentRevision(doc))
    return doc
  }

  // List the user-global provisional environment facts (the use-gate's candidate set). `active` facts
  // (confirmed via human review) and `stale` (connect-failed) are surfaced via listByStatusForType.
  listProvisionalEnvironmentFacts(): readonly DocRef[] {
    return this.store.list({ type: "environment_fact", status: "provisional" })
  }

  // List docs of a given type at a given status (the use-gate unions provisional + active + the
  // quarantined/stale facts so a degraded fact is still shown with a warning, §G.5/§G.6).
  listByStatusForType(status: DocStatus, type: DocType): readonly DocRef[] {
    return this.store.list({ type, status })
  }

  // §G.6: mark an environment_fact stale (e.g. a project's adopted fact failed to connect). We reuse
  // the existing `quarantined` status as the machine-readable "degraded / do not trust silently"
  // flag rather than introducing yet another DocStatus. A quarantined fact still lists (unlike
  // sealed), so the use-gate can render the "last connect failed" warning (§G.6). Returns false for
  // an unknown id or a non-environment_fact doc.
  markEnvironmentFactStale(id: string): boolean {
    const doc = this.store.get(id)
    if (!doc || doc.type !== "environment_fact") return false
    this.store.setStatus(id, "quarantined", documentRevision(doc))
    return true
  }

  // Seed a curated, pre-approved knowledge doc straight to status=active. This is ONLY for the
  // in-code knowledge body imported at build/migration time (docs/34 S1) — NOT a runtime path. The
  // "candidates must be pending" rule (DAP-8) governs learning writeback, not the trusted seed.
  // Idempotent: a seed with a deterministic idSlug that already exists is updated in place (same id),
  // never duplicated, so re-running the seeder is safe.
  seedActive(input: KnowledgeDocInput): Doc {
    const scope = scopeStringFor(input.scope, input.projectId)
    const tags = dedupeTags([
      ...(input.tags ?? []),
      ...(input.packId ? [`pack:${input.packId}`] : []),
      `risk:${input.risk}`,
      `sensitivity:${input.sensitivity}`,
    ])
    return this.store.seedActive({
      type: input.type,
      scope,
      body: input.body,
      description: input.description,
      domain: input.domain,
      tags,
      links: input.links ?? [],
      provenance: input.provenance,
      confidence: input.confidence,
      createdRound: input.createdRound ?? null,
      ...(input.idSlug ? { idSlug: input.idSlug } : {}),
      extensions: {
        pack_id: input.packId ?? null,
        risk: input.risk,
        sensitivity: input.sensitivity,
        knowledge_scope: input.scope,
        ...(input.projectId ? { project_id: input.projectId } : {}),
      },
    })
  }
}

const dedupeTags = (tags: readonly string[]): string[] => [...new Set(tags.filter((t) => t.length > 0))]

// --- root resolution (docs/34 §7.2) ---
// Durable knowledge lives in TWO durable DocumentStore roots, both rooted under the SINGLE injected
// storage base (Global.Path.agent.data). This module NEVER self-resolves a home: callers pass
// baseDir, mirroring config.ts (no `new DeepAgentCodeHome()` / `dirname(runsDir)` inference —
// no-parallel-impl + no-write-to-real-home guards).
//
//   user-global  -> <baseDir>/public/knowledge          (visible to every workspace)
//   project      -> <baseDir>/project/<project_id>/knowledge  (project-shared isolation)

export const userGlobalKnowledgeRoot = (baseDir: string): string => path.join(baseDir, "public", "knowledge")

export const projectKnowledgeRoot = (baseDir: string, projectId: string): string =>
  path.join(baseDir, "project", projectId, "knowledge")

// Canonical project-id derivation (single source; stable per absolute workspace path). The write
// side tags durable docs with this and the read side filters against it — both MUST agree, so every
// caller (gateway/orchestrator/prompt/routes) derives it here instead of re-hashing.
export const projectIdForWorkspace = (workspacePath: string): string =>
  `project_${createHash("sha256").update(workspacePath).digest("hex").slice(0, 16)}`

// Open the project-scoped durable store for a workspace path.
// H32-1: accepts an optional shared DocumentStore instance for CAS/SSOT participation.
export const openProjectStore = (
  baseDir: string,
  workspacePath: string,
  sharedStore?: DocumentStore,
): DurableKnowledgeStore =>
  new DurableKnowledgeStore(projectKnowledgeRoot(baseDir, projectIdForWorkspace(workspacePath)), sharedStore)

// Open the user-global durable store.
// H32-1: accepts an optional shared DocumentStore instance for CAS/SSOT participation.
export const openUserGlobalStore = (baseDir: string, sharedStore?: DocumentStore): DurableKnowledgeStore =>
  new DurableKnowledgeStore(userGlobalKnowledgeRoot(baseDir), sharedStore)
