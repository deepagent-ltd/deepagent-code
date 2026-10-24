import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useTuiI18n } from "../context/i18n"
import { isCollaborationModeName } from "@deepagent-code/core/session/collaboration-mode"

export function DialogAgent() {
  const local = useLocal()
  const dialog = useDialog()
  const i18n = useTuiI18n()

  const options = createMemo(() =>
    local.agent.list().map((item) => {
      return {
        value: item.name,
        title: isCollaborationModeName(item.name) ? i18n.t(`tui.mode.${item.name}`) : item.name,
        description: item.native ? "native" : item.description,
      }
    }),
  )

  return (
    <DialogSelect
      title={i18n.t("tui.mode.next")}
      current={local.agent.current()?.name}
      options={options()}
      onSelect={(option) => {
        local.agent.set(option.value)
        dialog.clear()
      }}
    />
  )
}
