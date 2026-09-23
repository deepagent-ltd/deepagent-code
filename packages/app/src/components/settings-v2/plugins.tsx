import { Component, createMemo, For, type JSXElement, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { SettingsListV2 } from "./parts/list"
import "./settings-v2.css"

const pluginEmptyMessage = (value: string, file: string): JSXElement => {
  const parts = value.split(file)
  if (parts.length === 1) return value
  return (
    <>
      {parts[0]}
      <code class="bg-surface-raised-base px-1.5 py-0.5 rounded-sm text-text-base">{file}</code>
      {parts.slice(1).join(file)}
    </>
  )
}

// WS1: plugins moved from the right-panel rail into a Settings tab. The list is read-only —
// plugins are configured via the config file only (no UI add/remove).
export const SettingsPluginsV2: Component = () => {
  const sync = useSync()
  const language = useLanguage()

  const plugins = createMemo(() =>
    (sync.data.config.plugin ?? []).map((item) => (typeof item === "string" ? item : item[0])),
  )
  const pluginEmpty = createMemo(() => pluginEmptyMessage(language.t("dialog.plugins.empty"), "deepagent-code.json"))

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("status.popover.tab.plugins")}</h2>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <SettingsListV2>
            <Show
              when={plugins().length > 0}
              fallback={<div class="p-3 text-13-regular text-v2-text-text-faint">{pluginEmpty()}</div>}
            >
              <For each={plugins()}>
                {(plugin) => (
                  <div class="flex items-center gap-2 px-3 py-2">
                    <div class="size-1.5 rounded-full shrink-0 bg-icon-success-base" />
                    <span class="text-13-regular text-v2-text-text-base truncate">{plugin}</span>
                  </div>
                )}
              </For>
            </Show>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
