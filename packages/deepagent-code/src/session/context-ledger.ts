import { Effect } from "effect"
import path from "node:path"
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { Global } from "@deepagent-code/core/global"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { DeepAgentDocumentStore, DeepAgentContext, DeepAgentDurableKnowledgeStore } from "@deepagent-code/core/deepagent/index"
import type { SessionID } from "./schema"

// V3.8 Appendix-A Stage 1 seam — the ONE bridge between the existing V1 compaction path and the new
// Session Ledger. It is intentionally isolated here (not inlined into compaction.ts) so the whole
// feature is (a) gated behind a flag, (b) default-safe (recovers the CAUSE, never throws into the
// session loop — Phase 3 lesson: DocumentStore construction throws SYNCHRONOUSLY, Effect.catch would
// miss the defect, so we use Effect.matchCauseEffect), and (c) trivially reversible (delete the one
// gated call site in compaction.ts + this file).
//
// Stage 1 coexists with compaction (C6 §1): when a compaction summary is produced, we ALSO parse it
// into structured ledger entries and upsert them as the run-scoped `ledger` DocType. The ledger is a
// structured-summary CANDIDATE — it does NOT yet replace the assembly path (that is Stage 2 / the
// Curator). This gives us a real, persisted, per-turn-incremental ledger to build on without touching
// the live compaction behavior.

const { SessionLedger, ProjectBridge } = DeepAgentContext
const { DocumentStore } = DeepAgentDocumentStore

// Run-scoped DocumentStore root for a session's context docs. Reuses the SAME storage base
// (Global.Path.agent.data) all durable state uses; the ledger lives under state/context/<sessionId>
// so it is co-located with session-state and never collides with durable knowledge roots.
const contextStoreRoot = (sessionID: string): string =>
  path.join(Global.Path.agent.data, "state", "context", sessionID)

// Parse a compaction summary (the structured markdown the V1 compactor already emits — Goal /
// Constraints / Progress / Key Decisions / Next Steps / ...) into ledger append entries. This is the
// "structured diff from prose" step: it extracts bullets under the known headings into typed entries.
// Deliberately tolerant — an unrecognized section is skipped, never fatal.
export const parseSummaryToEntries = (summary: string): DeepAgentContext.SessionLedger.AppendEntry[] => {
  const entries: DeepAgentContext.SessionLedger.AppendEntry[] = []
  const lines = summary.split("\n")
  let kind: DeepAgentContext.SessionLedger.LedgerEntryKind | null = null
  const headingKind = (h: string): DeepAgentContext.SessionLedger.LedgerEntryKind | null => {
    const t = h.toLowerCase()
    if (t.includes("goal")) return "goal"
    if (t.includes("constraint") || t.includes("preference")) return "constraint"
    if (t.includes("decision")) return "decision"
    if (t.includes("done")) return "done"
    if (t.includes("next")) return "next"
    if (t.includes("blocked") || t.includes("open") || t.includes("in progress")) return "open"
    if (t.includes("file")) return "artifact"
    return null
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith("#")) {
      kind = headingKind(line.replace(/^#+\s*/, ""))
      continue
    }
    const bullet = line.replace(/^[-*]\s+/, "")
    if (!kind || bullet === line) continue // not a bullet under a known heading
    if (!bullet || /^\(none\)$/i.test(bullet) || /^\[.*\]$/.test(bullet)) continue // placeholder
    entries.push({ kind, text: bullet })
  }
  return entries
}

// Stage 1 hook: given a session id + its latest compaction summary, merge the parsed facts into the
// session ledger and persist. Default-safe: any failure (store construction defect, parse, IO) is
// recovered from the CAUSE to a no-op. Returns the number of entries in the ledger after the merge,
// or 0 on any failure.
export const updateLedgerFromSummary = (input: { sessionID: SessionID; summary: string }) =>
  Effect.sync(() => {
    const store = new DocumentStore(contextStoreRoot(input.sessionID))
    const current = SessionLedger.loadLedger(store, input.sessionID)
    const appended = parseSummaryToEntries(input.summary)
    const next = SessionLedger.applyUpdate(current, { append: appended })
    SessionLedger.persistLedger(store, next)
    return next.entries.length
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: () => Effect.succeed(0),
      onSuccess: (n) => Effect.succeed(n),
    }),
  )

// V3.8 App-A C3 (Stage 3) — cross-session handoff WRITE side. At compaction (the same gated seam that
// mirrors the summary into the ledger), project this session's ledger into the PROJECT-level bridge so
// a FUTURE session in the same workspace opens knowing what this session did + what to do next. The
// orchestrator's read side (buildPromptContext) loads this bridge from the project-scoped durable store
// and injects renderHandoff into the new session's system prompt.
//
// Physical store: the project-scoped durable DocumentStore under the SAME storage base
// (Global.Path.agent.data) knowledge-source unions — openProjectStore(base, workspacePath).documentStore
// resolves the exact root (project/<pid>/knowledge) the read side reads, and ProjectBridge.carryOver
// writes the `bridge` doc under scope durable:project:<pid>. projectId derivation is the single shared
// projectIdForWorkspace, so read and write agree.
//
// DEFAULT-SAFE (Phase 3 lesson): DocumentStore construction throws SYNCHRONOUSLY, so Effect.catch would
// miss the defect — recover the CAUSE via Effect.matchCauseEffect. Any failure (store defect, empty
// ledger, IO) degrades to a no-op (returns 0) and never throws into the compaction loop. Returns the
// number of bridge entries after the carry-over.
export const carryOverToBridge = (input: { sessionID: SessionID; workspacePath: string }) =>
  Effect.sync(() => {
    const ledgerStore = new DocumentStore(contextStoreRoot(input.sessionID))
    const ledger = SessionLedger.loadLedger(ledgerStore, input.sessionID)
    if (ledger.entries.length === 0) return 0
    // CRITICAL (write-then-read coherence): write through the SAME module-cached project store the
    // orchestrator's read side (buildPromptContext → KnowledgeSource.projectStoreFor) loads from.
    // DocumentStore hydrates its in-memory Map ONCE at construction and never re-reads disk, and no
    // invalidateCache fires after this write — so writing through a fresh openProjectStore instance
    // (as this used to) persisted to disk but left the long-lived cached read instance stale, making
    // the bridge invisible in-process (code-index-trigger warms that cache on a session's first
    // prompt). Reusing projectStoreFor mutates the exact instance the reader holds AND persists to
    // disk in one shot. Fall back to a fresh store only when knowledge-source is unconfigured — the
    // read side would return nothing then anyway, but disk persistence is still preserved for a
    // later cold-cache process.
    const projectStore = AgentGateway.DeepAgentKnowledgeSource.isConfigured()
      ? AgentGateway.DeepAgentKnowledgeSource.projectStoreFor(input.workspacePath).documentStore
      : DeepAgentDurableKnowledgeStore.openProjectStore(Global.Path.agent.data, input.workspacePath).documentStore
    const projectId = DeepAgentDurableKnowledgeStore.projectIdForWorkspace(input.workspacePath)
    const bridge = ProjectBridge.carryOver(projectStore, projectId, ledger)
    return bridge.entries.length
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: () => Effect.succeed(0),
      onSuccess: (n) => Effect.succeed(n),
    }),
  )

// --- 附-D fork memory completeness (Ledger-forward + persistent cutoff marker) ---------------------
//
// Audit finding (附-D): session fork copies messages/parts/metadata but carried NEITHER the Session
// Ledger (App-A §C2 structured fact ledger) NOR any OBJECT record of the fork's cutoff point (cutoff
// was purely an imperative "skip messages >= messageID" with no persisted seam). Design intent: a
// forked session inherits the parent's "memory" — its structured Ledger AND an explicit, persisted
// divergence marker so the fork relationship is traceable.
//
// SEAM — 附-D 阶段5 compare/merge is NOT implemented this round. compare/merge (diffing a fork's
// Ledger against its parent and reconciling divergent branches) is a V4.0 parallel-exploration
// workflow. The ForkOrigin marker persisted below IS its future anchor: it records the parent
// sessionID + the cutoff messageID/time so a later compare/merge can locate the exact divergence
// point and load BOTH ledgers (parent via contextStoreRoot(parentID), fork via
// contextStoreRoot(forkID)) to reconcile them. This round only writes the anchor; nothing reads it
// for reconciliation yet.

// Copy the parent session's SessionLedger into the forked session's own ledger store so the fork
// opens with the parent's structured memory. The ledger is stored per-sessionID (docs scoped
// `run:<sessionId>` under contextStoreRoot(sessionID)); forwarding re-keys the loaded ledger's
// sessionId to the fork and persists it under the fork's own store root — parent and fork ledgers
// stay fully independent afterwards (edits to one never touch the other).
//
// Default-safe (Phase 3 lesson): DocumentStore construction throws SYNCHRONOUSLY, so a plain
// Effect.catch would MISS the defect — we recover from the CAUSE via Effect.matchCauseEffect. Any
// failure (store construction defect, IO) degrades to "fork has no forwarded ledger" (returns 0)
// rather than failing the fork. Returns the number of entries copied.
export const forwardLedgerOnFork = (input: { parentSessionID: SessionID; forkSessionID: SessionID }) =>
  Effect.sync(() => {
    const parentStore = new DocumentStore(contextStoreRoot(input.parentSessionID))
    const parentLedger = SessionLedger.loadLedger(parentStore, input.parentSessionID)
    if (parentLedger.entries.length === 0) return 0
    // Re-key to the fork's sessionId so persistLedger writes docs scoped `run:<forkSessionID>`.
    const forkLedger = { ...parentLedger, sessionId: input.forkSessionID }
    const forkStore = new DocumentStore(contextStoreRoot(input.forkSessionID))
    return SessionLedger.persistLedger(forkStore, forkLedger)
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: () => Effect.succeed(0),
      onSuccess: (n) => Effect.succeed(n),
    }),
  )

// The persisted fork divergence marker (附-D). A tiny JSON co-located with the fork's ledger in its
// context store root — deliberately NOT the compaction `ledger` DocType (fork provenance is not a
// task fact and there is no ledger entry kind for it) and NOT only session metadata (co-locating with
// the ledger keeps the fork's whole "memory" — forwarded ledger + its origin — in one store that is
// exactly what the future compare/merge reads). Independent of the session's directory/worktree: the
// context store root is under Global.Path.agent.data/state/context/<sessionID>, keyed only by
// sessionID, so it never moves when a fork lands in a different directory or a dedicated worktree.
export type ForkOrigin = {
  // The session this fork diverged FROM.
  readonly parentSessionID: string
  // The cutoff message id the fork was cut at (the first parent message NOT carried into the fork),
  // or undefined for a full fork (no messageID => the whole parent history was copied).
  readonly cutoffMessageID?: string
  // Wall-clock time the fork diverged.
  readonly forkedAt: number
}

const forkOriginFile = (sessionID: string): string => path.join(contextStoreRoot(sessionID), "fork-origin.json")

// Persist the fork divergence marker into the fork's context store. Default-safe: any IO failure is
// recovered from the CAUSE to a no-op (returns false) rather than failing the fork.
export const persistForkOrigin = (input: { forkSessionID: SessionID; origin: ForkOrigin }) =>
  Effect.sync(() => {
    const file = forkOriginFile(input.forkSessionID)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(input.origin, null, 2), "utf8")
    return true
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: () => Effect.succeed(false),
      onSuccess: () => Effect.succeed(true),
    }),
  )

// Read the fork divergence marker for a session, or undefined if it is not a fork / has no marker.
// Default-safe: a missing or malformed marker returns undefined, never throws.
export const loadForkOrigin = (sessionID: SessionID): ForkOrigin | undefined => {
  try {
    const file = forkOriginFile(sessionID)
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ForkOrigin
    if (!parsed || typeof parsed.parentSessionID !== "string" || typeof parsed.forkedAt !== "number") return undefined
    return parsed
  } catch {
    return undefined
  }
}

export { contextStoreRoot }
