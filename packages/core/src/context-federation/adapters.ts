export * as ContextAdapters from "./adapters"

import { Effect } from "effect"
import { Hash } from "../util/hash"
import { knowledgeSimilarity, type Doc, type DocType, type DocumentStore } from "../deepagent/document-store"
import { ContextAuthorization, Sensitivity, type EgressPolicy, type Principal } from "./authorization"
import { candidate, status, type ContextCandidate, type GraphQueryStatus, type GraphSourceRevision } from "./federation"
import { type ContextRef, type ContextScopeBinding, type ProjectScopeKey, type SecurityNamespaceID } from "./reference"
import type { GraphKind } from "./contract"
import { DeepAgentReleasedSnapshot, SnapshotIntegrityError } from "../deepagent/released-snapshot"

const KnowledgeTypes: ReadonlySet<DocType> = new Set(["knowledge", "strategy", "methodology", "skill"])
const DocumentTypes: ReadonlySet<DocType> = new Set([
  "design",
  "requirements",
  "bugfix",
  "tasks",
  "worklog",
  "eval",
  "diagnosis",
  "decision",
  "context_snapshot",
  "instruction_resolution",
  "conflict",
  "failure_dossier",
  "run_context",
  "run_state",
  "plan",
  "ledger",
  "bridge",
])

export type Query = {
  readonly text: string
  readonly entityIds?: readonly string[]
  readonly limit?: number
  readonly now?: number
}

export type Result = {
  readonly candidates: readonly ContextCandidate[]
  readonly status: GraphQueryStatus
}

export interface Adapter {
  readonly graph: GraphKind
  readonly source: string
  readonly query: (input: Query) => Effect.Effect<Result>
}

export type Scope = {
  readonly securityNamespaceId: SecurityNamespaceID
  readonly projectScopeKey: ProjectScopeKey
  readonly legacyProjectId: string
  readonly subjectId: string
  readonly sessionId: string
  readonly principal: Principal
  readonly egress: EgressPolicy
}

export function knowledge(input: {
  readonly stores: readonly DocumentStore[]
  readonly scope: Scope
  readonly releasedSelection: DeepAgentReleasedSnapshot.Selection
}): Adapter {
  return legacy({
    graph: "knowledge",
    source: "durable_knowledge",
    stores: input.stores,
    scope: input.scope,
    releasedSelection: input.releasedSelection,
  })
}

export function memory(input: {
  readonly stores: readonly DocumentStore[]
  readonly scope: Scope
  readonly releasedSelection: DeepAgentReleasedSnapshot.Selection
}): Adapter {
  return legacy({
    graph: "memory",
    source: "durable_memory",
    stores: input.stores,
    scope: input.scope,
    releasedSelection: input.releasedSelection,
  })
}

export function executionDocuments(input: {
  readonly source: string
  readonly stores: readonly DocumentStore[]
  readonly scope: Scope
  readonly releasedSelection?: DeepAgentReleasedSnapshot.Selection
}): Adapter {
  return legacy({ graph: "documents", source: input.source, stores: input.stores, scope: input.scope })
}

export function documents(sources: readonly Adapter[]): Adapter {
  return {
    graph: "documents",
    source: "documents_union",
    query: (input) =>
      Effect.all(
        sources.map((source) => source.query(input)),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((results) => {
          if (results.length === 0) return { candidates: [], status: status.notQueried("documents") }
          const successful = results.filter((result) => result.status.kind === "complete")
          const candidates = dedupe(results.flatMap((result) => result.candidates)).slice(0, input.limit ?? 12)
          const revisions = results.flatMap((result) => result.status.revisions)
          if (successful.length === results.length) {
            return {
              candidates,
              status:
                candidates.length > 0 ? status.matched("documents", revisions) : status.empty("documents", revisions),
            }
          }
          if (successful.length > 0 || candidates.length > 0) {
            return {
              candidates,
              status: status.partial({
                graph: "documents",
                state: "degraded",
                reasonCode: "partial_sources",
                revisions,
              }),
            }
          }
          return {
            candidates: [],
            status: status.blocked({ graph: "documents", state: "unavailable", reasonCode: "source_error", revisions }),
          }
        }),
      ),
  }
}

function legacy(input: {
  readonly graph: "knowledge" | "memory" | "documents"
  readonly source: string
  readonly stores: readonly DocumentStore[]
  readonly scope: Scope
  readonly releasedSelection?: DeepAgentReleasedSnapshot.Selection
}): Adapter {
  return {
    graph: input.graph,
    source: input.source,
    query: (query) => {
      if (!input.scope.egress.graphs.includes(input.graph)) {
        return Effect.succeed({
          candidates: [],
          status: status.blocked({
            graph: input.graph,
            state: "denied",
            reasonCode: "provider_egress_denied",
            revisions: [{ source: input.source, state: "denied", reasonCode: "provider_egress_denied" }],
          }),
        })
      }
      return Effect.try({
        try: () => queryLegacy(input, query),
        catch: () => undefined,
      }).pipe(
        Effect.match({
          onFailure: () => ({
            candidates: [],
            status: status.blocked({
              graph: input.graph,
              state: "unavailable",
              reasonCode: "source_error",
              revisions: [{ source: input.source, state: "unavailable", reasonCode: "source_error" }],
            }),
          }),
          onSuccess: (result) => result,
        }),
      )
    },
  }
}

function queryLegacy(
  input: {
    readonly graph: "knowledge" | "memory" | "documents"
    readonly source: string
    readonly stores: readonly DocumentStore[]
    readonly scope: Scope
    readonly releasedSelection?: DeepAgentReleasedSnapshot.Selection
  },
  query: Query,
): Result {
  const entries = input.releasedSelection
    ? releasedEntries(input.stores, input.scope, input.releasedSelection)
    : input.stores.flatMap((store, storeIndex) =>
        store.list().flatMap((ref) => {
          const doc = store.get(ref.id)
          return doc ? [{ key: `${storeIndex}:${doc.id}`, storeIndex, doc }] : []
        }),
      )
  const allowed = new Map<
    string,
    { readonly doc: Doc; readonly ref: ContextRef; readonly sensitivity: Sensitivity; readonly storeIndex: number }
  >()
  for (const entry of entries) {
    const doc = entry.doc
    if (!eligible(input.graph, doc)) continue
    const binding = bindingFor(doc, input.scope)
    if (!binding) continue
    const ref = contextRef(input.graph, doc, binding)
    const sensitivity = sensitivityOf(doc)
    if (
      !ContextAuthorization.authorize({
        ref,
        principal: input.scope.principal,
        egress: input.scope.egress,
        sensitivity,
      }).allowed
    ) {
      continue
    }
    allowed.set(entry.key, { doc, ref, sensitivity, storeIndex: entry.storeIndex })
  }
  const entityIds = new Set(query.entityIds ?? [])
  const candidates = [...allowed.values()]
    .flatMap((entry) => {
      const exact = entityIds.has(entry.doc.id)
      const lexical = query.text.trim() ? knowledgeSimilarity(searchText(entry.doc), query.text) : 0
      if (!exact && lexical <= 0) return []
      const validity = validityOf(entry.doc, input.graph, query.now ?? Date.now())
      const evidence = evidenceOf(entry.doc)
      return [
        candidate({
          ref: entry.ref,
          graph: input.graph,
          title: entry.doc.description.slice(0, 160),
          summary: entry.doc.description.slice(
            0,
            input.graph === "documents" ? 400 : input.graph === "knowledge" ? 240 : 200,
          ),
          relations: entry.doc.links.flatMap((link) => {
            const target = allowed.get(`${entry.storeIndex}:${link.to}`)
            return target ? [{ relation: link.rel, ref: target.ref }] : []
          }),
          provenance: (entry.doc.provenance.evidence_refs ?? []).flatMap((id) => {
            const source = allowed.get(`${entry.storeIndex}:${id}`)
            return source ? [source.ref] : []
          }),
          features: {
            exact: exact ? 1 : 0,
            lexical,
            authority: authorityOf(entry.doc, input.graph),
            evidence,
            freshness: validity.current ? 1 : 0,
          },
          trust:
            input.graph === "knowledge"
              ? "governed_guidance"
              : input.graph === "memory"
                ? "historical_evidence"
                : entry.doc.scope.startsWith("run:")
                  ? "runtime_evidence"
                  : "historical_evidence",
          visibility: validity.current ? "model" : "reference_only",
        }),
      ]
    })
    .toSorted(
      (a, b) =>
        b.features.exact - a.features.exact ||
        b.features.lexical - a.features.lexical ||
        b.features.authority - a.features.authority ||
        a.ref.entityId.localeCompare(b.ref.entityId),
    )
    .slice(0, Math.min(Math.max(query.limit ?? 12, 0), 12))
  const revision = sourceRevision(
    input.source,
    [...allowed.values()].map((entry) => entry.doc),
  )
  return {
    candidates,
    status: candidates.length > 0 ? status.matched(input.graph, [revision]) : status.empty(input.graph, [revision]),
  }
}

function releasedEntries(
  stores: readonly DocumentStore[],
  scope: Scope,
  selection: DeepAgentReleasedSnapshot.Selection,
) {
  if (
    selection.securityNamespaceId !== scope.securityNamespaceId ||
    selection.projectScopeKey !== scope.projectScopeKey ||
    selection.legacyProjectId !== scope.legacyProjectId
  ) {
    throw new SnapshotIntegrityError({
      snapshotId: selection.snapshotId,
      docId: "<selection>",
      reason: "released snapshot scope does not match the federated context scope",
    })
  }
  return selection.documents.map((ref) => {
    const storeIndex = ref.sourceStore === "user_global" ? 0 : 1
    const doc = stores[storeIndex]?.get(ref.id, ref.version)
    const expectedScope = ref.sourceStore === "user_global" ? "durable" : `durable:project:${scope.legacyProjectId}`
    if (
      ref.scope !== expectedScope ||
      !doc ||
      doc.hash !== ref.hash ||
      doc.type !== ref.type ||
      doc.scope !== ref.scope
    ) {
      throw new SnapshotIntegrityError({
        snapshotId: selection.snapshotId,
        docId: ref.id,
        reason: ref.scope !== expectedScope
          ? `${ref.sourceStore} document scope does not match the released authority`
          : !doc
          ? `${ref.sourceStore} document revision is missing`
          : "document hash, type, or scope does not match the released snapshot",
      })
    }
    return { key: `${storeIndex}:${doc.id}`, storeIndex, doc }
  })
}

function eligible(graph: "knowledge" | "memory" | "documents", doc: Doc) {
  if (doc.scope === "sealed") return false
  if (graph === "knowledge") {
    if (!KnowledgeTypes.has(doc.type) || doc.status !== "active") return false
    return ["strong", "medium"].includes(doc.confidence?.evidence_strength ?? "none")
  }
  if (graph === "memory") return doc.type === "memory" && doc.status === "active"
  return DocumentTypes.has(doc.type) && ["active", "draft"].includes(doc.status)
}

function bindingFor(doc: Doc, scope: Scope): ContextScopeBinding | undefined {
  if (doc.extensions?.builtin === true) return { scope: "builtin" }
  if (doc.scope === "durable") {
    return { scope: "user", securityNamespaceId: scope.securityNamespaceId, subjectId: scope.subjectId }
  }
  if (doc.scope === `durable:project:${scope.legacyProjectId}`) {
    return { scope: "project", securityNamespaceId: scope.securityNamespaceId, projectScopeKey: scope.projectScopeKey }
  }
  if (doc.scope === `run:${scope.sessionId}`) {
    return {
      scope: "session",
      securityNamespaceId: scope.securityNamespaceId,
      projectScopeKey: scope.projectScopeKey,
      sessionId: scope.sessionId,
    }
  }
}

function contextRef(graph: "knowledge" | "memory" | "documents", doc: Doc, binding: ContextScopeBinding): ContextRef {
  return {
    graph,
    entityId: doc.id,
    binding,
    revision: JSON.stringify({
      version: doc.version,
      hash: doc.hash,
      status: doc.status,
      supersededBy: doc.superseded_by,
      validity: validityRevision(doc),
    }),
  }
}

function sensitivityOf(doc: Doc): Sensitivity {
  const value =
    (typeof doc.extensions?.sensitivity === "string" ? doc.extensions.sensitivity : undefined) ??
    doc.tags.find((tag) => tag.startsWith("sensitivity:"))?.slice("sensitivity:".length)
  return Sensitivity.literals.includes(value as Sensitivity) ? (value as Sensitivity) : "secret_adjacent"
}

function validityRevision(doc: Doc) {
  return {
    observedAt: finiteExtension(doc, "observed_at"),
    validFrom: finiteExtension(doc, "valid_from"),
    validUntil: finiteExtension(doc, "valid_until"),
    lastConfirmedAt: finiteExtension(doc, "last_confirmed_at"),
    supersededBy: typeof doc.extensions?.superseded_by === "string" ? doc.extensions.superseded_by : undefined,
  }
}

function validityOf(doc: Doc, graph: "knowledge" | "memory" | "documents", now: number) {
  const validity = validityRevision(doc)
  return {
    current:
      (doc.status === "active" || (graph === "documents" && doc.status === "draft")) &&
      !validity.supersededBy &&
      (validity.validFrom === undefined || validity.validFrom <= now) &&
      (validity.validUntil === undefined || validity.validUntil > now),
  }
}

function finiteExtension(doc: Doc, key: string) {
  const value = doc.extensions?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function searchText(doc: Doc) {
  return `${doc.description} ${doc.tags.join(" ")} ${doc.body.slice(0, 2_000)}`
}

function evidenceOf(doc: Doc) {
  return { strong: 1, medium: 0.7, weak: 0.3, none: 0 }[doc.confidence?.evidence_strength ?? "none"]
}

function authorityOf(doc: Doc, graph: "knowledge" | "memory" | "documents") {
  if (graph === "knowledge") {
    if (doc.provenance.source === "human") return 1
    if (doc.extensions?.pack_id) return 0.9
    return 0.7
  }
  if (graph === "documents" && doc.type === "requirements") return 0.9
  return 0.6
}

function sourceRevision(source: string, docs: readonly Doc[]): GraphSourceRevision {
  return {
    source,
    state: "ready",
    revision: Hash.sha256(
      JSON.stringify(
        docs
          .map((doc) => ({ id: doc.id, version: doc.version, hash: doc.hash, status: doc.status }))
          .toSorted((a, b) => a.id.localeCompare(b.id)),
      ),
    ),
  }
}

function dedupe(candidates: readonly ContextCandidate[]) {
  return [
    ...new Map(candidates.map((item) => [`${item.graph}:${item.ref.entityId}:${item.ref.revision}`, item])).values(),
  ]
}
