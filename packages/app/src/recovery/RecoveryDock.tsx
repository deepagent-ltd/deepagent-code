import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import type { MaintenanceClient } from "@/maintenance/maintenance-client"
import {
  blockedReason,
  descriptorDeadEnd,
  exitCommandInput,
  hasExecutableExit,
  initialDockState,
  pendingItems,
  queueActive,
  queuedPosition,
  reduceDock,
  type DockAction,
  type DockItem,
  type DockState,
  type Exit,
} from "./recovery-dock-state"

// C6-06 recovery dock (design §11.3 §9.1-9.2). It drives the pure `reduceDock`
// state machine: lists ALL pending descriptors, runs commands SERIAL per session
// (one in-flight, queue shown), passes network-unknown descriptors through a
// "核对中" (verifying) query-first path, and never shows a permanent disabled
// dead-end (a blocked descriptor renders a typed reason + coordination path).

export function RecoveryDock(props: { sessionId: string; client: MaintenanceClient; onPendingChange?: (pending: boolean) => void }) {
  const [state, setState] = createSignal<DockState>(initialDockState)
  const dispatch = (action: DockAction) => setState((prev) => reduceDock(prev, action))

  const load = async () => {
    dispatch({ type: "descriptorsLoaded", descriptors: [] })
    const result = await props.client.recoveryList(props.sessionId)
    if ("error" in result) dispatch({ type: "descriptorsFailed", code: result.error.data.code })
    else if ("failure" in result) dispatch({ type: "descriptorsFailed", code: "network_unreachable" })
    // C6-10 robustness: a degraded/partial payload must never crash the reducer —
    // an absent `descriptors` list is treated as "nothing pending" (fail-safe).
    else dispatch({ type: "descriptorsLoaded", descriptors: result.data.descriptors ?? [] })
  }

  createEffect(() => {
    void load()
  })

  createEffect(() => {
    props.onPendingChange?.(pendingItems(state()).length > 0 || state().loadStatus === "loading")
  })

  // Query-first ("核对中"): a network-unknown descriptor is re-queried before its
  // terminal options are shown, so a command is never offered on stale evidence.
  const runQuery = async (item: DockItem) => {
    dispatch({ type: "checkStarted", id: item.id })
    const input = exitCommandInput({ sessionId: props.sessionId, item, exit: { kind: "refresh", permission: "user", label: "refresh.query" }, actorType: "user" })
    const result = await props.client.recoveryCommand(input)
    if ("error" in result) {
      dispatch({ type: "checkBlocked", id: item.id, reason: result.error.data.code, coordination: { actor: "admin" } })
      return
    }
    if ("failure" in result) {
      dispatch({ type: "checkBlocked", id: item.id, reason: "network_unreachable", coordination: { actor: "admin" } })
      return
    }
    const exits = descriptorDeadEnd(result.data.descriptor)
    if (exits.kind === "exits") dispatch({ type: "checkResolved", id: item.id, exits: exits.exits })
    else dispatch({ type: "checkBlocked", id: item.id, reason: exits.reason, coordination: exits.coordination })
  }

  const runExit = async (item: DockItem, exit: Exit) => {
    dispatch({ type: "requestExit", id: item.id, exit })
    const input = exitCommandInput({ sessionId: props.sessionId, item, exit, actorType: exit.permission })
    const result = await props.client.recoveryCommand(input)
    const ok = !("error" in result) && !("failure" in result)
    dispatch({ type: "exitResolved", id: item.id, ok })
  }

  const exportEvidence = async () => {
    if (state().evidenceGate === "unchecked") return
    dispatch({ type: "exportStarted" })
    const result = await props.client.createRecoveryEvidenceExport({ session_id: props.sessionId })
    if ("error" in result) dispatch({ type: "exportFailed", code: result.error.data.code })
    else if ("failure" in result) dispatch({ type: "exportFailed", code: "network_unreachable" })
    else dispatch({ type: "exportDone" })
  }

  const pending = () => pendingItems(state())
  const show = () =>
    pending().length > 0 || state().loadStatus === "error" || queueActive(state()) || state().export.status === "error" || state().export.status === "done"

  return (
    <Show when={show()}>
      <div class="mb-2 flex flex-col gap-2">
      <Show when={state().loadStatus === "error"}>
        <div class="rounded-md border border-border-critical-base bg-surface-raised-base px-3 py-2.5 text-12-regular text-text-critical">
          Recovery list failed ({state().loadError})
          <button type="button" class="ml-2 underline" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </Show>

      <Show when={queueActive(state())}>
        <div class="rounded-md border border-border-warning-base bg-surface-raised-base px-3 py-2 text-12-regular text-text-warning">
          Serial command queue: {state().queue.length + (state().inFlight ? 1 : 0)} pending
        </div>
      </Show>

      <For each={pending()}>
        {(item) => (
          <RecoveryDockItem
            item={item}
            queuedAhead={queuedPosition(state(), item.id)}
            onQuery={() => void runQuery(item)}
            onExit={(exit) => void runExit(item, exit)}
          />
        )}
      </For>

      <Show when={hasEvidencePermission(state())}>
        <div class="mt-1 flex items-center gap-2">
          <Show when={state().evidenceGate === "unchecked"}>
            <button type="button" class="text-12-regular underline" onClick={() => dispatch({ type: "evidenceGate", state: "granted" })}>
              Grant evidence export
            </button>
          </Show>
          <Show when={state().evidenceGate === "denied"}>
            <span class="text-11-regular text-text-weak">Evidence export denied.</span>
          </Show>
          <Show when={state().evidenceGate === "granted"}>
            <button type="button" class="text-12-regular underline" disabled={state().export.status === "exporting"} onClick={() => void exportEvidence()}>
              {state().export.status === "exporting" ? "Exporting…" : "Export recovery evidence"}
            </button>
          </Show>
          <Show when={state().export.status === "error"}>
            <span class="text-11-regular text-text-critical">Export failed ({state().export.error})</span>
          </Show>
        </div>
      </Show>
      </div>
    </Show>
  )
}

function RecoveryDockItem(props: {
  item: DockItem
  queuedAhead: number
  onQuery: () => void
  onExit: (exit: Exit) => void
}) {
  // Narrow the item phase once into a flat view so JSX never touches a union member.
  const view = createMemo(() => {
    const phase = props.item.phase
    return {
      status: phase.status,
      kind: props.item.descriptor.descriptorKind,
      requestHash: props.item.descriptor.requestHash,
      exits: phase.status === "decided" ? phase.exits : undefined,
      exit: phase.status === "running" || phase.status === "result" ? phase.exit : undefined,
      ok: phase.status === "result" ? phase.ok : undefined,
      blocked: phase.status === "blocked" ? { reason: phase.reason, coordination: phase.coordination } : undefined,
    }
  })
  const blocked = () => blockedReason(props.item)
  return (
    <div class="mb-2 rounded-md border border-border-warning-base bg-surface-raised-base px-3 py-2.5">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div class="text-12-medium text-text-strong">{view().kind}</div>
          <div class="mt-1 truncate text-11-regular text-text-weak">{view().requestHash}</div>
        </div>
      </div>

      <Show when={view().status === "verifying"}>
        <div class="mt-2 text-12-regular text-text-warning">核对中… querying command first</div>
        <button type="button" class="mt-1 text-12-regular underline" onClick={props.onQuery}>
          Query command
        </button>
      </Show>

      <Show when={view().status === "decided"}>
        <div class="mt-2 flex flex-wrap gap-2">
          <For each={view().exits ?? []}>
            {(exit) => (
              <button
                type="button"
                class="rounded-md border border-border-weak-base px-2 py-1 text-12-regular"
                disabled={props.queuedAhead >= 0}
                onClick={() => props.onExit(exit)}
              >
                {exit.label} <span class="text-11-regular text-text-weak">({exit.permission})</span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={view().status === "running"}>
        <div class="mt-2 text-12-regular text-text-weak">Running {view().exit?.label}…</div>
      </Show>

      <Show when={view().status === "result"}>
        <div class="mt-2 text-12-regular text-text-weak">
          {view().exit?.label} {view().ok ? "succeeded" : "failed"}
        </div>
      </Show>

      <Show when={view().status === "blocked"}>
        <div class="mt-2 text-11-regular text-text-critical">
          No local exit in the current state: {blocked()?.reason}. Coordinate with {blocked()?.coordination.actor}
          {blocked()?.coordination.evidenceExportRef ? ` (evidence: ${blocked()?.coordination.evidenceExportRef})` : ""}.
        </div>
      </Show>

      <Show when={hasExecutableExit(props.item) === false && view().status !== "blocked" && view().status !== "result" && view().status !== "settled"}>
        <div class="mt-2 text-11-regular text-text-weak">No executable exit (query first).</div>
      </Show>
    </div>
  )
}

function hasEvidencePermission(state: DockState): boolean {
  return state.items.some((item) => requiresCoordination(item))
}

function requiresCoordination(item: DockItem): boolean {
  const reason = blockedReason(item)
  return reason !== undefined && reason.coordination.evidenceExportRef !== undefined
}
