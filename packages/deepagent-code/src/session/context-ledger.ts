import { Effect } from "effect"
import path from "node:path"
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { Global } from "@deepagent-code/core/global"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import {
  DeepAgentDocumentStore,
  DeepAgentContext,
  DeepAgentDurableKnowledgeStore,
} from "@deepagent-code/core/deepagent/index"
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

import os from "node:os"
import { gitGroundTruth } from "../deepagent/git-groundtruth"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import type { WorldStateSlot, WorldStateSlotKind } from "@deepagent-code/core/deepagent/context/world-state"

const { SessionLedger, ProjectBridge, WorldState } = DeepAgentContext
const { DocumentConflictError, DocumentStore } = DeepAgentDocumentStore

// Run-scoped DocumentStore root for a session's context docs. Reuses the SAME storage base
// (Global.Path.agent.data) all durable state uses; the ledger lives under state/context/<sessionId>
// so it is co-located with session-state and never collides with durable knowledge roots.
const contextStoreRoot = (sessionID: string): string => path.join(Global.Path.agent.data, "state", "context", sessionID)

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
    // V4.0.1 P1 (§3.4): the narrowed template's "Data References" bucket → artifact (reference only,
    // never content). The legacy "Relevant Files" heading (contains "file") maps here too.
    if (t.includes("file") || t.includes("reference") || t.includes("data")) return "artifact"
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
export const updateLedgerFromSummaryRequired = (input: {
  sessionID: SessionID
  summary: string
  operationID?: string
}) =>
  Effect.sync(() => {
    const store = new DocumentStore(contextStoreRoot(input.sessionID))
    const current = SessionLedger.loadLedger(store, input.sessionID)
    const appended = parseSummaryToEntries(input.summary).map((entry, index) =>
      input.operationID
        ? {
            ...entry,
            id: `led_compaction_${Hash.sha256(`${input.operationID}:${index}:${entry.kind}:${entry.text}`).slice(0, 24)}`,
          }
        : entry,
    )
    const next = SessionLedger.applyUpdate(current, { append: appended })
    SessionLedger.persistLedger(store, next)
    return next.entries.length
  })

export const updateLedgerFromSummary = (input: { sessionID: SessionID; summary: string }) =>
  updateLedgerFromSummaryRequired(input).pipe(
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
export const carryOverToBridgeRequired = (input: { sessionID: SessionID; workspacePath: string }) =>
  Effect.sync(() => {
    const ledgerStore = new DocumentStore(contextStoreRoot(input.sessionID))
    const ledger = SessionLedger.loadLedger(ledgerStore, input.sessionID)
    if (ledger.entries.length === 0) return 0
    // CRITICAL (write-then-read coherence): write through the SAME module-cached project store the
    // orchestrator's read side (buildPromptContext → KnowledgeSource.projectStoreFor) loads from.
    // DocumentStore hydrates its in-memory Map ONCE at construction and never re-reads disk, and no
    // invalidateCache fires after this write — so writing through a fresh openProjectStore instance
    // (as this used to) persisted to disk but left the long-lived cached read instance stale, making
    // the bridge invisible in-process when that reader already exists. Reusing projectStoreFor mutates
    // the exact instance the reader holds AND persists to
    // disk in one shot. Fall back to a fresh store only when knowledge-source is unconfigured — the
    // read side would return nothing then anyway, but disk persistence is still preserved for a
    // later cold-cache process.
    const projectStore = AgentGateway.DeepAgentKnowledgeSource.isConfigured()
      ? AgentGateway.DeepAgentKnowledgeSource.projectStoreFor(input.workspacePath).documentStore
      : DeepAgentDurableKnowledgeStore.openProjectStore(Global.Path.agent.data, input.workspacePath).documentStore
    const projectId = DeepAgentDurableKnowledgeStore.projectIdForWorkspace(input.workspacePath)
    const bridge = ProjectBridge.carryOver(projectStore, projectId, ledger)
    return bridge.entries.length
  })

export const carryOverToBridge = (input: { sessionID: SessionID; workspacePath: string }) =>
  carryOverToBridgeRequired(input).pipe(
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
// The required variant propagates store/IO defects so the fork side-effect receipt cannot be marked
// complete while durable memory is missing. The compatibility wrapper below is the explicitly
// best-effort API and converts defects to 0. Returns the number of entries copied.
export const forwardLedgerOnForkRequired = (input: { parentSessionID: SessionID; forkSessionID: SessionID }) =>
  Effect.sync(() => {
    const parentStore = new DocumentStore(contextStoreRoot(input.parentSessionID))
    const parentLedger = SessionLedger.loadLedger(parentStore, input.parentSessionID)
    if (parentLedger.entries.length === 0) return 0
    // Re-key to the fork's sessionId so persistLedger writes docs scoped `run:<forkSessionID>`.
    const forkLedger = { ...parentLedger, sessionId: input.forkSessionID }
    const forkStore = new DocumentStore(contextStoreRoot(input.forkSessionID))
    return SessionLedger.persistLedger(forkStore, forkLedger)
  })

export const forwardLedgerOnFork = (input: { parentSessionID: SessionID; forkSessionID: SessionID }) =>
  forwardLedgerOnForkRequired(input).pipe(
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

// Persist the fork divergence marker into the fork's context store. The required variant propagates
// IO defects so recovery keeps retrying the incomplete fork side-effect receipt. The compatibility
// wrapper below remains best-effort and converts defects to false.
export const persistForkOriginRequired = (input: { forkSessionID: SessionID; origin: ForkOrigin }) =>
  Effect.sync(() => {
    const file = forkOriginFile(input.forkSessionID)
    mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(input.origin, null, 2), { encoding: "utf8", mode: 0o600 })
      renameSync(temporary, file)
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary)
    }
    return true
  })

export const persistForkOrigin = (input: { forkSessionID: SessionID; origin: ForkOrigin }) =>
  persistForkOriginRequired(input).pipe(
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

// --- V4.0.1 P1 (§3.3) World State — snapshot-diff volatile facts, re-injected as a tail block --------
//
// The seam between the live git/env/diagnostics sources (deepagent-code) and the pure core World State
// layer. Two steps kept separate so the (bounded) IO is explicit and the store mutation stays sync:
//   1. `collectVolatileFacts(cwd)` — cheap git + env collection (NO per-turn heavy collectors; §3.3 cost
//      bound: callers invoke this ONCE per tick-start / post-compaction, never per turn).
//   2. `refreshWorldState({ workspacePath, facts })` — snapshot-diff merge into the project-scoped World
//      State doc + persist + render the tail block. Default-safe (returns "" on any defect).
//
// projectId derivation + the project store are the SAME single shared path carryOverToBridge uses, so the
// goal-loop tick-start read and the post-compaction write agree on one physical World State doc per project.

// Render the git working-tree state as a compact VCS slot value (branch/dirty/changed-file count). Cheap.
const renderVcs = (git: { changed_files: readonly string[]; diff_stat: string | null }): string => {
  const dirty = git.changed_files.length
  const lines = [`changed files: ${dirty}`]
  if (git.diff_stat) lines.push(git.diff_stat)
  if (dirty > 0) lines.push(...git.changed_files.slice(0, 20).map((f) => `- ${f}`))
  return lines.join("\n")
}

const renderEnv = (): string =>
  [`platform: ${process.platform}`, `node: ${process.version}`, `arch: ${os.arch()}`].join("\n")

// Collect the cheap volatile facts (git + env) as rendered slot values. Best-effort: a git failure just
// omits the vcs slot (undefined ⇒ prior value preserved by collectSlots). NOT a heavy collector — plain
// git ground-truth + process facts, bounded by gitGroundTruth's own timeout.
export const collectVolatileFacts = (
  cwd: string,
): Effect.Effect<Partial<Record<WorldStateSlotKind, string | undefined>>> =>
  Effect.promise(async () => {
    const git = await gitGroundTruth(cwd).catch(() => null)
    const facts: Partial<Record<WorldStateSlotKind, string | undefined>> = { env: renderEnv() }
    if (git) facts.vcs = renderVcs(git)
    return facts
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed({ env: renderEnv() } as Partial<Record<WorldStateSlotKind, string | undefined>>),
    ),
  )

const collectVolatileFactsStrict = (
  cwd: string,
): Effect.Effect<Partial<Record<WorldStateSlotKind, string | undefined>>> =>
  Effect.promise(async () => {
    const git = await gitGroundTruth(cwd)
    return {
      env: renderEnv(),
      vcs: renderVcs(git),
    } satisfies Partial<Record<WorldStateSlotKind, string | undefined>>
  })

// Snapshot-diff the collected facts into the project's World State doc, persist, and render the tail
// block. Returns "" when there is nothing to inject or on ANY defect (default-safe — never throws into
// the turn/tick loop, matching carryOverToBridge's posture). The persisted doc is content-addressed, so
// an unchanged fact set bumps NO version and the rendered tail stays byte-stable across ticks.
export const refreshWorldState = (input: {
  readonly workspacePath: string
  readonly facts: Partial<Record<WorldStateSlotKind, string | undefined>>
}): Effect.Effect<string> =>
  Effect.sync(() => {
    const projectStore = AgentGateway.DeepAgentKnowledgeSource.isConfigured()
      ? AgentGateway.DeepAgentKnowledgeSource.projectStoreFor(input.workspacePath).documentStore
      : DeepAgentDurableKnowledgeStore.openProjectStore(Global.Path.agent.data, input.workspacePath).documentStore
    const projectId = DeepAgentDurableKnowledgeStore.projectIdForWorkspace(input.workspacePath)
    const current = ProjectBridge.loadWorldStateForGoalWorker(projectStore, projectId)
    const next = WorldState.collectSlots(current, input.facts)
    ProjectBridge.persistWorldState(projectStore, next)
    return WorldState.renderWorldState(next)
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: () => Effect.succeed(""),
      onSuccess: (s) => Effect.succeed(s),
    }),
  )

export type SessionWorldStateBaselineSection = {
  readonly sectionID: string
  readonly snapshot: WorldStateSlot
  readonly fragment: string
  readonly fragmentHash: string
}

export type SessionWorldStateBaseline = {
  readonly projectId: string
  readonly snapshot: DeepAgentContext.WorldState.WorldState
  readonly sections: readonly SessionWorldStateBaselineSection[]
  readonly rendered: string
  readonly hash: string
}

const WORLD_STATE_BASELINE_SECTION_ORDER = [
  "world_state:open_files",
  "world_state:vcs",
  "world_state:diagnostics",
  "world_state:env",
] as const

export const orderSessionWorldStateBaselineSections = <T extends { readonly sectionID: string }>(
  sections: readonly T[],
): T[] =>
  [...sections].sort((a, b) => {
    const aIndex = WORLD_STATE_BASELINE_SECTION_ORDER.indexOf(
      a.sectionID as (typeof WORLD_STATE_BASELINE_SECTION_ORDER)[number],
    )
    const bIndex = WORLD_STATE_BASELINE_SECTION_ORDER.indexOf(
      b.sectionID as (typeof WORLD_STATE_BASELINE_SECTION_ORDER)[number],
    )
    if (aIndex < 0 && bIndex < 0) return a.sectionID.localeCompare(b.sectionID)
    if (aIndex < 0) return 1
    if (bIndex < 0) return -1
    return aIndex - bIndex
  })

export const sessionWorldStateBaselineHash = (input: {
  readonly sections: readonly Pick<SessionWorldStateBaselineSection, "sectionID" | "snapshot" | "fragmentHash">[]
  readonly rendered: string
}): string =>
  `wsb1_${Hash.sha256(
    CanonicalJson.stringify({
      version: 1,
      sections: orderSessionWorldStateBaselineSections(input.sections).map((section) => ({
        sectionID: section.sectionID,
        snapshot: section.snapshot,
        fragmentHash: section.fragmentHash,
      })),
      rendered: input.rendered,
    }),
  )}`

// This is the strict Session/PromptEpoch boundary. Unlike refreshWorldState, defects are preserved so
// compaction cannot activate an epoch whose model-visible World State baseline was not constructed.
export const collectSessionWorldStateBaseline = (input: {
  readonly workspacePath: string
}): Effect.Effect<SessionWorldStateBaseline> =>
  Effect.gen(function* () {
    const facts = yield* collectVolatileFactsStrict(input.workspacePath)
    const projectStore = AgentGateway.DeepAgentKnowledgeSource.isConfigured()
      ? AgentGateway.DeepAgentKnowledgeSource.projectStoreFor(input.workspacePath).documentStore
      : DeepAgentDurableKnowledgeStore.openProjectStore(Global.Path.agent.data, input.workspacePath).documentStore
    const projectId = DeepAgentDurableKnowledgeStore.projectIdForWorkspace(input.workspacePath)
    const next = yield* Effect.sync(() => {
      const persist = (attemptsRemaining: number): DeepAgentContext.WorldState.WorldState => {
        const current = ProjectBridge.loadWorldStateForGoalWorker(projectStore, projectId)
        const candidate = WorldState.collectSlots(current, facts)
        try {
          ProjectBridge.persistWorldState(projectStore, candidate)
          return candidate
        } catch (error) {
          if (!(error instanceof DocumentConflictError) || attemptsRemaining === 0) throw error
          projectStore.rebuildIndex()
          return persist(attemptsRemaining - 1)
        }
      }
      return persist(4)
    })
    const sections = next.slots.map((slot) => {
      const sectionID = `world_state:${slot.kind}`
      const fragment = WorldState.renderSlot(slot)
      return {
        sectionID,
        snapshot: slot,
        fragment,
        fragmentHash: Hash.sha256(CanonicalJson.stringify({ sectionID, slot, fragment })),
      } satisfies SessionWorldStateBaselineSection
    })
    const rendered = renderSessionWorldStateBaseline(sections)
    const hash = sessionWorldStateBaselineHash({ sections, rendered })
    return { projectId, snapshot: next, sections, rendered, hash }
  })

export const renderSessionWorldStateBaseline = (
  sections: readonly Pick<SessionWorldStateBaselineSection, "sectionID" | "fragment">[],
): string => {
  if (sections.length === 0) return ""
  const ordered = orderSessionWorldStateBaselineSections(sections)
  return [
    "<world-state>",
    "Current environment / file / diagnostics facts (latest values, re-injected — trust these over any",
    "older values mentioned in the summary above):",
    "",
    ...ordered.map((section) => section.fragment),
    "</world-state>",
  ].join("\n")
}

export { contextStoreRoot }
