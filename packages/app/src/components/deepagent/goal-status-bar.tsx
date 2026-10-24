import { Show, createEffect, createMemo, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { Icon } from "@deepagent-code/ui/icon"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { useServerSync } from "@/context/server-sync"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { GoalClient, type PanelGoalClient } from "./panel-goal.api"
import { GoalPlanEditDialog } from "./goal-plan-edit-dialog"

// GET status is the control authority. Old goal.updated events supply budget hints only.
// Requests retain their captured placement/Goal/revision until acknowledged or explicitly retried.
const PHASE_LABEL_KEY: Record<string, string> = {
  running: "composer.goal.phase.running",
  paused: "composer.goal.phase.paused",
  done: "composer.goal.phase.done",
  needs_human: "composer.goal.phase.needsHuman",
  rolled_back: "composer.goal.phase.rolledBack",
  stopped: "composer.goal.phase.stopped",
}

const PHASE_ICON: Record<string, Parameters<typeof Icon>[0]["name"]> = {
  running: "goal",
  paused: "circle-ban-sign",
  done: "circle-check",
  needs_human: "circle-x",
  rolled_back: "arrow-undo-down",
  stopped: "circle-x",
}

// Unknown descriptors remain strongly owned and consume admission capacity.
const pendingControls = new Map<string, { request: GoalClient.Descriptor; unknown: boolean }>()
const MAX_PENDING_CONTROLS = 32

export function GoalStatusBar(props: { sessionID: string }) {
  const serverSync = useServerSync()
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const [state, setState] = createStore<{
    busy?: GoalClient.Descriptor
    error?: string
    retry?: GoalClient.Descriptor
  }>({})
  const target = createMemo(() => ({
    client: sdk.client as unknown as PanelGoalClient,
    server: JSON.stringify([sdk.scope, sdk.url]),
    directory: sdk.directory,
    sessionID: props.sessionID,
  }))
  const goal = createMemo(() => (props.sessionID ? serverSync.data.session_goal[props.sessionID] : undefined))
  const control = () => goal()?.control
  const key = () => `${GoalClient.scopeKey(target())}\n${goal()?.goalId ?? ""}`
  const terminal = () => (control() ? GoalClient.confirmedTerminal(control()!) : false)
  const busy = () => !!state.busy
  const refresh = () => serverSync.goal.sync(target().directory, target().sessionID)

  createEffect(() => {
    const captured = target()
    setState({ busy: undefined, error: undefined, retry: undefined })
    let observed = false
    const read = () =>
      serverSync.goal
        .sync(captured.directory, captured.sessionID)
        .then(() => {
          observed = true
        })
        .catch((error: unknown) => {
          if (!disposed && target() === captured)
            setState("error", error instanceof Error ? error.message : String(error))
        })
    void untrack(read)
    // Read-only observation while the Goal is unresolved; this never schedules or wakes work.
    const timer = setInterval(() => {
      if (disposed || target() !== captured || (!goal() && observed) || terminal()) return
      void read()
    }, 5_000)
    onCleanup(() => clearInterval(timer))
  })
  createEffect(() => {
    const retry = pendingControls.get(key())?.request
    setState({ retry, error: undefined, busy: undefined })
  })

  const send = async (proposed: GoalClient.Descriptor) => {
    const captured = target()
    const requestKey = `${GoalClient.scopeKey(proposed.scope)}\n${"goalId" in proposed.body ? proposed.body.goalId : ""}`
    if (busy() || GoalClient.scopeKey(captured) !== GoalClient.scopeKey(proposed.scope)) return
    const retained = pendingControls.get(requestKey)
    if (retained && retained.request.body.requestID !== proposed.body.requestID) {
      setState({ retry: retained.request, error: language.t("goal.control.unknown") })
      return
    }
    if (!retained && pendingControls.size >= MAX_PENDING_CONTROLS) {
      setState("error", language.t("eventValidation.capacity"))
      return
    }
    // Solid store proxies are UI values; dispatch the retained original descriptor, never the proxy.
    const request = retained?.request ?? proposed
    pendingControls.set(requestKey, retained ?? { request, unknown: false })
    setState({ busy: request, error: undefined, retry: undefined })
    try {
      const snapshot = await GoalClient.send(request)
      if (pendingControls.get(requestKey)?.request === request) pendingControls.delete(requestKey)
      if (disposed || target() !== captured) return
      const current = goal()
      if (
        "goalId" in request.body &&
        current?.goalId === request.body.goalId &&
        snapshot.goalId === request.body.goalId &&
        GoalClient.accepts(current.control, snapshot)
      )
        serverSync.goal.set(
          captured.sessionID,
          { ...current, phase: snapshot.phase, control: snapshot },
          { source: "status" },
        )
    } catch (error) {
      const unknown = retained?.unknown === true || (error instanceof GoalClient.RequestError && error.unknownOutcome)
      const current = pendingControls.get(requestKey)
      if (unknown && current?.request === request) current.unknown = true
      if (!unknown && pendingControls.get(requestKey)?.request === request) pendingControls.delete(requestKey)
      if (disposed || target() !== captured || ("goalId" in request.body && goal()?.goalId !== request.body.goalId))
        return
      setState({ error: error instanceof Error ? error.message : String(error), retry: unknown ? request : undefined })
      // A conflict refreshes observation only. It never retargets or retries this command.
      await refresh().catch(() => undefined)
    } finally {
      if (!disposed && target() === captured && state.busy?.body.requestID === request.body.requestID)
        setState("busy", undefined)
    }
  }
  const mutate = (action: GoalClient.Action) => {
    const snapshot = control()
    if (busy() || state.retry || !GoalClient.canControl(snapshot, action)) return
    const captured = target()
    void send(
      GoalClient.capture(captured.client, captured, action, {
        sessionID: captured.sessionID,
        goalId: snapshot!.goalId,
        expectedRevision: snapshot!.revision,
        requestID: crypto.randomUUID(),
      }),
    )
  }
  const onDismiss = () => {
    if (terminal() && !busy()) serverSync.goal.set(target().sessionID, undefined)
  }
  const onEditPlan = () => {
    const captured = target()
    const goalID = control()?.goalId
    if (!goalID) return
    dialog.show(() => (
      <GoalPlanEditDialog
        scope={{
          server: captured.server,
          url: sdk.url,
          directory: captured.directory,
          sessionID: captured.sessionID,
          goalID,
        }}
        client={sdk.client}
        current={() =>
          !disposed &&
          target().client === captured.client &&
          target().server === captured.server &&
          target().directory === captured.directory &&
          target().sessionID === captured.sessionID &&
          control()?.goalId === goalID
        }
        onClose={() => {
          dialog.close()
          if (disposed || target() !== captured || control()?.goalId !== goalID) return
          void serverSync.goal.sync(captured.directory, captured.sessionID).catch(() => undefined)
        }}
      />
    ))
  }
  const phaseLabel = () => {
    const value = control()
    if (!value) return language.t("goal.control.checking")
    if (value.recoveryRequired || value.preparation === "recovery_required") {
      if (value.requestedPhase === "paused") return language.t("goal.control.pausedUnconfirmed")
      return language.t("goal.control.recovery")
    }
    if (value.preparation === "preparing") return language.t("goal.control.preparing")
    if (value.inFlight && value.requestedPhase === "paused") return language.t("goal.control.pauseRequested")
    if (value.inFlight && value.requestedPhase === "stopped") return language.t("goal.control.stopRequested")
    if (value.wakeState === "pending") return language.t("goal.control.pending")
    return PHASE_LABEL_KEY[value.phase] ? language.t(PHASE_LABEL_KEY[value.phase] as never) : value.phase
  }

  return (
    <Show when={goal()}>
      {(g) => (
        <div
          data-component="goal-status-bar"
          class="flex flex-wrap items-center gap-2 px-2.5 py-1.5 rounded-md bg-surface-raised-base border border-border-weak-base text-13-regular"
        >
          <Icon name={PHASE_ICON[g().phase] ?? "goal"} class="size-4 shrink-0 text-text-weak" />
          <span class="text-text-base font-medium">{phaseLabel()}</span>
          <Show when={g().ledger}>
            {(ledger) => (
              <span class="text-text-weak truncate">
                {language.t(ledger().ticks === 1 ? "composer.goal.budget.one" : "composer.goal.budget.other", {
                  ticks: ledger().ticks,
                  tokens: ledger().tokens.toLocaleString(),
                })}
              </span>
            )}
          </Show>
          <Show when={g().gaps.length > 0}>
            <span class="text-text-weak truncate italic">— {g().gaps[0]}</span>
          </Show>
          <div class="flex items-center gap-1 ml-auto shrink-0">
            <Show
              when={
                control()?.preparation === "ready" &&
                !control()?.recoveryRequired &&
                !(control()?.requestedPhase === "stopped" && control()?.inFlight) &&
                !["done", "rolled_back"].includes(control()?.requestedPhase ?? "done")
              }
            >
              <Button
                variant="ghost"
                size="small"
                class="h-7 px-2"
                disabled={busy() || !!state.retry}
                onClick={onEditPlan}
                aria-label={language.t("composer.goal.editPlan")}
              >
                <Icon name="edit" class="size-4" />
              </Button>
            </Show>
            <Show when={GoalClient.canControl(control(), "pause")}>
              <Button
                variant="ghost"
                size="small"
                class="h-7 px-2"
                disabled={busy() || !!state.retry}
                onClick={() => mutate("pause")}
              >
                {language.t("composer.goal.pause")}
              </Button>
            </Show>
            <Show when={GoalClient.canControl(control(), "resume")}>
              <Button
                variant="ghost"
                size="small"
                class="h-7 px-2"
                disabled={busy() || !!state.retry}
                onClick={() => mutate("resume")}
              >
                {language.t("composer.goal.resume")}
              </Button>
            </Show>
            <Show when={GoalClient.canControl(control(), "stop")}>
              <Button
                variant="ghost"
                size="small"
                class="size-7 p-0"
                disabled={busy() || !!state.retry}
                onClick={() => mutate("stop")}
                aria-label={language.t("composer.goal.stop")}
              >
                <Icon name="circle-ban-sign" class="size-4" />
              </Button>
            </Show>
            <Show when={terminal()}>
              <Button
                variant="ghost"
                size="small"
                class="size-7 p-0"
                onClick={onDismiss}
                aria-label={language.t("composer.goal.dismiss")}
              >
                <Icon name="close-small" class="size-4" />
              </Button>
            </Show>
          </div>
          <Show when={state.error}>
            <div role="alert" class="w-full text-text-weak break-words">
              {state.error}
            </div>
          </Show>
          <Show when={state.retry && "goalId" in state.retry.body && state.retry.body.goalId === goal()?.goalId}>
            <div class="flex flex-wrap items-center gap-2 w-full">
              <span class="text-text-weak">{language.t("goal.control.unknown")}</span>
              <Button size="small" disabled={busy()} onClick={() => state.retry && void send(state.retry)}>
                {language.t("goal.control.retry")}
              </Button>
            </div>
          </Show>
          <Show when={!control() || control()?.inFlight || control()?.recoveryRequired}>
            <Button size="small" variant="ghost" onClick={() => void refresh().catch(() => undefined)}>
              {language.t("goal.control.refresh")}
            </Button>
          </Show>
        </div>
      )}
    </Show>
  )
}
