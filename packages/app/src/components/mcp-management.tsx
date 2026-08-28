import { Button } from "@deepagent-code/ui/button"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { Switch } from "@deepagent-code/ui/switch"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { DialogAddMcp } from "@/components/dialog-add-mcp"
import { DialogConfigureMcp } from "@/components/dialog-configure-mcp"
import { useLanguage } from "@/context/language"
import { useMcpRemove, useMcpToggle } from "@/context/mcp"
import { useSync } from "@/context/sync"

export function McpManagement() {
  const dialog = useDialog()
  const language = useLanguage()
  const sync = useSync()
  const toggleMcp = useMcpToggle()
  const removeMcp = useMcpRemove()
  const mcpNames = createMemo(() => Object.keys(sync.data.mcp ?? {}).sort((a, b) => a.localeCompare(b)))
  const [selectedMcp, setSelectedMcp] = createSignal<string>()
  const mcpStatus = (name: string) => sync.data.mcp?.[name]?.status

  createEffect(() => {
    const names = mcpNames()
    if (names.length === 0) {
      setSelectedMcp(undefined)
      return
    }
    if (!selectedMcp() || !names.includes(selectedMcp()!)) setSelectedMcp(names[0])
  })

  const deleteSelectedMcp = () => {
    const name = selectedMcp()
    if (!name || removeMcp.isPending) return
    if (!window.confirm(language.t("dialog.mcp.delete.confirm", { name }))) return
    removeMcp.mutate(name)
  }

  return (
    <div class="flex min-w-0 flex-col">
      <div class="flex flex-wrap items-center gap-2 px-1 pb-2">
        <Button variant="secondary" icon="plus" onClick={() => dialog.show(() => <DialogAddMcp />)}>
          {language.t("dialog.mcp.add")}
        </Button>
        <Button
          variant="secondary"
          icon="settings-gear"
          disabled={!selectedMcp()}
          onClick={() => {
            const name = selectedMcp()
            if (!name) return
            dialog.show(() => <DialogConfigureMcp name={name} />)
          }}
        >
          {language.t("dialog.mcp.configure")}
        </Button>
        <Button
          variant="secondary"
          icon="trash"
          disabled={!selectedMcp() || removeMcp.isPending}
          onClick={deleteSelectedMcp}
        >
          {language.t("dialog.mcp.delete")}
        </Button>
      </div>
      <div class="flex min-h-14 flex-col rounded-sm bg-background-base p-3">
        <Show
          when={mcpNames().length > 0}
          fallback={<div class="my-auto text-center text-14-regular text-text-base">{language.t("dialog.mcp.empty")}</div>}
        >
          <For each={mcpNames()}>
            {(name) => {
              const status = () => mcpStatus(name)
              const enabled = () => status() === "connected"
              return (
                <button
                  type="button"
                  class="flex min-h-8 w-full items-center gap-2 rounded-md py-1 pl-3 pr-2 text-left transition-colors hover:bg-surface-raised-base-hover"
                  classList={{ "bg-surface-raised-base": selectedMcp() === name }}
                  onClick={() => setSelectedMcp(name)}
                >
                  <div
                    classList={{
                      "size-1.5 shrink-0 rounded-full": true,
                      "bg-icon-success-base": status() === "connected",
                      "bg-icon-critical-base": status() === "failed",
                      "bg-border-weak-base": status() === "disabled",
                      "bg-icon-warning-base":
                        status() === "needs_auth" || status() === "needs_client_registration",
                    }}
                  />
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-14-regular text-text-base">{name}</span>
                    <Show when={status() === "needs_auth"}>
                      <span class="truncate text-11-regular text-text-weaker">
                        {language.t("mcp.auth.clickToAuthenticate")}
                      </span>
                    </Show>
                  </span>
                  <div onClick={(event) => event.stopPropagation()}>
                    <Switch
                      checked={enabled()}
                      disabled={toggleMcp.isPending && toggleMcp.variables === name}
                      onChange={() => {
                        if (toggleMcp.isPending) return
                        toggleMcp.mutate(name)
                      }}
                    />
                  </div>
                </button>
              )
            }}
          </For>
        </Show>
      </div>
    </div>
  )
}
