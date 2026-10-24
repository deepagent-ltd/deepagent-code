import { createEffect, createResource, createSignal, Show, type JSX } from "solid-js"
import { PlanApprovalPresentation } from "@deepagent-code/core/deepagent/plan-approval-presentation"
import { Collapsible } from "./collapsible"
import { IconButton } from "./icon-button"
import { useI18n } from "../context/i18n"
import { writeClipboard } from "../utils/clipboard"

export function PlanApproval(props: {
  text: string
  sessionID: string
  kind: PlanApprovalPresentation.Kind
  approval?: unknown
  fallback: JSX.Element
}) {
  const i18n = useI18n()
  const [view] = createResource(
    () => ({ text: props.text, sessionID: props.sessionID, kind: props.kind, approval: props.approval }),
    (input) => PlanApprovalPresentation.read(input.text, input),
  )
  const [copied, setCopied] = createSignal(false)
  createEffect(() => {
    props.text
    setCopied(false)
  })
  const copy = (body: string) => writeClipboard(body).then(setCopied, () => setCopied(false))
  return (
    <Show when={!view.loading && view()} fallback={props.fallback}>
      {(approved) => (
        <div data-component="plan-approval" class="flex flex-col gap-3">
          <div class="whitespace-pre-wrap break-words text-14-regular">
            {PlanApprovalPresentation.format(approved(), (key) => i18n.t(`ui.planApproval.${key}`))}
          </div>
          <div class="flex items-center gap-2">
            <Collapsible class="min-w-0 flex-1">
              <Collapsible.Trigger class="flex items-center gap-2">
                {i18n.t("ui.planApproval.view")}
                <Collapsible.Arrow />
              </Collapsible.Trigger>
              <Collapsible.Content>
                <pre
                  data-slot="plan-approval-snapshot"
                  class="max-h-72 overflow-auto whitespace-pre-wrap break-all text-12-mono"
                >
                  {approved().body}
                </pre>
              </Collapsible.Content>
            </Collapsible>
            <IconButton
              icon={copied() ? "check" : "copy"}
              variant="ghost"
              aria-label={i18n.t("ui.planApproval.copy")}
              onClick={() => void copy(approved().body)}
            />
          </div>
        </div>
      )}
    </Show>
  )
}
