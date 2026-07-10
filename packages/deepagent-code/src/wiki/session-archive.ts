import { Effect } from "effect"
import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { Global } from "@deepagent-code/core/global"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { DocumentStore, type Doc } from "@deepagent-code/core/deepagent/document-store"
import * as KnowledgeSource from "@deepagent-code/core/deepagent/knowledge-source"
import { DeepAgentCodeHome } from "@deepagent-code/core/deepagent/workspace"
import {
  WikiGraph,
  WikiService,
  buildExecutionArchive,
  type ExecutionArchive,
  type WikiEditGate,
} from "./wiki-service"
import { WikiSearchIndex } from "./search-index"

/**
 * V3.9 §B — production wiring for the Wiki projection.
 *
 * `openWikiGraph` assembles the read-only DocumentStore union a WikiService/WikiSearchIndex projects
 * over — the SAME union the retriever / graph-query walk (§B.1: no new storage), plus the session's
 * own run-scoped context + run-graph stores so a session's plan/worklog/diagnosis/decision trajectory
 * is projectable as an execution archive (§B.6).
 *
 * `archiveSessionOnCompletion` is the §B.6 session-completion trigger. It is invoked from the existing
 * completion path (persistSuggestion in session/prompt.ts) gated by flags.experimentalWiki. It is
 * DEFAULT-SAFE: DocumentStore construction throws SYNCHRONOUSLY, so — following the Phase-3 lesson —
 * we run inside Effect.sync + a matchCauseEffect wrapper so any failure (missing dir, store defect,
 * IO) degrades to a no-op and never throws into the session loop. Archiving is a pure read-projection
 * (it does NOT mutate the graph), so a failure loses only the in-process archive, never data.
 */

// The session's run-scoped context DocumentStore root (mirrors context-ledger.ts contextStoreRoot).
const contextStoreRoot = (sessionID: string): string =>
  path.join(Global.Path.agent.data, "state", "context", sessionID)

// Every run-graph store under a session's runs/ dir (each run materializes <runDir>/graph, scope
// run:<runId>). Returns [] when the session has no runs dir yet.
const runGraphRoots = (workspacePath: string, sessionID: string): string[] => {
  try {
    const home = new DeepAgentCodeHome(Global.Path.agent.data)
    const session = home.ensureSession(
      AgentGateway.DeepAgentDurableKnowledgeStore.projectIdForWorkspace(workspacePath),
      sessionID,
    )
    if (!existsSync(session.runsDir)) return []
    return readdirSync(session.runsDir)
      .map((name) => path.join(session.runsDir, name, "graph"))
      .filter((dir) => existsSync(dir) && statSync(dir).isDirectory())
  } catch {
    return []
  }
}

/**
 * Build the WikiGraph union for a workspace (+ optional session). Order matters (first-store-wins on
 * id collision, matching the retriever's user-global-wins rule):
 *   1. user-global durable store, 2. project durable store  — the governed knowledge/code graphs
 *   3. session context store, 4..N per-run graph stores      — the session trajectory (run-scoped)
 * Stores that cannot be opened are skipped; the result is always a valid (possibly empty) graph.
 */
export const openWikiGraph = (input: { workspacePath?: string; sessionID?: string }): WikiGraph => {
  const stores: DocumentStore[] = []
  // Durable governance stores via the shared facade (reuses the cached instances the retriever holds).
  try {
    if (KnowledgeSource.isConfigured()) {
      for (const dks of KnowledgeSource.storesForWorkspace(input.workspacePath)) stores.push(dks.documentStore)
    }
  } catch {
    /* unconfigured — skip durable stores */
  }
  // Session trajectory stores (run-scoped). Only added when a session id is given.
  if (input.sessionID) {
    try {
      const ctxRoot = contextStoreRoot(input.sessionID)
      if (existsSync(ctxRoot)) stores.push(new DocumentStore(ctxRoot))
    } catch {
      /* skip */
    }
    if (input.workspacePath) {
      for (const graphRoot of runGraphRoots(input.workspacePath, input.sessionID)) {
        try {
          stores.push(new DocumentStore(graphRoot))
        } catch {
          /* skip a single un-openable run graph */
        }
      }
    }
  }
  return new WikiGraph(stores)
}

/**
 * Open a WikiService over the production graph union. `gate` is the governance evidence-gate for
 * editKnowledge — omitted, the WikiService falls back to its DEFAULT_WIKI_EDIT_GATE (the minimum
 * floor). Production passes `buildWikiEditGate(memoryDir)` so a human edit goes through the SAME
 * validation gate (§B.3) as knowledge promotion (dedupe vs RejectedBuffer + replay/regression).
 */
export const openWikiService = (input: {
  workspacePath?: string
  sessionID?: string
  gate?: WikiEditGate
}): WikiService => (input.gate ? new WikiService(openWikiGraph(input), input.gate) : new WikiService(openWikiGraph(input)))

// A knowledge doc's type maps to the learning-candidate type space (which has no bare "knowledge" —
// it is memory/strategy/methodology/anti_pattern). knowledge/memory → "memory"; strategy/methodology
// pass through. This keeps the fingerprint (type+summary) meaningful for the RejectedBuffer.
const candidateTypeForDoc = (docType: Doc["type"]): "memory" | "strategy" | "methodology" | "anti_pattern" => {
  if (docType === "strategy") return "strategy"
  if (docType === "methodology") return "methodology"
  return "memory"
}

/**
 * §B.3 — the REAL governance evidence-gate for a human Wiki knowledge edit. Bridges the sync,
 * Doc-based `WikiEditGate` shape onto the core promotion `validate` (the same gate knowledge
 * promotion uses): it maps the edited doc + body into a LearningCandidate, then runs
 * `DeepAgentPromotion.validate` against the workspace RejectedBuffer with the evidence-refs-nonempty
 * replay runner (identical to the `promote` handler). An edit whose page carries no supporting
 * evidence links, or whose (type,summary) fingerprint was previously rejected, fails the gate.
 */
export const buildWikiEditGate = (memoryDir: string): WikiEditGate => {
  const buffer = new AgentGateway.DeepAgentPromotion.RejectedBuffer(memoryDir)
  const replay: AgentGateway.DeepAgentPromotion.ReplayRunner = (candidate) => ({
    pass: candidate.evidence_refs.length > 0,
    metricDelta: 0,
    evidenceRef: candidate.evidence_refs[0],
  })
  return ({ current, body, editor }) => {
    if (!editor || editor.id.trim().length === 0)
      return { pass: false, reason: "missing editor identity: a governed edit must record who made it" }
    // Evidence = the edited page's outbound links (references/produces_evidence/etc.) — the supporting
    // refs the validate gate requires. A knowledge page with no links has no evidence to stand on.
    const evidenceRefs = current.links.map((l) => l.to)
    const candidate = {
      candidate_id: current.id,
      type: candidateTypeForDoc(current.type),
      status: "staged" as const,
      source_run_id: current.scope,
      source_round: current.version,
      summary: body.trim(),
      evidence_refs: evidenceRefs,
      confidence: current.confidence?.support_count ?? 0,
    }
    const verdict = AgentGateway.DeepAgentPromotion.validate(candidate, buffer, replay)
    return { pass: verdict.pass, reason: verdict.reason }
  }
}

// The dedicated on-disk sqlite path for a workspace's wiki search index (§B.4 — a rebuildable
// projection in its OWN file, never the main app DB). Keyed by projectId so workspaces don't collide.
const wikiSearchDbPath = (workspacePath?: string): string => {
  const projectId = workspacePath
    ? AgentGateway.DeepAgentDurableKnowledgeStore.projectIdForWorkspace(workspacePath)
    : "global"
  return path.join(Global.Path.agent.data, "state", "wiki", projectId, "search.sqlite")
}

/**
 * §B.4 — production factory for the WikiSearchIndex. Opens the dedicated sqlite FTS index over the
 * workspace's wiki graph union. The index is a rebuildable projection: nothing auto-refreshes it, so
 * the caller must `yield* rebuild()` before `search()` and `close()` when done (the wiki search
 * handler does exactly this per request). Returns a fresh index each call — cheap (WAL sqlite open).
 */
export const openWikiSearchIndex = (input: { workspacePath?: string; sessionID?: string }): WikiSearchIndex =>
  new WikiSearchIndex(wikiSearchDbPath(input.workspacePath), openWikiGraph(input))

/**
 * §B.6 session-completion trigger. Aggregates the session's trajectory into an ExecutionArchive.
 * Default-safe: never throws, returns null on any failure or when the session has no trajectory.
 * The caller (prompt.ts persistSuggestion) gates this on flags.experimentalWiki.
 */
export const archiveSessionOnCompletion = (input: {
  workspacePath: string
  sessionID: string
}): Effect.Effect<ExecutionArchive | null, never> =>
  Effect.sync(() => {
    const graph = openWikiGraph({ workspacePath: input.workspacePath, sessionID: input.sessionID })
    const archive = buildExecutionArchive(graph, input.sessionID)
    if (archive.entries.length === 0) return null
    // PERSIST the rendered archive as a run-scoped context doc so the aggregation is not wasted work
    // (the caller pipes the result to asVoid). This is a PROJECTION of the same trajectory (§B.1 — no
    // new source of truth), rebuildable from the graph; it makes the assembled Markdown durably
    // available (e.g. for a Repo view) without an event bus. Idempotent via idSlug; best-effort — a
    // persist failure degrades to just returning the in-memory archive (matchCauseEffect below).
    persistArchiveDoc(input.sessionID, archive)
    return archive
  }).pipe(Effect.matchCauseEffect({ onFailure: () => Effect.succeed(null), onSuccess: Effect.succeed }))

// Best-effort persistence of the rendered execution archive into the session's run-scoped context
// store. Reuses the SAME context store root openWikiGraph reads, so a subsequent open projects it.
const persistArchiveDoc = (sessionID: string, archive: ExecutionArchive): void => {
  const ctxRoot = contextStoreRoot(sessionID)
  if (!existsSync(ctxRoot)) return // no session context store yet → nothing to attach to; skip
  const store = new DocumentStore(ctxRoot)
  store.upsert({
    type: "context_snapshot",
    scope: `run:${sessionID}`,
    description: `execution archive ${sessionID}`,
    idSlug: `execution-archive-${sessionID}`,
    body: archive.markdown,
    provenance: { source: "runner", run_ref: `run:${sessionID}` },
    extensions: { archive_kind: "execution", entry_count: archive.entries.length },
  })
}
