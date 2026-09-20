import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useTuiI18n } from "../context/i18n"
import { useDialog } from "../ui/dialog"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { useBindings } from "../keymap"

export function DialogSessionDeleteFailed(props: {
  session: string
  workspace: string
  onDelete?: () => boolean | void | Promise<boolean | void>
  onRestore?: () => boolean | void | Promise<boolean | void>
  onDone?: () => void
}) {
  const dialog = useDialog()
  const i18n = useTuiI18n()
  const { theme } = useTheme()
  const [store, setStore] = createStore({
    active: "delete" as "delete" | "restore",
  })

  const options = [
    {
      id: "delete" as const,
      title: i18n.t("tui.sessionDeleteFailed.deleteWorkspace"),
      description: i18n.t("tui.sessionDeleteFailed.deleteWorkspaceDesc"),
      run: props.onDelete,
    },
    {
      id: "restore" as const,
      title: i18n.t("tui.sessionDeleteFailed.restoreNewWorkspace"),
      description: i18n.t("tui.sessionDeleteFailed.restoreNewWorkspaceDesc"),
      run: props.onRestore,
    },
  ]

  async function confirm() {
    const result = await options.find((item) => item.id === store.active)?.run?.()
    if (result === false) return
    props.onDone?.()
    if (!props.onDone) dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: i18n.t("tui.sessionDeleteFailed.confirmOption"),
        group: i18n.t("tui.category.dialog"),
        cmd: () => void confirm(),
      },
      {
        key: "left",
        desc: i18n.t("tui.sessionDeleteFailed.deleteBrokenSession"),
        group: i18n.t("tui.category.dialog"),
        cmd: () => setStore("active", "delete"),
      },
      {
        key: "up",
        desc: i18n.t("tui.sessionDeleteFailed.deleteBrokenSession"),
        group: i18n.t("tui.category.dialog"),
        cmd: () => setStore("active", "delete"),
      },
      {
        key: "right",
        desc: i18n.t("tui.sessionDeleteFailed.restoreBrokenSession"),
        group: i18n.t("tui.category.dialog"),
        cmd: () => setStore("active", "restore"),
      },
      {
        key: "down",
        desc: i18n.t("tui.sessionDeleteFailed.restoreBrokenSession"),
        group: i18n.t("tui.category.dialog"),
        cmd: () => setStore("active", "restore"),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Failed to Delete Session
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word">
        {`The session "${props.session}" could not be deleted because the workspace "${props.workspace}" is not available.`}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        Choose how you want to recover this broken workspace session.
      </text>
      <box flexDirection="column" paddingBottom={1} gap={1}>
        <For each={options}>
          {(item) => (
            <box
              flexDirection="column"
              paddingLeft={1}
              paddingRight={1}
              paddingTop={1}
              paddingBottom={1}
              backgroundColor={item.id === store.active ? theme.primary : undefined}
              onMouseUp={() => {
                setStore("active", item.id)
                void confirm()
              }}
            >
              <text
                attributes={TextAttributes.BOLD}
                fg={item.id === store.active ? theme.selectedListItemText : theme.text}
              >
                {item.title}
              </text>
              <text fg={item.id === store.active ? theme.selectedListItemText : theme.textMuted} wrapMode="word">
                {item.description}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}
