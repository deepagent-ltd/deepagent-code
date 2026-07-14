import { Show, createMemo, createSignal } from "solid-js"
import { Button } from "@deepagent-code/ui/button"
import { Icon } from "@deepagent-code/ui/icon"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { useServerSync } from "@/context/server-sync"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { pauseGoal, resumeGoal, stopGoal, type PanelGoalClient } from "./panel-goal.api"
import { GoalPlanEditDialog } from "./goal-plan-edit-dialog"

/**
 * V3.9 §D — the Goal status bar. Renders above the composer when a goal is running for this session
 * (Codex thread-goal style): the phase, a live token/tick budget readout, and pause/resume/stop
 * controls. Reads the persistent session_goal store fed by the goal.updated event, so it stays visible
 * while the background loop ticks and after a terminal phase (until the user starts a new goal).
 */

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

const isTerminal = (phase: string) =>
  phase === "done" || phase === "rolled_back" || phase === "stopped" || phase === "needs_human"

export function GoalStatusBar(props: { sessionID: string }) {
  const serverSync = useServerSync()
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)

  const goal = createMemo(() => (props.sessionID ? serverSync.data.session_goal[props.sessionID] : undefined))
  const client = () => sdk.client as unknown as PanelGoalClient

  const running = () => goal()?.phase === "running"
  const paused = () => goal()?.phase === "paused"
  const terminal = () => {
    const g = goal()
    return g ? isTerminal(g.phase) : false
  }

  const withBusy = (fn: () => Promise<unknown>) => async () => {
    if (busy()) return
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const onPause = withBusy(() => pauseGoal(client(), props.sessionID))
  const onResume = withBusy(() => resumeGoal(client(), props.sessionID))
  const onStop = withBusy(() => stopGoal(client(), props.sessionID))
  const onDismiss = () => serverSync.goal.set(props.sessionID, undefined)
  // §S2 — open the plan hot-edit dialog, pre-filled from the live session_plan (the same plan this bar
  // reads). Only offered for a non-terminal goal (the backend refuses an edit once terminal anyway).
  const onEditPlan = () =>
    dialog.show(() => (
      <GoalPlanEditDialog
        sessionID={props.sessionID}
        plan={serverSync.data.session_plan[props.sessionID]}
        client={client()}
        onClose={() => dialog.close()}
      />
    ))

  const tokens = () => goal()?.ledger.tokens ?? 0
  const ticks = () => goal()?.ledger.ticks ?? 0

  return (
    <Show when={goal()}>
      {(g) => (
        <div
          data-component="goal-status-bar"
          class="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-surface-raised border border-border-subtle text-13-regular"
        >
          <Icon name={PHASE_ICON[g().phase] ?? "goal"} class="size-4 shrink-0 text-text-muted" />
          <span class="text-text-base font-medium">
            {PHASE_LABEL_KEY[g().phase] ? language.t(PHASE_LABEL_KEY[g().phase] as never) : g().phase}
          </span>
          <span class="text-text-muted truncate">
            {language.t(ticks() === 1 ? "composer.goal.budget.one" : "composer.goal.budget.other", {
              ticks: ticks(),
              tokens: tokens().toLocaleString(),
            })}
          </span>
          <Show when={g().gaps.length > 0}>
            <span class="text-text-muted truncate italic">— {g().gaps[0]}</span>
          </Show>
          <div class="flex items-center gap-1 ml-auto shrink-0">
            <Show when={!terminal()}>
              <Button
                variant="ghost"
                size="small"
                class="h-7 px-2"
                disabled={busy()}
                onClick={onEditPlan}
                aria-label={language.t("composer.goal.editPlan")}
              >
                <Icon name="edit" class="size-4" />
              </Button>
            </Show>
            <Show when={running()}>
              <Button variant="ghost" size="small" class="h-7 px-2" disabled={busy()} onClick={onPause}>
                {language.t("composer.goal.pause")}
              </Button>
            </Show>
            <Show when={paused()}>
              <Button variant="ghost" size="small" class="h-7 px-2" disabled={busy()} onClick={onResume}>
                {language.t("composer.goal.resume")}
              </Button>
            </Show>
            <Show when={!terminal()}>
              <Button variant="ghost" size="small" class="size-7 p-0" disabled={busy()} onClick={onStop} aria-label={language.t("composer.goal.stop")}>
                <Icon name="circle-ban-sign" class="size-4" />
              </Button>
            </Show>
            <Show when={terminal()}>
              <Button variant="ghost" size="small" class="size-7 p-0" onClick={onDismiss} aria-label={language.t("composer.goal.dismiss")}>
                <Icon name="close-small" class="size-4" />
              </Button>
            </Show>
          </div>
        </div>
      )}
    </Show>
  )
}
