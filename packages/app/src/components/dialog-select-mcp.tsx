import { Component, createEffect, createMemo, createSignal, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { Dialog } from "@deepagent-code/ui/dialog"
import { Button } from "@deepagent-code/ui/button"
import { List } from "@deepagent-code/ui/list"
import { Switch } from "@deepagent-code/ui/switch"
import { useLanguage } from "@/context/language"
import { useMcpRemove, useMcpToggle } from "@/context/mcp"
import { DialogAddMcp } from "./dialog-add-mcp"
import { DialogConfigureMcp } from "./dialog-configure-mcp"

const statusLabels = {
  connected: "mcp.status.connected",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  needs_client_registration: "mcp.status.needs_client_registration",
  disabled: "mcp.status.disabled",
} as const

export const DialogSelectMcp: Component = () => {
  const sync = useSync()
  const language = useLanguage()
  const dialog = useDialog()
  const [selected, setSelected] = createSignal<string>()

  const items = createMemo(() =>
    Object.entries(sync.data.mcp ?? {})
      .map(([name, status]) => ({ name, status: status.status }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  const toggle = useMcpToggle()
  const remove = useMcpRemove()

  const enabledCount = createMemo(() => items().filter((i) => i.status === "connected").length)
  const totalCount = createMemo(() => items().length)
  const selectedItem = createMemo(() => items().find((item) => item.name === selected()))

  createEffect(() => {
    const names = items().map((item) => item.name)
    if (names.length === 0) {
      setSelected(undefined)
      return
    }
    if (!selected() || !names.includes(selected()!)) setSelected(names[0])
  })

  const deleteSelected = () => {
    const name = selected()
    if (!name || remove.isPending) return
    if (!window.confirm(language.t("dialog.mcp.delete.confirm", { name }))) return
    remove.mutate(name)
  }

  return (
    <Dialog
      title={language.t("dialog.mcp.title")}
      description={language.t("dialog.mcp.description", { enabled: enabledCount(), total: totalCount() })}
    >
      <div class="flex items-center gap-2 px-3 pt-1 pb-2">
        <Button variant="secondary" icon="plus" onClick={() => dialog.show(() => <DialogAddMcp />)}>
          {language.t("dialog.mcp.add")}
        </Button>
        <Button
          variant="secondary"
          icon="settings-gear"
          disabled={!selected()}
          onClick={() => {
            const name = selected()
            if (!name) return
            dialog.show(() => <DialogConfigureMcp name={name} />)
          }}
        >
          {language.t("dialog.mcp.configure")}
        </Button>
        <Button variant="secondary" icon="trash" disabled={!selected() || remove.isPending} onClick={deleteSelected}>
          {language.t("dialog.mcp.delete")}
        </Button>
      </div>
      <List
        class="px-3"
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.mcp.empty")}
        key={(x) => x?.name ?? ""}
        items={items}
        current={selectedItem()}
        filterKeys={["name", "status"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        onSelect={(x) => {
          if (!x) return
          setSelected(x.name)
        }}
      >
        {(i) => {
          const mcpStatus = () => sync.data.mcp[i.name]
          const status = () => mcpStatus()?.status
          const statusLabel = () => {
            const key = status() ? statusLabels[status() as keyof typeof statusLabels] : undefined
            if (!key) return
            return language.t(key)
          }
          const error = () => {
            const s = mcpStatus()
            if (s?.status === "failed" || s?.status === "needs_client_registration") return s.error
          }
          const enabled = () => status() === "connected"
          return (
            <div class="w-full flex items-center justify-between gap-x-3">
              <div class="flex flex-col gap-0.5 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="truncate">{i.name}</span>
                  <Show when={statusLabel()}>
                    <span class="text-11-regular text-text-weaker">{statusLabel()}</span>
                  </Show>
                </div>
                <Show when={error()}>
                  <span class="text-11-regular text-text-weaker truncate">{error()}</span>
                </Show>
              </div>
              <div onClick={(e) => e.stopPropagation()}>
                <Switch
                  checked={enabled()}
                  disabled={toggle.isPending && toggle.variables === i.name}
                  onChange={() => {
                    if (toggle.isPending) return
                    toggle.mutate(i.name)
                  }}
                />
              </div>
            </div>
          )
        }}
      </List>
    </Dialog>
  )
}
