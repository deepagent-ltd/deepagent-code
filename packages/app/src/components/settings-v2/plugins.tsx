import { Component, createMemo, For, type JSXElement, Show } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { SettingsListV2 } from "./parts/list"
import { SettingsPage } from "./parts/page"
import { SettingsMetadata } from "./metadata"
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
  const sync = useServerSync()
  const language = useLanguage()

  const plugins = createMemo(() =>
    (sync.data.config.plugin ?? []).map((item) => (typeof item === "string" ? item : item[0])),
  )
  const pluginEmpty = createMemo(() => pluginEmptyMessage(language.t("dialog.plugins.empty"), "deepagent-code.json"))

  return (
    <SettingsPage
      title={language.t("status.popover.tab.plugins")}
      description={language.t("settings.plugins.description")}
    >
      <div class="settings-v2-section">
        <SettingsListV2>
          <Show
            when={plugins().length > 0}
            fallback={<div class="p-3 text-13-regular text-v2-text-text-faint">{pluginEmpty()}</div>}
          >
            <For each={plugins()}>
              {(plugin) => (
                <div class="min-w-0 px-3 py-3 space-y-2">
                  <div class="settings-v2-actions">
                    <span class="min-w-0 flex-1 truncate text-13-regular text-v2-text-text-base" title={plugin}>
                      {plugin}
                    </span>
                    <span class="text-12-regular text-text-weak">{language.t("settings.plugins.configured")}</span>
                  </div>
                  <SettingsMetadata title={language.t("settings.plugins.identifier")} value={plugin} />
                </div>
              )}
            </For>
          </Show>
        </SettingsListV2>
      </div>
    </SettingsPage>
  )
}
