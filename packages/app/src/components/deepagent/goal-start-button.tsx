import { Show, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { Icon } from "@deepagent-code/ui/icon"
import { useServerSync } from "@/context/server-sync"
import { useSDK } from "@/context/sdk"
import { useLocal } from "@/context/local"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { fetchCapabilities, fetchGoalStartable, GoalClient, type PanelGoalClient } from "./panel-goal.api"

// The collaboration modes where "convert plan → supervised goal" makes sense. loop/design are BOTH
// powered by the Goal Loop engine and are designed to have the human START the loop after the plan is
// authored (loop: agent writes goal+plan.md; design: user writes it). auto is autonomous end-to-end in
// the current turn — a supervised background goal would be a confusing, redundant second door there, so
// the button must NOT appear in auto. plan is hidden and never the client-visible current mode.
const GOAL_MODES = new Set(["loop", "design"])
// Unknown descriptors occupy their slot until the original command has a known outcome.
const pendingStarts = new Map<string, { request: GoalClient.Descriptor; unknown: boolean }>()
const MAX_PENDING_STARTS = 32

// Start against the captured placement and retain an unknown request for explicit reconciliation.
// The server reads the existing plan; a successful control receipt does not prove execution began.
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
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const [state, setState] = createStore<{ busy?: string; retry?: GoalClient.Descriptor; error?: string }>({})
  const target = createMemo(() => ({
    client: sdk.client as unknown as PanelGoalClient,
    server: JSON.stringify([sdk.scope, sdk.url]),
    directory: sdk.directory,
    sessionID: props.sessionID,
  }))
  const busy = () => !!state.busy
  createEffect(() =>
    setState({ busy: undefined, retry: pendingStarts.get(GoalClient.scopeKey(target()))?.request, error: undefined }),
  )

  const [capabilities] = createResource(
    () => (props.sessionID ? target() : undefined),
    (captured) => fetchCapabilities(captured.client),
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
        ? ([target(), serverSync.data.session_plan[props.sessionID]?.steps.length ?? 0] as const)
        : undefined,
    ([captured]) => fetchGoalStartable(captured.client, captured.sessionID),
  )

  const show = createMemo(
    () => !!state.retry || (goalAvailable() && modeAllows() && !activeGoal() && startable()?.startable === true),
  )

  const onStart = async () => {
    if (busy() || !props.sessionID) return
    const captured = target()
    const key = GoalClient.scopeKey(captured)
    if (!pendingStarts.has(key) && pendingStarts.size >= MAX_PENDING_STARTS) {
      setState("error", language.t("eventValidation.capacity"))
      return
    }
    const retained = pendingStarts.get(key)
    const request =
      retained?.request ??
      GoalClient.capture(captured.client, captured, "start", {
        sessionID: captured.sessionID,
        requestID: crypto.randomUUID(),
      })
    pendingStarts.set(key, retained ?? { request, unknown: false })
    setState({ busy: request.body.requestID, error: undefined })
    try {
      const snapshot = await GoalClient.send(request)
      if (pendingStarts.get(key)?.request === request) pendingStarts.delete(key)
      if (disposed || target() !== captured) return
      setState("retry", undefined)
      const current = activeGoal()
      if (current && current.goalId !== snapshot.goalId) return
      if (!current || (current.goalId === snapshot.goalId && GoalClient.accepts(current.control, snapshot)))
        serverSync.goal.set(
          captured.sessionID,
          {
            goalId: snapshot.goalId,
            planDocId: snapshot.planDocId,
            phase: snapshot.phase,
            control: snapshot,
            ledger: current?.ledger ?? { ticks: 0, tokens: 0, cost: 0, wallclockMs: 0 },
            stallCount: current?.stallCount ?? 0,
            gaps: current?.gaps ?? [],
          },
          { source: "status" },
        )
      showToast({ title: language.t("goal.control.accepted"), variant: "success" })
    } catch (error) {
      const unknown = retained?.unknown === true || (error instanceof GoalClient.RequestError && error.unknownOutcome)
      const current = pendingStarts.get(key)
      if (unknown && current?.request === request) current.unknown = true
      if (!unknown && pendingStarts.get(key)?.request === request) pendingStarts.delete(key)
      if (disposed || target() !== captured) return
      setState({ error: errorMessage(error), retry: unknown ? request : undefined })
      await serverSync.goal.sync(captured.directory, captured.sessionID).catch(() => undefined)
    } finally {
      if (!disposed && target() === captured && state.busy === request.body.requestID) setState("busy", undefined)
    }
  }

  return (
    <Show when={show()}>
      <div
        data-component="goal-start-button"
        class="flex flex-wrap items-center gap-2 px-2.5 py-1.5 rounded-md bg-surface-raised-base border border-border-weak-base text-13-regular"
      >
        <Icon name="goal" class="size-4 shrink-0 text-text-weak" />
        <span class="text-text-weak truncate">{language.t("goal.start.hint")}</span>
        <Button
          variant="primary"
          size="small"
          class="h-7 px-2 ml-auto shrink-0"
          disabled={busy()}
          onClick={onStart}
          aria-label={language.t(state.retry ? "goal.control.retry" : "goal.start.button")}
        >
          {language.t(state.retry ? "goal.control.retry" : "goal.start.button")}
        </Button>
        <Show when={state.error}>
          <div role="alert" class="w-full text-text-weak break-words">
            {state.error}
          </div>
        </Show>
        <Show when={state.retry}>
          <span class="w-full text-text-weak">{language.t("goal.control.unknown")}</span>
        </Show>
      </div>
    </Show>
  )
}
