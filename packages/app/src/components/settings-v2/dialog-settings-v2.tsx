import { Component, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { SelectV2 } from "@deepagent-code/ui/v2/select-v2"
import { SettingsPage } from "./parts/page"
import { createMediaQuery } from "@solid-primitives/media"
import { Dialog } from "@deepagent-code/ui/v2/dialog-v2"
import { TabsV2 } from "@deepagent-code/ui/v2/tabs-v2"
import { Icon } from "@deepagent-code/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneralV2, type SettingsSession } from "./general"
import { SettingsKeybinds } from "../settings-keybinds"
import { SettingsProvidersV2 } from "./providers"
import { SettingsModelsV2 } from "./models"
import "./settings-v2.css"
import { SettingsServersV2 } from "./servers"
import { SettingsAboutV2 } from "./about"
import { SettingsCapabilitiesV2 } from "./capabilities"
import { SettingsPluginsV2 } from "./plugins"
import { McpManagement } from "../mcp-management"
import { SDKProvider } from "@/context/sdk"
import { SettingsIMV2 } from "./im"

export const DialogSettings: Component<{
  session?: SettingsSession
  mcp?: { directory: string; current: () => boolean }
  initialTab?: "general" | "im"
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const compact = createMediaQuery("(max-width: 767px)")
  const [state, setState] = createStore({ tab: (props.initialTab ?? "general") as string })
  const groups = [
    {
      title: "settings.section.common",
      items: [
        { value: "general", label: "settings.tab.general", icon: "sliders" },
        { value: "shortcuts", label: "settings.tab.shortcuts", icon: "keyboard" },
      ],
    },
    {
      title: "settings.section.models",
      items: [
        { value: "providers", label: "settings.providers.title", icon: "providers" },
        { value: "models", label: "settings.models.title", icon: "models" },
      ],
    },
    {
      title: "settings.section.collaboration",
      items: [{ value: "im", label: "settings.im.title", icon: "speech-bubble" }],
    },
    {
      title: "settings.section.extensions",
      items: [
        { value: "mcp", label: "status.popover.tab.mcp", icon: "mcp" },
        { value: "capabilities", label: "settings.capabilities.title", icon: "package" },
        { value: "plugins", label: "status.popover.tab.plugins", icon: "plugin" },
      ],
    },
    {
      title: "settings.section.advanced",
      items: [{ value: "servers", label: "status.popover.tab.servers", icon: "server" }],
    },
    { title: "settings.section.product", items: [{ value: "about", label: "settings.tab.about", icon: "help" }] },
  ] as const
  const pages = groups.flatMap((group) =>
    group.items.map((page) => ({ value: page.value, label: page.label, icon: page.icon })),
  )

  return (
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      <TabsV2
        orientation={compact() ? "horizontal" : "vertical"}
        variant="settings"
        value={state.tab}
        onChange={(tab) => setState("tab", tab)}
        class="settings-v2"
      >
        <Show when={compact()}>
          <div class="settings-v2-compact-navigation">
            <SelectV2
              options={pages}
              current={pages.find((page) => page.value === state.tab)}
              value={(page) => page.value}
              label={(page) => language.t(page.label)}
              onSelect={(page) => page && setState("tab", page.value)}
              aria-label={language.t("settings.navigation.label")}
            />
          </div>
        </Show>
        <TabsV2.List classList={{ "settings-v2-navigation-hidden": compact() }}>
          <nav class="settings-v2-navigation" aria-label={language.t("settings.navigation.label")}>
            <div class="settings-v2-navigation-groups">
              <For each={groups}>
                {(group) => (
                  <div class="settings-v2-navigation-group">
                    <TabsV2.SectionTitle>{language.t(group.title)}</TabsV2.SectionTitle>
                    <For each={group.items}>
                      {(page) => (
                        <TabsV2.Trigger value={page.value}>
                          <Icon name={page.icon} />
                          {language.t(page.label)}
                        </TabsV2.Trigger>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>
            <div class="settings-v2-nav-footer">
              <span>{language.t("app.name.desktop")}</span>
              <span>v{platform.version}</span>
            </div>
          </nav>
        </TabsV2.List>
        <TabsV2.Content value="general" class="settings-v2-panel">
          <SettingsGeneralV2 session={props.session} />
        </TabsV2.Content>
        <TabsV2.Content value="mcp" class="settings-v2-panel">
          <SettingsPage title={language.t("status.popover.tab.mcp")}>
            <Show
              when={props.mcp?.current() && props.mcp.directory}
              fallback={<p>{language.t("settings.mcp.selectProject")}</p>}
            >
              {(directory) => (
                <SDKProvider directory={directory()}>
                  <McpManagement current={() => props.mcp?.current() === true} />
                </SDKProvider>
              )}
            </Show>
          </SettingsPage>
        </TabsV2.Content>
        <TabsV2.Content value="shortcuts" class="settings-v2-panel">
          <SettingsKeybinds v2 />
        </TabsV2.Content>
        <TabsV2.Content value="servers" class="settings-v2-panel">
          <SettingsServersV2 />
        </TabsV2.Content>
        <TabsV2.Content value="providers" class="settings-v2-panel">
          <SettingsProvidersV2 />
        </TabsV2.Content>
        <TabsV2.Content value="models" class="settings-v2-panel">
          <SettingsModelsV2 />
        </TabsV2.Content>
        <TabsV2.Content value="im" class="settings-v2-panel">
          <SettingsIMV2 />
        </TabsV2.Content>
        <TabsV2.Content value="capabilities" class="settings-v2-panel">
          <SettingsCapabilitiesV2 />
        </TabsV2.Content>
        <TabsV2.Content value="plugins" class="settings-v2-panel">
          <SettingsPluginsV2 />
        </TabsV2.Content>
        <TabsV2.Content value="about" class="settings-v2-panel">
          <SettingsAboutV2 />
        </TabsV2.Content>
      </TabsV2>
    </Dialog>
  )
}
