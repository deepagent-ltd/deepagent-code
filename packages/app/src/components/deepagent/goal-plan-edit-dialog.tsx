import { For, Index, Show, createSignal } from "solid-js"
import { Dialog, DialogFooter } from "@deepagent-code/ui/v2/dialog-v2"
import { Button } from "@deepagent-code/ui/button"
import { Icon } from "@deepagent-code/ui/icon"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { editPlanGoal, type GoalPlanInput, type PanelGoalClient } from "./panel-goal.api"
import type { SessionPlan } from "@/context/global-sync/types"

/**
 * V4.1 §S2 — the goal plan HOT-EDIT dialog. Opened from the goal status bar for a running/paused goal.
 * Pre-fills from the live session_plan (the same plan the status bar reads), lets the user revise the
 * goal text + step titles/statuses (add/remove steps), and POSTs the revision via editPlanGoal. The
 * backend applies it between ticks (durable-doc upsert + stall re-baseline) — see goal-loop.applyPlanEdit.
 *
 * step_id is preserved for existing steps (so the backend reconciles ids + runtime evidence via
 * buildPlanFromInput); a NEW step is sent without an id and the backend assigns one. Evidence is
 * runtime-owned and never sent from the client.
 */

// The status values a user can pick — mirrors PlanStepStatus. `active` is included so a user can point
// the goal at a specific step; the backend re-derives active_step_id from the first active step.
const STATUS_OPTIONS = ["pending", "active", "done", "blocked", "cancelled"] as const
type StatusOption = (typeof STATUS_OPTIONS)[number]

const STATUS_LABEL_KEY: Record<StatusOption, string> = {
  pending: "composer.goal.editPlan.status.pending",
  active: "composer.goal.editPlan.status.active",
  done: "composer.goal.editPlan.status.done",
  blocked: "composer.goal.editPlan.status.blocked",
  cancelled: "composer.goal.editPlan.status.cancelled",
}

// A local editable step row. `step_id` is undefined for a freshly-added step (the backend assigns one).
type EditStep = {
  step_id?: string
  title: string
  status: StatusOption
}

const normStatus = (s: string): StatusOption =>
  (STATUS_OPTIONS as readonly string[]).includes(s) ? (s as StatusOption) : "pending"

export function GoalPlanEditDialog(props: {
  sessionID: string
  plan: SessionPlan | undefined
  client: PanelGoalClient
  onClose: () => void
}) {
  const language = useLanguage()
  const [goal, setGoal] = createSignal(props.plan?.goal ?? "")
  const [steps, setSteps] = createSignal<EditStep[]>(
    (props.plan?.steps ?? []).map((s) => ({ step_id: s.step_id, title: s.title, status: normStatus(s.status) })),
  )
  const [busy, setBusy] = createSignal(false)

  const setStep = (i: number, patch: Partial<EditStep>) =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  const addStep = () => setSteps((prev) => [...prev, { title: "", status: "pending" }])
  const removeStep = (i: number) => setSteps((prev) => prev.filter((_, idx) => idx !== i))

  // Valid to submit: a non-empty goal and at least one step whose title is non-empty. Empty-title steps
  // are dropped on submit (a user adding a row then leaving it blank shouldn't create a titleless step).
  const canSave = () => goal().trim().length > 0 && steps().some((s) => s.title.trim().length > 0)

  const onSave = async () => {
    if (busy() || !canSave()) return
    setBusy(true)
    try {
      const plan: GoalPlanInput = {
        goal: goal().trim(),
        steps: steps()
          .filter((s) => s.title.trim().length > 0)
          .map((s) => ({
            ...(s.step_id ? { step_id: s.step_id } : {}),
            title: s.title.trim(),
            status: s.status,
          })),
      }
      const ok = await editPlanGoal(props.client, props.sessionID, plan)
      if (ok) {
        showToast({ title: language.t("composer.goal.editPlan.saved"), variant: "success" })
        props.onClose()
      } else {
        showToast({ title: language.t("composer.goal.editPlan.failed") })
      }
    } catch {
      showToast({ title: language.t("composer.goal.editPlan.failed") })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      size="large"
      variant="settings"
      title={language.t("composer.goal.editPlan.title")}
      description={language.t("composer.goal.editPlan.desc")}
    >
      <div class="flex flex-col gap-4 p-1" data-component="goal-plan-edit">
        <label class="flex flex-col gap-1">
          <span class="text-13-medium text-text-base">{language.t("composer.goal.editPlan.goalLabel")}</span>
          <textarea
            class="w-full rounded-md border border-border-weak-base bg-surface-base px-2 py-1.5 text-13-regular text-text-strong outline-none resize-none focus:ring-2 focus:ring-accent-base"
            rows={2}
            value={goal()}
            onInput={(e) => setGoal(e.currentTarget.value)}
          />
        </label>

        <div class="flex flex-col gap-2">
          <span class="text-13-medium text-text-base">{language.t("composer.goal.editPlan.stepsLabel")}</span>
          {/* Index (not For): the rows are keyed by POSITION, so editing a step's title in place updates
              the existing DOM node rather than remounting it. With <For> (keyed by object reference) every
              keystroke — which replaces the step object via setStep — would re-create the row and the
              <input> would lose focus after one character. */}
          <Index each={steps()}>
            {(s, i) => (
              <div class="flex items-center gap-2">
                <input
                  class="min-w-0 flex-1 rounded-md border border-border-weak-base bg-surface-base px-2 py-1.5 text-13-regular text-text-strong outline-none focus:ring-2 focus:ring-accent-base"
                  placeholder={language.t("composer.goal.editPlan.stepPlaceholder")}
                  value={s().title}
                  onInput={(e) => setStep(i, { title: e.currentTarget.value })}
                />
                <select
                  class="shrink-0 rounded-md border border-border-weak-base bg-surface-base px-2 py-1.5 text-13-regular text-text-strong outline-none focus:ring-2 focus:ring-accent-base"
                  value={s().status}
                  onChange={(e) => setStep(i, { status: normStatus(e.currentTarget.value) })}
                >
                  <For each={STATUS_OPTIONS}>
                    {(opt) => <option value={opt}>{language.t(STATUS_LABEL_KEY[opt] as never)}</option>}
                  </For>
                </select>
                <Button
                  variant="ghost"
                  size="small"
                  class="size-8 p-0 shrink-0"
                  onClick={() => removeStep(i)}
                  aria-label={language.t("composer.goal.editPlan.removeStep")}
                >
                  <Icon name="trash" class="size-4" />
                </Button>
              </div>
            )}
          </Index>
          <Button variant="ghost" size="small" class="self-start" icon="plus" onClick={addStep}>
            {language.t("composer.goal.editPlan.addStep")}
          </Button>
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => props.onClose()} disabled={busy()}>
          {language.t("composer.goal.editPlan.cancel")}
        </Button>
        <Button variant="primary" onClick={onSave} disabled={busy() || !canSave()}>
          {language.t("composer.goal.editPlan.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
