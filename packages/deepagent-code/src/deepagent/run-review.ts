import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"

const DOCUMENT_GRAPH_MISSING = "document_graph_missing"
const REBUILD_DOCUMENT_GRAPH_REQUIRED = "rebuild_document_graph_required"

// V3 A7: reviewer projection. The document graph is the review source of truth; flat
// artifacts are compatibility projections and are intentionally not used to reconstruct review
// state. Missing graphs surface as an explicit migration/rebuild-required review entry.

export type CandidateNode = {
  round: number
  ref: string
  parent: string | null
  status: string
  decisionRef: string | null
  notes: string[]
}

export type RunReview = {
  runId: string
  agentMode: string | null
  status: string | null
  nextAction: string | null
  candidates: CandidateNode[]
  diagnosis: { status: string | null; rootCause: string | null; nextAction: string | null } | null
  runContext: string | null
  learningCandidates: LearningReviewCandidate[]
}

export type LearningReviewCandidate = {
  candidateId: string
  type: "memory" | "strategy" | "methodology"
  status: string
  sourceRunId: string
  sourceRound: number
  summary: string
  evidenceRefs: string[]
  confidence: number
}

export const buildRunReview = async (runDir: string): Promise<RunReview> => {
  const graph = buildRunReviewFromGraph(runDir)
  if (graph) return graph
  const runId = path.basename(runDir)
  return {
    runId,
    agentMode: null,
    status: DOCUMENT_GRAPH_MISSING,
    nextAction: REBUILD_DOCUMENT_GRAPH_REQUIRED,
    candidates: [],
    diagnosis: {
      status: "required",
      rootCause: DOCUMENT_GRAPH_MISSING,
      nextAction: REBUILD_DOCUMENT_GRAPH_REQUIRED,
    },
    runContext: null,
    learningCandidates: [],
  }
}

const buildRunReviewFromGraph = (runDir: string): RunReview | null => {
  try {
    const runId = path.basename(runDir)
    const store = new AgentGateway.DeepAgentDocumentStore.DocumentStore(path.join(runDir, "graph"))
    const scope = `run:${runId}`
    const doc = (id: string) => store.get(id)
    const byType = (type: AgentGateway.DeepAgentDocumentStore.DocType) =>
      store.list({ scope, type }).map((ref) => doc(ref.id)).filter((d): d is NonNullable<ReturnType<typeof doc>> => Boolean(d))

    const runState = byType("run_state")[0]
    const runContext = byType("run_context")[0]
    const candidateDocs = byType("candidate")
    const diagnosisDoc = byType("diagnosis")[0]
    const decisionDoc = byType("decision")[0]
    if (!runState && !runContext && candidateDocs.length === 0 && !decisionDoc) return null

    const runStateExt = runState?.extensions ?? {}
    const diagnosisExt = diagnosisDoc?.extensions ?? {}
    const candidates = candidateDocs.map((candidate) => ({
      round: candidate.created_round ?? 0,
      ref: candidate.id,
      parent: candidate.links.find((link) => link.rel === "derived_from")?.to ?? null,
      status: String(candidate.extensions?.candidate_status ?? candidate.status),
      decisionRef: decisionDoc?.id ?? null,
      notes: [candidate.body].filter(Boolean),
    }))

    const diagnosis = diagnosisDoc
      ? {
          status: "required",
          rootCause: stringOrNull(diagnosisExt.root_cause) ?? diagnosisDoc.description,
          nextAction: stringOrNull(diagnosisExt.next_action) ?? stringOrNull(runStateExt.next_action_policy),
        }
      : null

    return {
      runId,
      agentMode: stringOrNull(runStateExt.agent_mode),
      status: stringOrNull(runStateExt.status),
      nextAction: diagnosis?.nextAction ?? stringOrNull(runStateExt.next_action_policy),
      candidates,
      diagnosis,
      runContext: runContext?.body ?? null,
      learningCandidates: learningCandidatesFromGraph(store, scope),
    }
  } catch {
    return null
  }
}

const learningCandidatesFromGraph = (
  store: AgentGateway.DeepAgentDocumentStore.DocumentStore,
  scope: string,
): LearningReviewCandidate[] =>
  store
    .list({ scope, type: ["memory", "strategy", "methodology"], status: ["candidate", "rejected"] })
    .map((ref) => store.get(ref.id))
    .filter((doc): doc is NonNullable<typeof doc> => Boolean(doc))
    .map((doc) => ({
      candidateId: String(doc.extensions?.candidate_id ?? doc.id),
      type: doc.type as LearningReviewCandidate["type"],
      status: String(doc.extensions?.promotion_status ?? doc.status),
      sourceRunId: String(doc.extensions?.source_run_id ?? ""),
      sourceRound: numberOrZero(doc.extensions?.source_round),
      summary: doc.body,
      evidenceRefs: [...(doc.provenance.evidence_refs ?? [])],
      confidence: numberOrZero(doc.extensions?.confidence),
    }))

const stringOrNull = (value: unknown) => (typeof value === "string" ? value : null)
const numberOrZero = (value: unknown) => (typeof value === "number" ? value : 0)

// List run ids, most recent first. P2-K: run ids are `run_${randomUUID()}` (no embedded time
// order), so a lexical sort+reverse does NOT yield recency — it silently dropped newer runs once
// the reviews route sliced the top N. Order by directory mtime (newest first) instead; ties and
// unstat-able entries fall back to a stable lexical order so the result is deterministic.
export const listRunIds = async (runsDir: string): Promise<string[]> => {
  try {
    const entries = await readdir(runsDir, { withFileTypes: true })
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    const withMtime = await Promise.all(
      dirs.map(async (name) => {
        const mtime = await stat(path.join(runsDir, name))
          .then((s) => s.mtimeMs)
          .catch(() => 0)
        return { name, mtime }
      }),
    )
    return withMtime.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name)).map((e) => e.name)
  } catch {
    return []
  }
}
