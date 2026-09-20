import { TextAttributes } from "@opentui/core"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { useTheme } from "../context/theme"
import { useTuiI18n } from "../context/i18n"
import { useDialog } from "../ui/dialog"
import { useBindings } from "../keymap"

export function DialogWorkspaceUnavailable(props: { onRestore?: () => boolean | void | Promise<boolean | void> }) {
  const dialog = useDialog()
  const i18n = useTuiI18n()
  const { theme } = useTheme()
  const [store, setStore] = createStore({
    active: "restore" as "cancel" | "restore",
  })

  const options = ["cancel", "restore"] as const

  async function confirm() {
    if (store.active === "cancel") {
      dialog.clear()
      return
    }
    const result = await props.onRestore?.()
    if (result === false) return
  }

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: i18n.t("tui.workspaceUnavailable.confirmOption"),
        group: i18n.t("tui.category.dialog"),
        cmd: () => void confirm(),
      },
      {
        key: "left",
        desc: i18n.t("tui.workspaceUnavailable.cancelRestore"),
        group: i18n.t("tui.category.dialog"),
        cmd: () => setStore("active", "cancel"),
      },
      {
        key: "right",
        desc: i18n.t("tui.workspaceUnavailable.restore"),
        group: i18n.t("tui.category.dialog"),
        cmd: () => setStore("active", "restore"),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Workspace Unavailable
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word">
        This session is attached to a workspace that is no longer available.
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        Would you like to restore this session into a new workspace?
      </text>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1} gap={1}>
        <For each={options}>
          {(item) => (
            <box
              paddingLeft={2}
              paddingRight={2}
              backgroundColor={item === store.active ? theme.primary : undefined}
              onMouseUp={() => {
                setStore("active", item)
                void confirm()
              }}
            >
              <text fg={item === store.active ? theme.selectedListItemText : theme.textMuted}>{item}</text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}
