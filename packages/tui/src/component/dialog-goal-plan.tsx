import { GoalPlanClient } from "@deepagent-code/core/deepagent/goal-plan-client"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import type { DialogContext } from "../ui/dialog"
import { createGoalPlanDraftStore } from "../util/goal-plan-draft"
import type { useSDK } from "../context/sdk"

/** One local interaction, including subdialogs and permission waits. The caller's
 * relay guard lives for this whole async operation, not just a mounted component. */
export async function openGoalPlan(input: {
  sdk: ReturnType<typeof useSDK>
  sessionID: string
  directory: string
  stateDirectory: string
  dialog: DialogContext
  current: () => boolean
  text: (key: string) => string
}) {
  const release = input.sdk.protectGoalPlan()
  const client = input.sdk.client
  const store = createGoalPlanDraftStore(input.stateDirectory)
  const state: { draft?: GoalPlanClient.Draft; error?: string; closed: boolean; reads: number } = {
    closed: false,
    reads: 0,
  }
  const live = () => !state.closed && input.current() && input.sdk.client === client
  const t = input.text
  const choose = (
    title: string,
    options: { title: string; description?: string; value: string; disabled?: boolean }[],
    footer?: string,
  ) =>
    new Promise<string | undefined>((resolve) => {
      input.dialog.replace(
        () => (
          <DialogSelect
            title={title}
            skipFilter
            renderFilter={false}
            options={options}
            footer={footer ? <text>{footer}</text> : undefined}
            onSelect={(option) => resolve(option.value)}
          />
        ),
        () => resolve(undefined),
      )
    })
  try {
    const generated = GoalPlanClient.sdk(client, { directory: input.directory })
    const goal = await generated.goal(input.sessionID)
    if (!live()) return
    if (!goal) {
      const result = await client.session.plan({ sessionID: input.sessionID }).then((response) => response.data?.plan)
      if (live())
        await choose(
          t("title"),
          result
            ? result.steps.map((step, index) => ({
                title: `${index + 1}. ${step.title}`,
                value: `view:${index}`,
                description: t(`stepState.${step.status}`),
              }))
            : [{ title: t("close"), value: "close" }],
          result?.goal ?? t("unavailable"),
        )
      return
    }
    const scope: GoalPlanClient.Scope = {
      server: input.sdk.url,
      url: input.sdk.url,
      directory: input.directory,
      operator: input.sdk.goalPlan ? "local-process" : input.sdk.operator,
      sessionID: input.sessionID,
      goalID: goal.goalId,
    }
    const captured = input.sdk.goalPlan ?? generated
    const transport = {
      ...captured,
      send(command: GoalPlanClient.Command) {
        if (!live())
          throw new GoalPlanClient.RequestError("CLIENT_SCOPE_CHANGED", "Plan edit view changed before dispatch", false)
        return captured.send(command)
      },
    }
    state.draft = (await store.list(scope)).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const read = async () => {
      if (!state.draft || !live()) return
      const controller = new AbortController()
      const deadline = setTimeout(() => controller.abort(), 10000)
      try {
        state.draft = await GoalPlanClient.refresh(store, transport, state.draft, controller.signal)
      } finally {
        clearTimeout(deadline)
      }
    }
    if (state.draft)
      await read().catch((error: unknown) => {
        state.error = error instanceof Error ? error.message : t("unavailable")
      })
    while (live()) {
      const current = state.draft?.response?.current
      const uncertain =
        state.draft?.phase === "sending" ||
        state.draft?.phase === "unknown" ||
        (state.draft?.phase === "draft" && !!state.draft.command)
      const options = !state.draft
        ? [{ title: t("begin"), value: "begin", description: t("beginHint") }]
        : [
            { title: t("refresh"), value: "refresh" },
            ...(uncertain ? [{ title: t("retry"), value: "retry", description: t("unknown") }] : []),
            ...(current?.state === "ready" && !uncertain
              ? [
                  { title: t("editSteps"), value: "edit" },
                  { title: t("apply"), value: "apply" },
                ]
              : []),
            ...(current?.retry === "reconcile" ? [{ title: t("reconcile"), value: "reconcile" }] : []),
            ...(current?.state === "waiting_boundary" || current?.state === "ready"
              ? [{ title: t("cancel"), value: "cancel" }]
              : []),
            ...(current && ["committed", "cancelled", "superseded"].includes(current.state)
              ? [{ title: t("newEdit"), value: "begin" }]
              : []),
            ...(current?.safeToResume ? [{ title: t("resume"), value: "close", description: "/goal resume" }] : []),
          ]
      const choice = await choose(
        t("title"),
        [...options, { title: t("close"), value: "close" }],
        [
          state.error,
          current ? t(`state.${current.state}`) : undefined,
          current ? t(`execution.${current.execution}`) : undefined,
          current?.totalDocuments
            ? `${current.confirmedDocuments}/${current.totalDocuments} ${t("documents")}`
            : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      )
      if (!live() || !choice || choice === "close") break
      state.error = undefined
      try {
        if (choice === "refresh") {
          await read()
          continue
        }
        if (choice === "edit") {
          if (!state.draft?.response?.current.editSource) continue
          const editSource = state.draft.response.current.editSource
          let candidate = state.draft.candidate ?? GoalPlanClient.candidate(state.draft.response)
          let reason = state.draft.reason ?? ""
          while (live()) {
            const selected = await choose(
              t("editSteps"),
              [
                ...candidate.steps.map((step, index) => ({
                  title: `${index + 1}. ${step.title}`,
                  value: `step:${index}`,
                  description:
                    step.status === "done"
                      ? `${t("completedReadonly")} · ${step.evidence?.join(", ") ?? ""}`
                      : t(`stepState.${step.status}`),
                })),
                { title: t("add"), value: "add", disabled: candidate.steps.length >= 128 },
                { title: t("reason"), value: "reason", description: reason },
                { title: t("back"), value: "back" },
              ],
              t("immutable"),
            )
            if (!live() || !selected || selected === "back") break
            if (selected === "add") {
              const title = await DialogPrompt.show(input.dialog, t("step"))
              if (title?.trim() && live())
                candidate = {
                  ...candidate,
                  steps: [...candidate.steps, { step_id: `step_${crypto.randomUUID()}`, title, status: "pending" }],
                }
            } else if (selected === "reason") {
              const value = await DialogPrompt.show(input.dialog, t("reason"), { value: reason })
              if (value !== null && live()) reason = value
            } else {
              const index = Number(selected.slice(5))
              const step = candidate.steps[index]
              if (!step) continue
              if (step.status === "done") {
                await choose(
                  t("completedReadonly"),
                  [{ title: t("back"), value: "back" }],
                  [step.title, step.acceptance, ...(step.evidence ?? [])].filter(Boolean).join("\n"),
                )
                continue
              }
              const attempted = editSource.attemptedStepIDs.includes(step.step_id)
              const field = await choose(step.title, [
                { title: t("step"), value: "title" },
                { title: t("acceptance"), value: "acceptance" },
                ...(attempted ? [{ title: t("status"), value: "status" }] : []),
                ...(attempted
                  ? [{ title: t("disposition"), value: "disposition" }]
                  : [{ title: t("remove"), value: "remove", disabled: candidate.steps.length <= 1 }]),
                { title: t("back"), value: "back" },
              ])
              if (!live()) break
              if (field === "status") {
                const status = await choose(
                  t("status"),
                  ["pending", "active", "blocked", "cancelled"].map((value) => ({
                    title: t(`stepState.${value}`),
                    value,
                  })),
                )
                if (
                  live() &&
                  (status === "pending" || status === "active" || status === "blocked" || status === "cancelled")
                )
                  candidate = {
                    ...candidate,
                    steps: candidate.steps.map((entry, i) => (i === index ? { ...entry, status } : entry)),
                    activeStepID:
                      status === "active"
                        ? step.step_id
                        : candidate.activeStepID === step.step_id
                          ? null
                          : candidate.activeStepID,
                  }
              }
              if (field === "remove")
                candidate = {
                  ...candidate,
                  steps: candidate.steps.filter((_, i) => index !== i),
                  activeStepID: candidate.activeStepID === step.step_id ? null : candidate.activeStepID,
                }
              if (field === "title" || field === "acceptance" || field === "disposition") {
                const original =
                  field === "disposition"
                    ? (candidate.dispositions.find((entry) => entry.stepID === step.step_id)?.reason ?? "")
                    : (step[field] ?? "")
                const value = await DialogPrompt.show(input.dialog, t(field === "title" ? "step" : field), {
                  value: original,
                })
                if (value !== null && live()) {
                  candidate =
                    field === "disposition"
                      ? {
                          ...candidate,
                          dispositions: [
                            ...candidate.dispositions.filter((entry) => entry.stepID !== step.step_id),
                            { stepID: step.step_id, reason: value },
                          ],
                        }
                      : {
                          ...candidate,
                          steps: candidate.steps.map((entry, i) =>
                            i === index ? { ...entry, [field]: field === "title" ? value : value || null } : entry,
                          ),
                        }
                }
              }
            }
            if (!live()) break
            const draft: GoalPlanClient.Draft = state.draft!
            const next: GoalPlanClient.Draft = {
              ...draft,
              revision: draft.revision + 1,
              candidate,
              reason,
              updatedAt: Date.now(),
            }
            await store.put(next, draft.revision)
            state.draft = next
          }
          continue
        }
        if (choice === "begin") {
          const latest = await generated.goal(scope.sessionID)
          if (!live() || !latest || latest.goalId !== scope.goalID) throw new Error(t("changed"))
          state.draft = await GoalPlanClient.create(scope, latest.revision)
          await store.put(state.draft)
        }
        if (!state.draft || !live()) continue
        const draft = state.draft
        const command: GoalPlanClient.Command =
          choice === "begin"
            ? { action: "begin", request: draft.begin }
            : choice === "retry"
              ? (draft.command ?? { action: "begin", request: draft.begin })
              : choice === "apply"
                ? GoalPlanClient.apply(draft)
                : { action: choice === "cancel" ? "cancel" : "reconcile", request: GoalPlanClient.target(draft) }
        const waiting = { active: true }
        input.dialog.replace(
          () => (
            <DialogSelect
              title={t("title")}
              footer={<text>{t("waitingApproval")}</text>}
              skipFilter
              renderFilter={false}
              options={[{ title: t("goToApproval"), value: "close" }]}
              onSelect={() => {
                state.closed = true
                input.dialog.clear()
              }}
            />
          ),
          () => {
            if (waiting.active) state.closed = true
          },
        )
        // The relay guard remains active while the real permission request is pending,
        // even after the visual dialog closes. The command identity is already durable.
        try {
          state.draft = await GoalPlanClient.send(store, transport, draft, command)
        } finally {
          waiting.active = false
        }
      } catch (error) {
        state.error = error instanceof Error ? error.message : t("unavailable")
        const current: GoalPlanClient.Draft | undefined = state.draft
        if (current) state.draft = (await store.list(scope)).find((entry) => entry.id === current.id) ?? current
      }
    }
  } catch (error) {
    if (live())
      await choose(
        t("title"),
        [{ title: t("close"), value: "close" }],
        error instanceof Error ? error.message : t("unavailable"),
      )
  } finally {
    release()
    if (!state.closed) input.dialog.clear()
  }
}
