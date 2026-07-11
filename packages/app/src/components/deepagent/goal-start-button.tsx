import { Show, createMemo, createResource, createSignal } from "solid-js"
import { Button } from "@deepagent-code/ui/button"
import { Icon } from "@deepagent-code/ui/icon"
import { useServerSync } from "@/context/server-sync"
import { useSDK } from "@/context/sdk"
import { useLocal } from "@/context/local"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { fetchCapabilities, fetchGoalStartable, startGoal, type PanelGoalClient } from "./panel-goal.api"

// The collaboration modes where "convert plan → supervised goal" makes sense. loop/design are BOTH
// powered by the Goal Loop engine and are designed to have the human START the loop after the plan is
// authored (loop: agent writes goal+plan.md; design: user writes it). auto is autonomous end-to-end in
// the current turn — a supervised background goal would be a confusing, redundant second door there, so
// the button must NOT appear in auto. plan is hidden and never the client-visible current mode.
const GOAL_MODES = new Set(["loop", "design"])

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
// The raw SDK client THROWS the parsed error BODY on a non-2xx response — which is a plain object,
// not an Error. So `String(err)` yields "[object Object]". Extract a human-readable message from the
// shapes the server returns: a 400 DeepAgentPromotionError `{message}`, or a 500 `{data:{message}}`.
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === "object") {
    const o = err as { message?: unknown; data?: { message?: unknown } }
    if (typeof o.message === "string") return o.message
    if (o.data && typeof o.data.message === "string") return o.data.message
  }
  return String(err)
}

export function GoalStartButton(props: { sessionID: string }) {
  const sdk = useSDK()
  const serverSync = useServerSync()
  const local = useLocal()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)

  const client = () => sdk.client as unknown as PanelGoalClient

  const [capabilities] = createResource(
    () => (props.sessionID ? "capabilities" : undefined),
    () => fetchCapabilities(client()),
  )
  const goalAvailable = createMemo(() => capabilities()?.goalLoop === true)

  // The current collaboration mode (auto/loop/design) — the button only applies to loop/design. Sourced
  // from local.agent.current() (session-scoped mode selection), the same source the mode selector uses.
  const currentMode = createMemo(() => local.agent.current()?.name)
  const modeAllows = createMemo(() => GOAL_MODES.has(currentMode() ?? ""))

  // A goal is "live" for this session iff the persistent session_goal pointer exists — while present,
  // GoalStatusBar owns the surface. Checked FIRST so we don't probe startability for an already-running
  // goal.
  const activeGoal = createMemo(() => (props.sessionID ? serverSync.data.session_goal[props.sessionID] : undefined))

  // Whether a plan actually exists to start, resolved server-side (session_plan OR repo goal+plan.md).
  // Re-fetched when the session, mode-eligibility, active-goal, or the in-session plan changes — the last
  // dependency makes the button appear promptly after the agent writes a plan mid-conversation. Only
  // probed when the mode allows and no goal is live, to avoid needless requests.
  const [startable] = createResource(
    () =>
      props.sessionID && goalAvailable() && modeAllows() && !activeGoal()
        ? ([props.sessionID, serverSync.data.session_plan[props.sessionID]?.steps.length ?? 0] as const)
        : undefined,
    ([sessionID]) => fetchGoalStartable(client(), sessionID),
  )

  const show = createMemo(
    () => goalAvailable() && modeAllows() && !activeGoal() && startable()?.startable === true,
  )

  const onStart = async () => {
    if (busy() || !props.sessionID) return
    setBusy(true)
    try {
      const snapshot = await startGoal(client(), { sessionID: props.sessionID })
      if (!snapshot) {
        showToast({ title: language.t("goal.start.failed") })
      } else {
        // The server emits an immediate goal.updated (phase=running) on start, so GoalStatusBar takes
        // over this surface right away. This toast is the belt-and-suspenders confirmation for the click.
        showToast({ title: language.t("goal.start.success"), variant: "success" })
      }
    } catch (err) {
      showToast({ title: language.t("goal.start.failed"), description: errorMessage(err) })
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
