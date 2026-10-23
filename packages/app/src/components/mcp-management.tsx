import { ButtonV2 } from "@deepagent-code/ui/v2/button-v2"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { Icon } from "@deepagent-code/ui/icon"
import { Switch } from "@deepagent-code/ui/v2/switch-v2"
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
import "./mcp-management.css"

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
    <div class="mcp-management">
      <div class="mcp-management-toolbar">
        <ButtonV2 variant="neutral" icon="plus" onClick={() => open(() => <DialogAddMcp />)}>
          {language.t("dialog.mcp.add")}
        </ButtonV2>
        <Show when={selectedMcp() && mcpStatus(selectedMcp()!)}>
          <ButtonV2
            variant="neutral"
            disabled={!selectedMcp() || mcpStatus(selectedMcp()!)?.status !== "connected"}
            onClick={() => {
              const name = selectedMcp()
              if (name) open(() => <DialogMcpApps name={name} />)
            }}
          >
            {language.t("mcp.apps.title")}
          </ButtonV2>
          <ButtonV2
            variant="neutral"
            icon="settings-gear"
            disabled={!selectedMcp()}
            onClick={() => {
              const name = selectedMcp()
              if (!name) return
              open(() => <DialogConfigureMcp name={name} />)
            }}
          >
            {language.t("dialog.mcp.configure")}
          </ButtonV2>
          <ButtonV2 variant="neutral" disabled={!selectedMcp() || removeMcp.isPending} onClick={deleteSelectedMcp}>
            <Icon name="trash" />
            {language.t("dialog.mcp.delete")}
          </ButtonV2>
          <ButtonV2
            variant="neutral"
            disabled={!selectedMcp()}
            onClick={() => {
              const name = selectedMcp()
              if (name) open(() => <DialogMcpSecrets name={name} />)
            }}
          >
            {language.t("mcp.secrets.open")}
          </ButtonV2>
        </Show>
      </div>
      <div class="mcp-management-list">
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
              const error = () => {
                const value = mcpStatus(name)
                if (value?.status === "failed" || value?.status === "needs_client_registration") return value.error
              }
              return (
                <div class="mcp-management-row" data-selected={selectedMcp() === name ? "" : undefined}>
                  <button type="button" class="mcp-management-server" onClick={() => setSelectedMcp(name)}>
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
                      <Show when={error()}>{(message) => <span class="mcp-management-error">{message()}</span>}</Show>
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
                  <div class="mcp-management-actions">
                    <Show when={mcpConnectionBlocked(mcpStatus(name))}>
                      <ButtonV2
                        variant="neutral"
                        disabled={refreshMcp.isPending}
                        onClick={() => {
                          if (current()) refreshMcp.mutate()
                        }}
                      >
                        {language.t("mcp.action.refresh")}
                      </ButtonV2>
                    </Show>
                    <Switch
                      checked={enabled()}
                      hideLabel
                      disabled={mcpConnectionBlocked(mcpStatus(name)) || toggleMcp.isPending}
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
