import { For, Index, Show, createEffect, onCleanup, onMount } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { Dialog, DialogFooter } from "@deepagent-code/ui/v2/dialog-v2"
import { Button } from "@deepagent-code/ui/button"
import { GoalPlanClient } from "@deepagent-code/core/deepagent/goal-plan-client"
import { createGoalPlanDraftStore } from "@/utils/goal-plan-draft"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"

export function GoalPlanEditDialog(props: {
  scope: Omit<GoalPlanClient.Scope, "operator">
  client: GoalPlanClient.SDK
  current: () => boolean
  onClose: () => void
}) {
  const language = useLanguage()
  const server = useServer()
  const scope = { ...props.scope, operator: server.current?.http.username ?? "deepagent-code" }
  const generated = GoalPlanClient.sdk(props.client, { directory: scope.directory, workspace: scope.workspace })
  const transport = {
    ...generated,
    send(command: GoalPlanClient.Command) {
      if (!live())
        throw new GoalPlanClient.RequestError("CLIENT_SCOPE_CHANGED", "Plan edit view changed before dispatch", false)
      return generated.send(command)
    },
  }
  const store = createGoalPlanDraftStore()
  const [state, setState] = createStore<{
    draft?: GoalPlanClient.Draft
    candidate?: GoalPlanClient.Candidate
    reason: string
    busy: boolean
    loading: boolean
    reading: boolean
    saving: boolean
    error?: string
  }>({ reason: "", busy: false, loading: true, reading: false, saving: false })
  let disposed = false
  let reading: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let observations = 0
  let draftRef: GoalPlanClient.Draft | undefined
  let saves: Promise<void> = Promise.resolve()
  const t = (key: string) => language.t(`goal.plan.${key}` as Parameters<typeof language.t>[0])
  const live = () => !disposed && props.current()
  const current = () => state.draft?.response?.current
  const source = () => state.draft?.response?.current.editSource
  const editable = () =>
    current()?.state === "ready" && !state.busy && state.draft?.phase !== "sending" && state.draft?.phase !== "unknown"
  const fail = (error: unknown) => {
    if (live()) setState("error", error instanceof Error ? error.message : t("unavailable"))
  }
  const accept = (draft: GoalPlanClient.Draft, initialize = false) => {
    draftRef = draft
    if (!live()) return
    setState("draft", draft)
    if (draft.response?.current.editSource && (initialize || !state.candidate)) {
      setState("candidate", draft.candidate ?? GoalPlanClient.candidate(draft.response))
      setState("reason", draft.reason ?? "")
    }
  }
  const refresh = async (draft = state.draft) => {
    if (!draft || reading || !live()) return
    const controller = new AbortController()
    reading = controller
    setState("reading", true)
    const deadline = setTimeout(() => controller.abort(), 10000)
    try {
      await saves
      if (!live() || controller.signal.aborted || !draftRef) return
      const next = await GoalPlanClient.refresh(store, transport, draftRef, controller.signal)
      accept(next)
      if (live() && next.response?.current.state === "waiting_boundary" && observations++ < 15)
        timer = setTimeout(() => void refresh(), 2000)
    } catch (error) {
      fail(error)
    } finally {
      clearTimeout(deadline)
      if (reading === controller) {
        reading = undefined
        if (live()) setState("reading", false)
      }
    }
  }
  onMount(async () => {
    try {
      const goal = await transport.goal(scope.sessionID)
      if (!goal || goal.goalId !== scope.goalID) throw new Error(t("changed"))
      const existing = (await store.list(scope)).sort((a, b) => b.updatedAt - a.updatedAt)[0]
      if (!live()) return
      if (existing) {
        accept(existing, true)
        await refresh(existing)
      }
    } catch (error) {
      fail(error)
    } finally {
      if (live()) setState("loading", false)
    }
  })
  createEffect(() => {
    if (!props.current()) {
      reading?.abort()
      if (timer) clearTimeout(timer)
    }
  })
  onCleanup(() => {
    disposed = true
    reading?.abort()
    if (timer) clearTimeout(timer)
    void saves
      .finally(() => {
        if (!state.busy) store.close()
      })
      .catch(() => undefined)
  })
  function saveDraft() {
    const candidate = state.candidate ? structuredClone(unwrap(state.candidate)) : undefined
    const reason = state.reason
    setState("saving", true)
    const operation = saves.then(async () => {
      const draft = draftRef
      if (!draft) throw new Error(t("unavailable"))
      const next = {
        ...draft,
        revision: draft.revision + 1,
        ...(candidate ? { candidate } : {}),
        reason,
        updatedAt: Date.now(),
      }
      await store.put(next, draft.revision)
      accept(next)
      return next
    })
    saves = operation.then(() => undefined, fail)
    void saves.then(() => {
      if (live()) setState("saving", false)
    })
    return operation
  }
  function autosave() {
    void saveDraft().catch(fail)
  }
  async function begin() {
    if (!live() || state.busy || state.loading) return
    setState({ busy: true, error: undefined })
    try {
      const goal = await transport.goal(scope.sessionID)
      if (!live() || !goal || goal.goalId !== scope.goalID) throw new Error(t("changed"))
      await saves
      setState({ candidate: undefined, reason: "" })
      const draft = await GoalPlanClient.create(scope, goal.revision)
      await store.put(draft)
      accept(draft)
      const next = await GoalPlanClient.send(store, transport, draft, { action: "begin", request: draft.begin })
      accept(next, true)
      if (next.response?.current.state === "waiting_boundary") timer = setTimeout(() => void refresh(), 2000)
    } catch (error) {
      await reloadDraft()
      fail(error)
    } finally {
      if (live()) setState("busy", false)
      if (disposed) store.close()
    }
  }
  async function reloadDraft() {
    const records = await store.list(scope).catch(() => [])
    const existing = records.find((entry) => entry.id === state.draft?.id)
    if (existing) accept(existing)
  }
  async function action(action: "apply" | "cancel" | "reconcile" | "retry") {
    if (!live() || state.busy || !state.draft) return
    setState({ busy: true, error: undefined })
    if (timer) clearTimeout(timer)
    reading?.abort()
    try {
      await saves
      const draft = action === "apply" ? await saveDraft() : draftRef!
      const command =
        action === "retry"
          ? (draft.command ?? { action: "begin" as const, request: draft.begin })
          : action === "apply"
            ? GoalPlanClient.apply(draft)
            : { action, request: GoalPlanClient.target(draft) }
      accept(await GoalPlanClient.send(store, transport, draft, command))
    } catch (error) {
      await reloadDraft()
      fail(error)
    } finally {
      if (live()) setState("busy", false)
      if (disposed) store.close()
    }
  }
  const change = (index: number, patch: Partial<GoalPlanClient.Candidate["steps"][number]>) => {
    if (!editable() || !state.candidate || state.candidate.steps[index].status === "done") return
    setState("candidate", {
      ...state.candidate,
      steps: state.candidate.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
      activeStepID:
        patch.status === "active"
          ? state.candidate.steps[index].step_id
          : patch.status && state.candidate.activeStepID === state.candidate.steps[index].step_id
            ? null
            : state.candidate.activeStepID,
    })
    autosave()
  }
  async function close() {
    if (!state.busy && state.draft && state.candidate) {
      try {
        await saveDraft()
      } catch (error) {
        fail(error)
        return
      }
    }
    await saves
    props.onClose()
  }
  return (
    <Dialog size="large" variant="settings" title={t("title")} description={t("description")}>
      <div class="flex flex-col gap-3 min-w-0 p-4" data-component="goal-plan-edit">
        <Show when={state.error}>
          <div role="alert" class="text-13-regular text-text-strong break-words">
            {state.error}
          </div>
        </Show>
        <Show when={state.saving}>
          <p role="status">{t("saving")}</p>
        </Show>
        <Show when={state.loading}>
          <p>{t("loading")}</p>
        </Show>
        <Show when={!state.loading && !state.draft}>
          <p class="text-13-regular text-text-weak">{t("beginHint")}</p>
        </Show>
        <Show when={current()}>
          {(value) => (
            <div
              class="rounded-md border border-border-weak-base bg-surface-raised-base p-3 text-13-regular"
              role="status"
            >
              <p>{t(`state.${value().state}`)}</p>
              <p class="text-text-weak">{t(`execution.${value().execution}`)}</p>
              <Show when={value().totalDocuments > 0}>
                <p>
                  {value().confirmedDocuments}/{value().totalDocuments} {t("documents")}
                </p>
              </Show>
              <Show when={state.draft?.response?.originalReceipt}>
                <p class="text-12-regular text-text-weak">
                  {t("historical")} · {t(`state.${state.draft?.response?.originalReceipt?.state}`)}
                </p>
              </Show>
            </div>
          )}
        </Show>
        <Show when={state.busy}>
          <p role="status">{t("waitingApproval")}</p>
        </Show>
        <Show
          when={
            state.draft?.phase === "unknown" ||
            state.draft?.phase === "sending" ||
            (state.draft?.phase === "draft" && !!state.draft.command)
          }
        >
          <p>{t("unknown")}</p>
        </Show>
        <Show when={source()}>
          <p class="text-13-regular text-text-weak">{t("immutable")}</p>
          <p class="text-14-medium break-words">
            {state.draft?.response && GoalPlanClient.plan(state.draft.response).goal}
          </p>
        </Show>
        <Index each={state.candidate?.steps}>
          {(step, index) => (
            <div class="flex flex-col gap-2 border border-border-weak-base rounded-md p-2 min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <input
                  aria-label={`${t("step")} ${index + 1}`}
                  class="min-w-0 flex-1 basis-full sm:basis-auto rounded-md border border-border-weak-base bg-surface-base px-2 py-1.5 text-13-regular"
                  disabled={!editable() || step().status === "done"}
                  value={step().title}
                  onInput={(event) => change(index, { title: event.currentTarget.value })}
                />
                <Show
                  when={source()?.attemptedStepIDs.includes(step().step_id) && step().status !== "done"}
                  fallback={
                    <span class="text-12-regular text-text-weak">
                      {step().status === "done" ? t("completedReadonly") : t(`stepState.${step().status}`)}
                    </span>
                  }
                >
                  <select
                    aria-label={`${t("status")} ${index + 1}`}
                    disabled={!editable()}
                    class="rounded-md border border-border-weak-base bg-surface-base px-2 py-1.5"
                    value={step().status}
                    onChange={(event) => {
                      const status = event.currentTarget.value
                      if (status !== "pending" && status !== "active" && status !== "blocked" && status !== "cancelled")
                        return
                      change(index, { status })
                    }}
                  >
                    <For each={["pending", "active", "blocked", "cancelled"]}>
                      {(status) => <option value={status}>{t(`stepState.${status}`)}</option>}
                    </For>
                  </select>
                </Show>
                <Show when={step().status !== "done" && !source()?.attemptedStepIDs.includes(step().step_id)}>
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={!editable() || state.candidate!.steps.length <= 1}
                    onClick={() => {
                      if (!editable() || !state.candidate) return
                      setState("candidate", {
                        ...state.candidate,
                        steps: state.candidate.steps.filter((_, i) => i !== index),
                        activeStepID:
                          state.candidate.activeStepID === step().step_id ? null : state.candidate.activeStepID,
                      })
                      autosave()
                    }}
                  >
                    {t("remove")}
                  </Button>
                </Show>
              </div>
              <label class="flex flex-col gap-1 text-12-regular text-text-weak">
                {t("acceptance")}
                <textarea
                  rows={2}
                  class="rounded-md border border-border-weak-base bg-surface-base px-2 py-1 text-text-base"
                  disabled={!editable() || step().status === "done"}
                  value={step().acceptance ?? ""}
                  onInput={(event) => change(index, { acceptance: event.currentTarget.value || null })}
                />
              </label>
              <Show when={source()?.attemptedStepIDs.includes(step().step_id) && step().status !== "done"}>
                <label class="text-12-regular">
                  {t("disposition")}
                  <input
                    class="w-full rounded-md border border-border-weak-base bg-surface-base px-2 py-1"
                    disabled={!editable()}
                    value={state.candidate?.dispositions.find((entry) => entry.stepID === step().step_id)?.reason ?? ""}
                    onInput={(event) => {
                      if (state.candidate) {
                        setState("candidate", {
                          ...state.candidate,
                          dispositions: [
                            ...state.candidate.dispositions.filter((entry) => entry.stepID !== step().step_id),
                            { stepID: step().step_id, reason: event.currentTarget.value },
                          ],
                        })
                        autosave()
                      }
                    }}
                  />
                </label>
              </Show>
              <For each={step().evidence}>
                {(evidence) => <p class="text-12-regular text-text-weak break-words">{evidence}</p>}
              </For>
            </div>
          )}
        </Index>
        <Show when={state.candidate}>
          <Button
            variant="ghost"
            class="self-start"
            disabled={!editable() || state.candidate!.steps.length >= 128}
            onClick={() => {
              if (editable() && state.candidate) {
                setState("candidate", {
                  ...state.candidate,
                  steps: [
                    ...state.candidate.steps,
                    { step_id: `step_${crypto.randomUUID()}`, title: "", status: "pending" },
                  ],
                })
                autosave()
              }
            }}
          >
            {t("add")}
          </Button>
          <label class="flex flex-col gap-1 text-13-regular">
            {t("reason")}
            <textarea
              rows={2}
              class="rounded-md border border-border-weak-base bg-surface-base px-2 py-1.5"
              disabled={!editable()}
              value={state.reason}
              onInput={(event) => {
                setState("reason", event.currentTarget.value)
                autosave()
              }}
            />
          </label>
        </Show>
      </div>
      <DialogFooter>
        <div class="flex flex-wrap justify-end gap-2 w-full min-w-0">
          <Button variant="ghost" onClick={() => void close()}>
            {state.busy ? t("goToApproval") : t("close")}
          </Button>
          <Show when={state.draft}>
            <Button
              variant="secondary"
              disabled={state.busy || state.reading || state.saving}
              onClick={() => {
                observations = 0
                void refresh()
              }}
            >
              {t("refresh")}
            </Button>
            <Show
              when={
                state.draft?.phase === "unknown" ||
                state.draft?.phase === "sending" ||
                (state.draft?.phase === "draft" && !!state.draft.command)
              }
            >
              <Button disabled={state.busy} onClick={() => void action("retry")}>
                {t("retry")}
              </Button>
            </Show>
            <Show when={current()?.retry === "reconcile"}>
              <Button disabled={state.busy} onClick={() => void action("reconcile")}>
                {t("reconcile")}
              </Button>
            </Show>
            <Show when={current()?.state === "waiting_boundary" || current()?.state === "ready"}>
              <Button variant="ghost" disabled={state.busy} onClick={() => void action("cancel")}>
                {t("cancel")}
              </Button>
            </Show>
            <Show
              when={
                current()?.state === "committed" ||
                current()?.state === "cancelled" ||
                current()?.state === "superseded"
              }
            >
              <Button disabled={state.busy || state.reading || state.saving} onClick={() => void begin()}>
                {t("newEdit")}
              </Button>
            </Show>
            <Show when={current()?.safeToResume}>
              <Button disabled={state.busy} onClick={() => void close()}>
                {t("resume")}
              </Button>
            </Show>
            <Show when={current()?.state === "ready"}>
              <Button
                variant="primary"
                disabled={!editable() || !state.reason.trim()}
                onClick={() => void action("apply")}
              >
                {t("apply")}
              </Button>
            </Show>
          </Show>
          <Show when={!state.loading && !state.draft}>
            <Button variant="primary" disabled={state.busy} onClick={() => void begin()}>
              {t("begin")}
            </Button>
          </Show>
        </div>
      </DialogFooter>
    </Dialog>
  )
}
