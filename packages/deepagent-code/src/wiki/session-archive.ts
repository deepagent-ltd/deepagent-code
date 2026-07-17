import { Effect } from "effect"
import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { Global } from "@deepagent-code/core/global"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import * as KnowledgeSource from "@deepagent-code/core/deepagent/knowledge-source"
import { DeepAgentCodeHome } from "@deepagent-code/core/deepagent/workspace"
import { WikiGraph, WikiService, buildExecutionArchive, type ExecutionArchive } from "./wiki-service"

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

/** Open a WikiService over the production graph union. */
export const openWikiService = (input: { workspacePath?: string; sessionID?: string }): WikiService =>
  new WikiService(openWikiGraph(input))

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
