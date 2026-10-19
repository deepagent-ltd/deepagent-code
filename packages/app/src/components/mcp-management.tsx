import { Button } from "@deepagent-code/ui/button"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { Switch } from "@deepagent-code/ui/switch"
import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { DialogAddMcp } from "@/components/dialog-add-mcp"
import { DialogConfigureMcp } from "@/components/dialog-configure-mcp"
import { DialogMcpSecrets } from "@/components/dialog-mcp-secrets"
import { DialogMcpApps } from "@/components/dialog-mcp-apps"
import { useLanguage } from "@/context/language"
import { useMcpRemove, useMcpToggle, useMcpRefresh } from "@/context/mcp"
import { useSync } from "@/context/sync"
import { mcpConnectionBlocked, mcpConnectionMessage } from "@/context/global-sync/mcp"
import { SDKProvider, useSDK } from "@/context/sdk"

export function McpManagement(props: { current?: () => boolean } = {}) {
  const dialog = useDialog()
  const language = useLanguage()
  const sync = useSync()
  const sdk = useSDK()
  const captured = { directory: sdk.directory, scope: sdk.scope, client: sdk.client }
  const current = () =>
    props.current?.() !== false &&
    sdk.directory === captured.directory &&
    sdk.scope === captured.scope &&
    sdk.client === captured.client
  // Replacing a global Settings dialog retains that dialog's owner. Carry the original
  // project provider explicitly into each child, rather than selecting a new placement.
  const open = (element: () => JSX.Element) => {
    if (!current()) return
    dialog.show(() => (
      <Show when={current()}>
        <SDKProvider directory={captured.directory}>{element()}</SDKProvider>
      </Show>
    ))
  }
  const toggleMcp = useMcpToggle()
  const refreshMcp = useMcpRefresh()
  const removeMcp = useMcpRemove()
  const mcpNames = createMemo(() => Object.keys(sync.data.mcp ?? {}).sort((a, b) => a.localeCompare(b)))
  const [selectedMcp, setSelectedMcp] = createSignal<string>()
  const mcpStatus = (name: string) => sync.data.mcp?.[name]

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
    if (!current() || !name || removeMcp.isPending) return
    if (!window.confirm(language.t("dialog.mcp.delete.confirm", { name }))) return
    removeMcp.mutate(name)
  }

  return (
    <div class="flex min-w-0 flex-col">
      <div class="flex flex-wrap items-center gap-2 px-1 pb-2">
        <Button variant="secondary" icon="plus" onClick={() => open(() => <DialogAddMcp />)}>
          {language.t("dialog.mcp.add")}
        </Button>
        <Show when={selectedMcp() && mcpStatus(selectedMcp()!)}>
          <Button
            variant="secondary"
            disabled={!selectedMcp() || mcpStatus(selectedMcp()!)?.status !== "connected"}
            onClick={() => {
              const name = selectedMcp()
              if (name) open(() => <DialogMcpApps name={name} />)
            }}
          >
            {language.t("mcp.apps.title")}
          </Button>
          <Button
            variant="secondary"
            icon="settings-gear"
            disabled={!selectedMcp()}
            onClick={() => {
              const name = selectedMcp()
              if (!name) return
              open(() => <DialogConfigureMcp name={name} />)
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
          <Button
            variant="secondary"
            disabled={!selectedMcp()}
            onClick={() => {
              const name = selectedMcp()
              if (name) open(() => <DialogMcpSecrets name={name} />)
            }}
          >
            {language.t("mcp.secrets.open")}
          </Button>
        </Show>
      </div>
      <div class="flex min-h-14 flex-col rounded-sm bg-background-base p-3">
        <Show
          when={mcpNames().length > 0}
          fallback={
            <div class="my-auto text-center text-14-regular text-text-base">{language.t("dialog.mcp.empty")}</div>
          }
        >
          <For each={mcpNames()}>
            {(name) => {
              const status = () => mcpStatus(name)?.status
              const enabled = () => status() === "connected"
              return (
                <div
                  class="flex min-h-8 w-full items-center gap-2 rounded-md py-1 pl-3 pr-2 transition-colors hover:bg-surface-raised-base-hover"
                  classList={{ "bg-surface-raised-base": selectedMcp() === name }}
                >
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => setSelectedMcp(name)}
                  >
                    <div
                      classList={{
                        "size-1.5 shrink-0 rounded-full": true,
                        "bg-icon-success-base": status() === "connected",
                        "bg-icon-critical-base": status() === "failed",
                        "bg-border-weak-base":
                          status() === "disabled" ||
                          (status() === "disconnected" && !mcpConnectionBlocked(mcpStatus(name))),
                        "bg-icon-warning-base":
                          status() === "needs_auth" ||
                          status() === "needs_client_registration" ||
                          mcpConnectionBlocked(mcpStatus(name)),
                      }}
                    />
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span class="truncate text-14-regular text-text-base">{name}</span>
                      <Show when={status() === "disconnected"}>
                        <span class="text-11-regular text-text-weaker">{language.t("mcp.status.disconnected")}</span>
                      </Show>
                      <Show when={mcpConnectionMessage(mcpStatus(name))}>
                        {(key) => <span class="text-11-regular text-text-weaker">{language.t(key())}</span>}
                      </Show>
                      <Show when={status() === "needs_auth"}>
                        <span class="truncate text-11-regular text-text-weaker">
                          {language.t("mcp.auth.clickToAuthenticate")}
                        </span>
                      </Show>
                    </span>
                  </button>
                  <div class="flex shrink-0 items-center gap-2">
                    <Show when={mcpConnectionBlocked(mcpStatus(name))}>
                      <Button
                        variant="secondary"
                        disabled={refreshMcp.isPending}
                        onClick={() => {
                          if (current()) refreshMcp.mutate()
                        }}
                      >
                        {language.t("mcp.action.refresh")}
                      </Button>
                    </Show>
                    <Switch
                      checked={enabled()}
                      hideLabel
                      disabled={
                        mcpConnectionBlocked(mcpStatus(name)) || (toggleMcp.isPending && toggleMcp.variables === name)
                      }
                      onChange={() => {
                        if (!current() || toggleMcp.isPending) return
                        toggleMcp.mutate(name)
                      }}
                    >
                      {language.t(
                        enabled()
                          ? "mcp.action.disconnect"
                          : status() === "needs_auth"
                            ? "mcp.action.authenticate"
                            : "mcp.action.connect",
                      )}
                    </Switch>
                  </div>
                </div>
              )
            }}
          </For>
        </Show>
      </div>
    </div>
  )
}
