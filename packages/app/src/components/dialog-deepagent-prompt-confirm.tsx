import { Button } from "@deepagent-code/ui/button"
import { Dialog } from "@deepagent-code/ui/dialog"
import { TextField } from "@deepagent-code/ui/text-field"
import { useLanguage } from "@/context/language"
import { createMemo, createSignal } from "solid-js"

export type DeepAgentPromptDraft = {
  prompt_draft_id: string
  context_plan_id: string
  state: string
  mode: "wish"
  goal: string
}

export function DialogDeepAgentPromptConfirm(props: {
  draft: DeepAgentPromptDraft
  preview: string
  onConfirm: (editedGoal: string) => void
  onCancel: () => void
}) {
  const language = useLanguage()
  const [editedGoal, setEditedGoal] = createSignal(props.draft.goal)
  const valid = createMemo(() => editedGoal().trim().length > 0)

  return (
    <Dialog title={language.t("dialog.provider.deepagent.promptConfirm.title")} transition>
      <div class="flex w-[520px] max-w-[calc(100vw-32px)] flex-col gap-4 px-6 pb-6">
        <div class="flex flex-col gap-2">
          <div class="text-14-medium text-text-strong">{language.t("dialog.provider.deepagent.promptConfirm.mode")}</div>
          <div class="text-13-regular text-text-base">{language.t(`settings.general.deepagent.prompt.${props.draft.mode}`)}</div>
        </div>
        <div class="flex flex-col gap-2">
          <div class="text-14-medium text-text-strong">{language.t("dialog.provider.deepagent.promptConfirm.preview")}</div>
          <div class="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border-weak-base px-3 py-2 text-13-regular text-text-base">
            {props.preview}
          </div>
        </div>
        <TextField
          multiline
          label={language.t("dialog.provider.deepagent.promptConfirm.edit.label")}
          description={language.t("dialog.provider.deepagent.promptConfirm.edit.description")}
          value={editedGoal()}
          onChange={setEditedGoal}
          validationState={valid() ? undefined : "invalid"}
          error={valid() ? undefined : language.t("provider.custom.error.required")}
          rows={5}
        />
        <div class="flex justify-end gap-2">
          <Button variant="secondary" onClick={props.onCancel}>
            {language.t("common.cancel")}
          </Button>
          <Button disabled={!valid()} onClick={() => props.onConfirm(editedGoal().trim())}>{language.t("common.continue")}</Button>
        </div>
      </div>
    </Dialog>
  )
}
