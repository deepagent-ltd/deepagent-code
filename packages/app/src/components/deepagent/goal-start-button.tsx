import { Show, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { Icon } from "@deepagent-code/ui/icon"
import { Dialog, DialogFooter } from "@deepagent-code/ui/v2/dialog-v2"
import { useDialog } from "@deepagent-code/ui/context/dialog"
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
// the button must NOT appear in auto. plan executes only after approving its displayed snapshot.
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
  const dialog = useDialog()
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const [state, setState] = createStore<{ busy?: string; retry?: GoalClient.Descriptor; error?: string }>({})
  const [form, setForm] = createStore({
    source: "session",
    preset: "default",
    commands: "",
    codeRefs: "",
    diagnostics: "none",
    reviewer: "none",
  })
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

  // The next activity collaboration mode (auto/plan/loop/design) — the button only applies to loop/design. Sourced
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
    const request = (() => {
      if (retained) return retained.request
      const criteria: NonNullable<GoalClient.StartInput["criteria"]>[number][] = [{ kind: "plan_complete" }]
      const commands = form.commands
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
      if (commands.length) criteria.push({ kind: "tests_pass", commands })
      if (form.diagnostics !== "none") criteria.push({ kind: "no_diagnostics", severityAtMost: form.diagnostics })
      if (form.reviewer !== "none") criteria.push({ kind: "reviewer_clean", maxSeverity: form.reviewer })
      return GoalClient.capture(captured.client, captured, "start", {
        sessionID: captured.sessionID,
        requestID: crypto.randomUUID(),
        ...(form.preset === "custom" ? { criteria } : {}),
        ...(form.source === "workspace-file" ? { planSource: "workspace-file" as const } : {}),
        codeRefs: form.codeRefs
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      })
    })()
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

  const openStart = () => {
    if (state.retry) {
      void onStart()
      return
    }
    const captured = target()
    dialog.show(() => (
      <Dialog size="large" title={language.t("goal.start.form.title")}>
        <div class="flex flex-col gap-4 p-2" data-component="goal-start-form">
          <label class="flex flex-col gap-1">
            {language.t("goal.start.form.source")}
            <select
              aria-label={language.t("goal.start.form.source")}
              value={form.source}
              onChange={(event) => setForm("source", event.currentTarget.value)}
            >
              <option value="session">{language.t("goal.start.form.sessionPlan")}</option>
              <option value="workspace-file">{language.t("goal.start.form.workspacePlan")}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            {language.t("goal.start.form.criteria")}
            <select
              aria-label={language.t("goal.start.form.criteria")}
              value={form.preset}
              onChange={(event) => setForm("preset", event.currentTarget.value)}
            >
              <option value="default">{language.t("goal.start.form.default")}</option>
              <option value="custom">{language.t("goal.start.form.custom")}</option>
            </select>
          </label>
          <Show when={form.preset === "custom"}>
            <label class="flex flex-col gap-1">
              {language.t("goal.start.form.commands")}
              <textarea
                rows={3}
                aria-label={language.t("goal.start.form.commands")}
                value={form.commands}
                onInput={(event) => setForm("commands", event.currentTarget.value)}
              />
            </label>
            <label class="flex flex-col gap-1">
              {language.t("goal.start.form.diagnostics")}
              <select
                aria-label={language.t("goal.start.form.diagnostics")}
                value={form.diagnostics}
                onChange={(event) => setForm("diagnostics", event.currentTarget.value)}
              >
                <option value="none">{language.t("goal.start.form.omit")}</option>
                <option value="error">error</option>
                <option value="warning">warning</option>
                <option value="info">info</option>
                <option value="hint">hint</option>
              </select>
            </label>
            <label class="flex flex-col gap-1">
              {language.t("goal.start.form.reviewer")}
              <select
                aria-label={language.t("goal.start.form.reviewer")}
                value={form.reviewer}
                onChange={(event) => setForm("reviewer", event.currentTarget.value)}
              >
                <option value="none">{language.t("goal.start.form.omit")}</option>
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
            </label>
          </Show>
          <label class="flex flex-col gap-1">
            {language.t("goal.start.form.codeRefs")}
            <textarea
              rows={3}
              aria-label={language.t("goal.start.form.codeRefs")}
              value={form.codeRefs}
              onInput={(event) => setForm("codeRefs", event.currentTarget.value)}
            />
          </label>
          <p class="text-12-regular text-text-weak">{language.t("goal.start.form.hint")}</p>
          <Show when={state.error}>
            <p role="alert">{state.error}</p>
          </Show>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy()}
            onClick={() => {
              if (disposed || target() !== captured) {
                dialog.close()
                return
              }
              void onStart()
                .then(() => {
                  if (!disposed && target() === captured && !state.error) dialog.close()
                })
                .catch((error: unknown) => {
                  if (!disposed && target() === captured) setState("error", errorMessage(error))
                })
            }}
          >
            {language.t("goal.start.button")}
          </Button>
        </DialogFooter>
      </Dialog>
    ))
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
          onClick={openStart}
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
