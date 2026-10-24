import { Show, type JSX } from "solid-js"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Tooltip } from "@deepagent-code/ui/tooltip"
import { useLanguage } from "@/context/language"

export function PromptSubmitControl(props: {
  form: string
  disabled: boolean
  blockedReason?: string
  finished: boolean
  preparing: boolean
  working: boolean
  blank: boolean
  stopping: boolean
  recovery: boolean
  queue?: boolean
  selectionRequired: boolean
  mode: "normal" | "shell"
  tip: JSX.Element
}) {
  const language = useLanguage()
  const needsSelection = () => !props.blockedReason && !props.stopping && props.selectionRequired
  return (
    <div class="flex shrink-0 items-center gap-2">
      <Show when={props.blockedReason}>
        <span role="status" class="max-w-64 text-11-regular text-text-weak">
          {props.blockedReason}
        </span>
      </Show>
      <Show when={props.queue && !props.stopping}>
        <span role="status" class="max-w-48 text-11-regular text-text-weak">
          {language.t("prompt.action.queueHint")}
        </span>
      </Show>
      <Show when={needsSelection() && !props.blank}>
        <span role="status" class="max-w-48 text-11-regular text-text-weak">
          {language.t("prompt.toast.modelAgentRequired.description")}
        </span>
      </Show>
      <Tooltip
        placement="top"
        inactive={!needsSelection() && !props.preparing && !props.working && props.blank}
        value={needsSelection() ? language.t("prompt.toast.modelAgentRequired.description") : props.tip}
      >
        <IconButton
          data-action="prompt-submit"
          type="submit"
          form={props.form}
          disabled={
            props.disabled ||
            props.finished ||
            (!!props.blockedReason && !props.stopping) ||
            needsSelection() ||
            (!props.preparing && !props.working && props.blank)
          }
          tabIndex={props.mode === "normal" ? undefined : -1}
          icon={props.stopping ? "stop" : props.mode === "shell" ? "arrow-undo-down" : "arrow-up"}
          variant="primary"
          class="size-8 rounded-full"
          aria-label={
            props.recovery
              ? language.t("composer.recovery.action")
              : props.stopping
                ? language.t("prompt.action.stop")
                : props.queue
                  ? language.t("prompt.action.queue")
                  : language.t("prompt.action.send")
          }
        />
      </Tooltip>
    </div>
  )
}
