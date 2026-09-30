import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import type { MaintenanceClient } from "@/maintenance/maintenance-client"
import { useLanguage } from "@/context/language"
import {
  blockedReason,
  descriptorDeadEnd,
  exitCommandInput,
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
import { executionStatusOf, type ExecutionStatusView } from "./recovery-lifecycle-state"
import { useSessionLifecycle } from "./session-lifecycle"

// C6-06 recovery dock (design §11.3 §9.1-9.2). It drives the pure `reduceDock`
// state machine: lists ALL pending descriptors, runs commands SERIAL per session
// (one in-flight, queue shown), passes network-unknown descriptors through a
// "核对中" (verifying) query-first path, and never shows a permanent disabled
// dead-end (a blocked descriptor renders a typed reason + coordination path).
//
// W9.5 — the dock also observes the per-session execution track wired through
// `useSessionLifecycle()` (the durable journal pump): the current session's open
// turn or last terminal outcome surfaces as one compact status line. It renders
// ONLY when real execution data exists, so a session that never ran a turn has
// zero pixel surface.
//
// W9.6 — product ruling (kept): an idle session whose FIRST turn already settled
// keeps showing its last terminal outcome. That is the desired "execution
// summary" semantics of the dock (recovery/status context — the user can see at
// a glance what the session last did), not a stale-zero-pixel bug. Only a session
// that NEVER executed anything stays hidden.

export function RecoveryDock(props: {
  sessionId: string
  client: MaintenanceClient
  onPendingChange?: (pending: boolean) => void
}) {
  const [state, setState] = createSignal<DockState>(initialDockState)
  const dispatch = (action: DockAction) => setState((prev) => reduceDock(prev, action))
  const lifecycle = useSessionLifecycle()
  const language = useLanguage()

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
    props.onPendingChange?.(
      pendingItems(state()).some((item) => item.descriptor.descriptorKind !== "resolved") ||
        state().loadStatus === "loading",
    )
  })

  // Query-first ("核对中"): a network-unknown descriptor is re-queried before its
  // terminal options are shown, so a command is never offered on stale evidence.
  const runQuery = async (item: DockItem) => {
    dispatch({ type: "checkStarted", id: item.id })
    const input = exitCommandInput({
      sessionId: props.sessionId,
      item,
      exit: { kind: "refresh", permission: "user", label: "refresh.query" },
      actorType: "user",
    })
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

  // A completed historical descriptor is diagnostic history, not a request for user action.
  const pending = () => pendingItems(state()).filter((item) => item.descriptor.descriptorKind !== "resolved")
  const executionStatus = () => {
    const sessionState = lifecycle?.snapshot().sessions.get(props.sessionId)
    return sessionState ? executionStatusOf(sessionState) : undefined
  }
  const show = () =>
    pending().length > 0 ||
    executionStatus() !== undefined ||
    state().loadStatus === "error" ||
    queueActive(state()) ||
    state().export.status === "error" ||
    state().export.status === "done"

  return (
    <Show when={show()}>
      <div class="mb-2 flex flex-col gap-2">
        <Show when={executionStatus() !== undefined}>
          <div class="rounded-md border border-border-weak-base bg-surface-raised-base px-3 py-2 text-12-regular text-text-weak">
            {executionLabel(language, executionStatus()!)}
          </div>
        </Show>
        <Show when={state().loadStatus === "error"}>
          <div class="rounded-md border border-border-critical-base bg-surface-raised-base px-3 py-2.5 text-12-regular text-text-critical">
            {language.t("recovery.list.failed")}
            <button type="button" class="ml-2 underline" onClick={() => void load()}>
              {language.t("recovery.list.retry")}
            </button>
            <details class="mt-1 text-text-weak">
              <summary>{language.t("recovery.details")}</summary>
              {state().loadError}
            </details>
          </div>
        </Show>

        <Show when={queueActive(state())}>
          <div class="rounded-md border border-border-warning-base bg-surface-raised-base px-3 py-2 text-12-regular text-text-warning">
            {language.t("recovery.queue.pending")}
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
              <button
                type="button"
                class="text-12-regular underline"
                onClick={() => dispatch({ type: "evidenceGate", state: "granted" })}
              >
                {language.t("recovery.evidence.grant")}
              </button>
            </Show>
            <Show when={state().evidenceGate === "denied"}>
              <span class="text-11-regular text-text-weak">{language.t("recovery.evidence.denied")}</span>
            </Show>
            <Show when={state().evidenceGate === "granted"}>
              <button
                type="button"
                class="text-12-regular underline"
                disabled={state().export.status === "exporting"}
                onClick={() => void exportEvidence()}
              >
                {language.t(
                  state().export.status === "exporting" ? "recovery.evidence.exporting" : "recovery.evidence.export",
                )}
              </button>
            </Show>
            <Show when={state().export.status === "error"}>
              <span class="text-11-regular text-text-critical">{language.t("recovery.evidence.failed")}</span>
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
  const language = useLanguage()
  // Narrow the item phase once into a flat view so JSX never touches a union member.
  const view = createMemo(() => {
    const phase = props.item.phase
    return {
      status: phase.status,
      kind: props.item.descriptor.descriptorKind,
      requestHash: props.item.descriptor.requestHash,
      exits: phase.status === "decided" ? phase.exits : undefined,
      ok: phase.status === "result" ? phase.ok : undefined,
    }
  })
  const title = () => {
    if (view().status === "verifying") return language.t("recovery.unknown.title")
    if (view().kind === "coordination_required") return language.t("recovery.coordination.title")
    if (view().kind === "repairable_exact") return language.t("recovery.repair.title")
    if (view().kind === "fork_only") return language.t("recovery.fork.title")
    return language.t("recovery.exact.title")
  }
  const description = () => {
    if (view().status === "verifying") return language.t("recovery.unknown.description")
    if (view().kind === "coordination_required") return language.t("recovery.coordination.description")
    if (view().kind === "repairable_exact") return language.t("recovery.repair.description")
    if (view().kind === "fork_only") return language.t("recovery.fork.description")
    return language.t("recovery.exact.description")
  }
  const actions = {
    recover: "recovery.action.recover",
    abandon: "recovery.action.abandon",
    repair: "recovery.action.repair",
    fork: "recovery.action.fork",
    confirm: "recovery.action.confirm",
    refresh: "recovery.action.refresh",
  } as const
  return (
    <div class="mb-2 rounded-md border border-border-warning-base bg-surface-raised-base px-3 py-2.5">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div class="text-12-medium text-text-strong">{title()}</div>
          <div class="mt-1 text-12-regular text-text-weak">{description()}</div>
        </div>
      </div>

      <Show when={view().status === "verifying"}>
        <button type="button" class="mt-2 text-12-regular underline" onClick={props.onQuery}>
          {language.t("recovery.check")}
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
                {language.t(actions[exit.kind])}
                <Show when={exit.permission === "administrator"}> {language.t("recovery.action.admin")}</Show>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={view().status === "running"}>
        <div class="mt-2 text-12-regular text-text-weak">{language.t("recovery.action.running")}</div>
      </Show>

      <Show when={view().status === "result"}>
        <div class="mt-2 text-12-regular text-text-weak">
          {language.t(view().ok ? "recovery.action.succeeded" : "recovery.action.failed")}
        </div>
      </Show>

      <Show when={view().status === "blocked"}>
        <div class="mt-2 text-11-regular text-text-critical">{language.t("recovery.blocked")}</div>
      </Show>

      <a
        class="mt-2 inline-block text-12-regular underline text-text-base"
        href="https://github.com/deepagent-ltd/deepagent-code/issues/new?template=bug-report.yml"
        target="_blank"
        rel="noopener noreferrer"
      >
        {language.t("recovery.report")}
      </a>
      <details class="mt-1 text-11-regular text-text-weak">
        <summary>{language.t("recovery.details")}</summary>
        <code class="break-all">{view().requestHash}</code>
      </details>
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

/** One compact line for the per-session execution track (W9.6: i18n keys; the `state` token is
 * the machine state vocabulary — kept raw, like the dock's other state literals). */
function executionLabel(language: ReturnType<typeof useLanguage>, status: ExecutionStatusView): string {
  if (status.kind === "running") return language.t("recovery.execution.running", { number: status.number })
  if (status.state === "succeeded") return language.t("recovery.execution.succeeded", { number: status.number })
  if (status.state === "interrupted") return language.t("recovery.execution.interrupted", { number: status.number })
  return language.t("recovery.execution.failed", { number: status.number })
}
