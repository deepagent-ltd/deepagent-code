import { Show, createMemo, createResource, createSignal } from "solid-js"
import { Button } from "@deepagent-code/ui/button"
import { Icon } from "@deepagent-code/ui/icon"
import { useServerSync } from "@/context/server-sync"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { fetchCapabilities, startGoal, type PanelGoalClient } from "./panel-goal.api"

/**
 * V3.9 §D — "convert plan → goal" starter.
 *
 * The product path (per the goal-loop design): the user first produces a plan in plan mode, then
 * converts it into a supervised long-running goal. `startGoal({ sessionID })` with NO objective makes
 * the server read the session's existing plan (GoalManager.start → getPlan) and materialize it as the
 * goal carrier — so this button is a pure trigger with zero backend change.
 *
 * Visibility: only when goalLoop is enabled (capability), a plan exists for this session, and no goal
 * is already active (once a goal starts, GoalStatusBar takes over via the goal.updated event).
 */
export function GoalStartButton(props: { sessionID: string }) {
  const sdk = useSDK()
  const serverSync = useServerSync()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)

  const client = () => sdk.client as unknown as PanelGoalClient

  const [capabilities] = createResource(
    () => (props.sessionID ? "capabilities" : undefined),
    () => fetchCapabilities(client()),
  )
  const goalAvailable = createMemo(() => capabilities()?.goalLoop === true)

  const plan = createMemo(() => (props.sessionID ? serverSync.data.session_plan[props.sessionID] : undefined))
  const hasPlan = createMemo(() => (plan()?.steps.length ?? 0) > 0)

  // A goal is "live" for this session iff the persistent session_goal pointer exists and is not in a
  // terminal phase the user has dismissed — while present, GoalStatusBar owns the surface.
  const activeGoal = createMemo(() => (props.sessionID ? serverSync.data.session_goal[props.sessionID] : undefined))

  const show = createMemo(() => goalAvailable() && hasPlan() && !activeGoal())

  const onStart = async () => {
    if (busy() || !props.sessionID) return
    setBusy(true)
    try {
      const snapshot = await startGoal(client(), { sessionID: props.sessionID })
      if (!snapshot) {
        showToast({ title: language.t("goal.start.failed") })
      }
      // On success the goal.updated event drives GoalStatusBar to appear; nothing to do here.
    } catch (err) {
      const description = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("goal.start.failed"), description })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={show()}>
      <div
        data-component="goal-start-button"
        class="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-surface-raised border border-border-subtle text-13-regular"
      >
        <Icon name="status-active" class="size-4 shrink-0 text-text-muted" />
        <span class="text-text-muted truncate">{language.t("goal.start.hint")}</span>
        <Button
          variant="primary"
          size="small"
          class="h-7 px-2 ml-auto shrink-0"
          disabled={busy()}
          onClick={onStart}
          aria-label={language.t("goal.start.button")}
        >
          {language.t("goal.start.button")}
        </Button>
      </div>
    </Show>
  )
}
