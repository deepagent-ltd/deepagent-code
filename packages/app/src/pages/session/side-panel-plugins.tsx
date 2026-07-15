import { Component, createMemo, For, type JSXElement, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { Icon } from "@deepagent-code/ui/icon"
import { IconButton } from "@deepagent-code/ui/icon-button"

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

// Plugins side-panel view. Displays the list of configured plugin paths (from deepagent-code.json).
// Plugins are configured via the config file only (no UI add/remove), so this panel is read-only.
export const SidePanelPlugins: Component<{ onClose: () => void }> = (props) => {
  const sync = useSync()
  const language = useLanguage()

  const plugins = createMemo(() =>
    (sync.data.config.plugin ?? []).map((item) => (typeof item === "string" ? item : item[0])),
  )
  const pluginEmpty = createMemo(() => pluginEmptyMessage(language.t("dialog.plugins.empty"), "deepagent-code.json"))

  return (
    <div class="h-full w-full min-w-0 overflow-y-auto bg-background-base">
      <div class="sticky top-0 z-10 h-10 flex items-center justify-between px-3 bg-background-base">
        <span class="flex items-center gap-1.5 text-12-medium text-text">
          <Icon name="plugin" size="small" class="text-icon-base" />
          {language.t("status.popover.tab.plugins")}
        </span>
        <IconButton
          icon="close-small"
          variant="ghost"
          class="h-7 w-7 rounded-md"
          onClick={props.onClose}
          aria-label={language.t("common.close")}
        />
      </div>

    <div class="flex flex-col px-3 py-2">
        <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
          <Show
            when={plugins().length > 0}
         fallback={<div class="text-14-regular text-text-base text-center my-auto">{pluginEmpty()}</div>}
          >
          <For each={plugins()}>
              {(plugin) => (
                <div class="flex items-center gap-2 w-full px-2 py-1">
              <div class="size-1.5 rounded-full shrink-0 bg-icon-success-base" />
                  <span class="text-14-regular text-text-base truncate">{plugin}</span>
                </div>
         )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  )
}
