import type { DocumentStore, Doc } from "../document-store"
import type { Ledger, LedgerEntry } from "./ledger"

// V3.8 Appendix-A C3 (Stage 3) — the Project Bridge: cross-session handoff (public axiom 2: "换对话
// → 无损接力"). At session close / explicit carry-over, the session Ledger's ACTIVE
// Goal/Decision/Open/Next/Artifact entries are projected into a project-level `bridge` doc; a new
// session loads it at open so it immediately knows "what other sessions did + what to do next".
//
// Storage: the `bridge` DocType (Phase 0 — non-knowledge, no confidence) in the EXISTING
// project-scoped durable store ("durable:project:<id>"). We do NOT add a store: the caller passes the
// project DocumentStore (from knowledge-source.projectStoreFor(path).documentStore). One bridge doc
// per project (idSlug = project handoff), upserted — its version chain is the handoff history.
//
// Gate (C3 "档位策略"): the bridge summary injection is gated at the SAME door as knowledge
// (mode !== "general"). That gating lives at the injection site (prompt assembly), not here — this
// module only projects/loads. `shouldLoadBridge(mode)` is the shared predicate.

export type BridgeEntry = {
  readonly kind: LedgerEntry["kind"]
  readonly text: string
  readonly rationale?: string
  readonly sourceSessionId: string
}

export type Bridge = {
  readonly projectId: string
  readonly entries: readonly BridgeEntry[]
  readonly updatedAt: number
}

const BRIDGE_SLUG = "project-bridge"

// Kinds carried across sessions: goals, decisions, open items, the next step, and artifacts. `done`
// items are session-local progress; they do not belong in a forward-looking handoff.
const CARRIED: ReadonlySet<LedgerEntry["kind"]> = new Set(["goal", "decision", "open", "next", "artifact"])

// Project a session ledger into bridge entries: the ACTIVE carried-kind entries (C3 "把 active 的
// Goal/Decision/Open/Next/Artifact 提炼成项目级交接条目").
export const projectLedger = (ledger: Ledger): BridgeEntry[] =>
  ledger.entries
    .filter((e) => e.status === "active" && CARRIED.has(e.kind))
    .map((e) => ({
      kind: e.kind,
      text: e.text,
      ...(e.rationale ? { rationale: e.rationale } : {}),
      sourceSessionId: ledger.sessionId,
    }))

const serialize = (entries: readonly BridgeEntry[]): string => JSON.stringify({ entries }, null, 2)

const parse = (projectId: string, doc: Doc): Bridge => {
  try {
    const data = JSON.parse(doc.body) as { entries?: BridgeEntry[] }
    return { projectId, entries: data.entries ?? [], updatedAt: Date.now() }
  } catch {
    return { projectId, entries: [], updatedAt: Date.now() }
  }
}

const projectScope = (projectId: string): string => `durable:project:${projectId}`

// Load the current project bridge, or an empty one. Sync; Effect callers wrap with cause recovery.
export const loadBridge = (store: DocumentStore, projectId: string): Bridge => {
  const scope = projectScope(projectId)
  for (const ref of store.list({ type: "bridge", scope })) {
    const doc = store.get(ref.id)
    if (doc) return parse(projectId, doc)
  }
  return { projectId, entries: [], updatedAt: Date.now() }
}

// Carry a session's ledger into the project bridge: merge the session's active carried entries into
// the existing bridge (replacing this session's prior contribution so repeated carry-overs don't
// duplicate) and upsert the `bridge` doc. Returns the merged bridge.
export const carryOver = (store: DocumentStore, projectId: string, ledger: Ledger, now = Date.now()): Bridge => {
  const existing = loadBridge(store, projectId)
  // Drop this session's previous contribution, then add the fresh projection.
  const others = existing.entries.filter((e) => e.sourceSessionId !== ledger.sessionId)
  const merged = [...others, ...projectLedger(ledger)]
  const bridge: Bridge = { projectId, entries: merged, updatedAt: now }
  store.upsert({
    type: "bridge",
    scope: projectScope(projectId),
    idSlug: `${BRIDGE_SLUG}-${projectId}`,
    description: `project bridge ${projectId}`,
    body: serialize(merged),
    provenance: { source: "runner", run_ref: projectScope(projectId) },
  })
  return bridge
}

// Render the bridge as a compact handoff summary injected at new-session open (C3). Kept short — a
// handoff note, not a dump. Empty string when there is nothing to hand off.
export const renderHandoff = (bridge: Bridge): string => {
  if (bridge.entries.length === 0) return ""
  const byKind = (kind: LedgerEntry["kind"]) => bridge.entries.filter((e) => e.kind === kind)
  const section = (title: string, kind: LedgerEntry["kind"]) => {
    const items = byKind(kind)
    if (items.length === 0) return []
    return [`## ${title}`, ...items.map((e) => `- ${e.text}${e.rationale ? ` (${e.rationale})` : ""}`)]
  }
  return [
    "# Project Handoff",
    "",
    ...section("Goals", "goal"),
    ...section("Key Decisions", "decision"),
    ...section("Open Items", "open"),
    ...section("Next", "next"),
    ...section("Artifacts", "artifact"),
  ]
    .filter((_, i, arr) => arr.length > 2)
    .join("\n")
}

// Shared gate predicate (C3): the handoff is available at high+ (mode !== "general"), same door as
// knowledge. The mode string is whatever the caller's AgentMode is.
export const shouldLoadBridge = (mode: string): boolean => mode !== "general" && mode !== "disabled"
