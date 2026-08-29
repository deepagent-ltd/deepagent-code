import type { RecoveryDescriptor } from "@deepagent-code/core/contract/recovery-command"

// C6-06 recovery dock state machine (design §11.3 §9.1-9.2). Pure + dependency-free:
//   - lists ALL pending descriptors (not just the first);
//   - per-session command execution is SERIAL (one in-flight at a time, queue shown);
//   - network-unknown descriptors pass through a "核对中" (verifying) state that
//     queries the command BEFORE terminal options are shown;
//   - no permanent disabled dead-end: every descriptor yields either at least one
//     executable exit or a typed reason + the pending-coordination path.

export type ExitKind = "recover" | "abandon" | "repair" | "fork" | "confirm" | "refresh"

export interface Exit {
  kind: ExitKind
  /** The C0-03 permission hint (user/administrator/system) for this exit. */
  permission: "user" | "administrator" | "system"
  /** Stable label id (i18n is a LIC4 integration item). */
  label: string
}

export interface CoordinationPath {
  actor: "admin" | "external" | "provider_lookup"
  evidenceExportRef?: string
}

export type NoDeadEnd =
  | { kind: "exits"; exits: Exit[] }
  | { kind: "blocked"; reason: string; coordination: CoordinationPath }

export type ItemPhase =
  | { status: "pending" }
  | { status: "verifying" }
  | { status: "decided"; exits: readonly Exit[] }
  | { status: "blocked"; reason: string; coordination: CoordinationPath }
  | { status: "running"; exit: Exit }
  | { status: "result"; exit: Exit; ok: boolean }
  | { status: "settled" }

export interface DockItem {
  id: string
  descriptor: RecoveryDescriptor
  phase: ItemPhase
}

export type EvidenceGate = "unchecked" | "granted" | "denied"

/** A serialized command execution: the item id plus the exact exit the user chose. */
export interface QueuedExit {
  id: string
  exit: Exit
}

export interface DockState {
  items: readonly DockItem[]
  /** Per-session serial queue: executions waiting (one in-flight at a time). */
  queue: readonly QueuedExit[]
  /** The execution currently in flight, if any. */
  inFlight: QueuedExit | null
  loadStatus: "idle" | "loading" | "loaded" | "error"
  loadError: string | null
  evidenceGate: EvidenceGate
  export: { status: "idle" | "exporting" | "done" | "error"; error: string | null }
}

export const initialDockState: DockState = {
  items: [],
  queue: [],
  inFlight: null,
  loadStatus: "idle",
  loadError: null,
  evidenceGate: "unchecked",
  export: { status: "idle", error: null },
}

export type DockAction =
  | { type: "descriptorsLoaded"; descriptors: readonly RecoveryDescriptor[] }
  | { type: "descriptorsFailed"; code: string }
  | { type: "checkStarted"; id: string }
  | { type: "checkResolved"; id: string; exits: ReadonlyArray<Exit> }
  | { type: "checkBlocked"; id: string; reason: string; coordination: CoordinationPath }
  | { type: "requestExit"; id: string; exit: Exit }
  | { type: "exitResolved"; id: string; ok: boolean }
  | { type: "evidenceGate"; state: EvidenceGate }
  | { type: "exportStarted" }
  | { type: "exportDone" }
  | { type: "exportFailed"; code: string }
  | { type: "reset" }

// -- no-dead-end matrix (design §9.1-9.2) --------------------------------------

export function exitFor(kind: ExitKind): Exit {
  switch (kind) {
    case "recover":
      return { kind, permission: "user", label: "recover.resolve" }
    case "abandon":
      return { kind, permission: "user", label: "abandon.exact" }
    case "repair":
      return { kind, permission: "administrator", label: "repair.baseline" }
    case "fork":
      return { kind, permission: "user", label: "fork.boundary" }
    case "confirm":
      return { kind, permission: "administrator", label: "confirm.settled" }
    case "refresh":
      return { kind, permission: "user", label: "refresh.query" }
  }
}

/**
 * The authoritative no-dead-end matrix (design §9.1 labels). Every descriptor class
 * yields either one or more executable exits, or a typed blocker with a
 * coordination path. `resolved` is treated as a terminal descriptor whose only
 * exit is a re-query (refresh) so it is never a silent dead button.
 */
export function descriptorDeadEnd(descriptor: RecoveryDescriptor): NoDeadEnd {
  switch (descriptor.descriptorKind) {
    case "resolvable_exact":
      return { kind: "exits", exits: [exitFor("abandon"), exitFor("recover")] }
    case "repairable_exact":
      // Repair-or-abandon: the baseline can be rebuilt, or the exact abandoned.
      return { kind: "exits", exits: [exitFor("repair"), exitFor("abandon")] }
    case "fork_only":
      return { kind: "exits", exits: [exitFor("fork")] }
    case "coordination_required":
      // No provable local exit: a typed reason + the pending-coordination path.
      return {
        kind: "blocked",
        reason: descriptor.coordination.reason,
        coordination: { actor: descriptor.coordination.requiredActor, evidenceExportRef: descriptor.coordination.evidenceExportRef },
      }
    case "resolved":
      // Terminal descriptor: the only honest exit is a re-query (refresh).
      return { kind: "exits", exits: [exitFor("refresh")] }
  }
}

/**
 * A descriptor whose terminal evidence is unknown must be re-queried ("核对中")
 * before terminal options are shown. Network-unknown reason codes / provider_lookup
 * coordination require the query-first path (design §11.3).
 */
export function requiresVerification(descriptor: RecoveryDescriptor): boolean {
  switch (descriptor.descriptorKind) {
    case "fork_only":
      return descriptor.fork.reasonCode === "network_unknown" || descriptor.fork.originalSessionReadOnly
    case "coordination_required":
      return descriptor.coordination.reason === "network_unknown" || descriptor.coordination.requiredActor === "provider_lookup"
    default:
      return false
  }
}

export function descriptorId(descriptor: RecoveryDescriptor): string {
  // Identify a descriptor by its request hash + class (stable, no secrets).
  return `${descriptor.requestHash}:${descriptor.descriptorKind}`
}

function decidedPhase(descriptor: RecoveryDescriptor): ItemPhase {
  const outcome = descriptorDeadEnd(descriptor)
  if (outcome.kind === "exits") return { status: "decided", exits: outcome.exits }
  return { status: "blocked", reason: outcome.reason, coordination: outcome.coordination }
}

function toItem(descriptor: RecoveryDescriptor): DockItem {
  const phase: ItemPhase = requiresVerification(descriptor) ? { status: "verifying" } : decidedPhase(descriptor)
  return { id: descriptorId(descriptor), descriptor, phase }
}

function withRunning(items: readonly DockItem[], id: string, exit: Exit): readonly DockItem[] {
  return items.map((item) => (item.id === id ? { ...item, phase: { status: "running", exit } } : item))
}

/** Pop the next queued execution and start it (serial: exactly one in flight). */
function advance(state: DockState): DockState {
  const next = state.queue[0]
  if (!next) return state
  return {
    ...state,
    items: withRunning(state.items, next.id, next.exit),
    queue: state.queue.slice(1),
    inFlight: next,
  }
}

export function reduceDock(state: DockState, action: DockAction): DockState {
  switch (action.type) {
    case "descriptorsLoaded":
      return { ...state, items: action.descriptors.map(toItem), loadStatus: "loaded", loadError: null }
    case "descriptorsFailed":
      return { ...state, loadStatus: "error", loadError: action.code }
    case "checkStarted":
      return { ...state, items: state.items.map((item) => (item.id === action.id ? { ...item, phase: { status: "verifying" } } : item)) }
    case "checkResolved":
      // A completed query presents the descriptor's executable exits (never a dead button).
      return {
        ...state,
        items: state.items.map((item) => (item.id === action.id ? { ...item, phase: { status: "decided", exits: action.exits } } : item)),
      }
    case "checkBlocked":
      return {
        ...state,
        items: state.items.map((item) =>
          item.id === action.id ? { ...item, phase: { status: "blocked", reason: action.reason, coordination: action.coordination } } : item,
        ),
      }
    case "requestExit": {
      // Serialize: start now when idle, otherwise enqueue (deduped by id).
      if (state.inFlight) {
        const alreadyQueued = state.queue.some((queued) => queued.id === action.id)
        if (alreadyQueued) return state
        return { ...state, queue: [...state.queue, { id: action.id, exit: action.exit }] }
      }
      return { ...state, items: withRunning(state.items, action.id, action.exit), inFlight: { id: action.id, exit: action.exit } }
    }
    case "exitResolved":
      return advance({
        ...state,
        inFlight: null,
        items: state.items.map((item) =>
          item.id === action.id && item.phase.status === "running"
            ? { ...item, phase: { status: "result", exit: item.phase.exit, ok: action.ok } }
            : item,
        ),
      })
    case "evidenceGate":
      return { ...state, evidenceGate: action.state }
    case "exportStarted":
      return { ...state, export: { status: "exporting", error: null } }
    case "exportDone":
      return { ...state, export: { status: "done", error: null } }
    case "exportFailed":
      return { ...state, export: { status: "error", error: action.code } }
    case "reset":
      return initialDockState
  }
}

// -- derived helpers ----------------------------------------------------

/** Items that still need attention (everything not yet terminal) — the dock lists ALL of them. */
export function pendingItems(state: DockState): readonly DockItem[] {
  return state.items.filter((item) => item.phase.status !== "result" && item.phase.status !== "settled")
}

/** True while something is in flight or queued (serial execution active). */
export function queueActive(state: DockState): boolean {
  return state.inFlight !== null || state.queue.length > 0
}

/** The 0-based position of an item in the serial queue, or -1. */
export function queuedPosition(state: DockState, id: string): number {
  return state.queue.findIndex((queued) => queued.id === id)
}

/** A descriptor with an executable exit in the current state (not a dead-end). */
export function hasExecutableExit(item: DockItem): boolean {
  return item.phase.status === "decided" && item.phase.exits.length > 0
}

/** The typed reason + coordination path for a blocked descriptor (no dead button). */
export function blockedReason(item: DockItem): { reason: string; coordination: CoordinationPath } | undefined {
  return item.phase.status === "blocked" ? { reason: item.phase.reason, coordination: item.phase.coordination } : undefined
}

/** Build the recoveryCommand input a user exit maps to (session-scoped, hash-addressed). */
export function exitCommandInput(input: {
  sessionId: string
  item: DockItem
  exit: Exit
  actorType: "user" | "administrator" | "system"
}): {
  session_id: string
  attempt_id: string
  request_hash: string
  actor_type: "user" | "administrator" | "system"
  actor_id: string
} {
  const descriptor = input.item.descriptor
  return {
    session_id: input.sessionId,
    attempt_id: `${descriptor.requestHash}:${descriptor.descriptorKind}`,
    request_hash: descriptor.requestHash,
    actor_type: input.actorType,
    actor_id: input.actorType,
  }
}
