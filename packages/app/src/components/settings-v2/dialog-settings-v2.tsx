import { Component, Show } from "solid-js"
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
  const compact = createMediaQuery("(max-width: 639px)")

  return (
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      <TabsV2
        orientation={compact() ? "horizontal" : "vertical"}
        variant="settings"
        defaultValue={props.initialTab ?? "general"}
        class="settings-v2"
      >
        <TabsV2.List>
          <div class="flex flex-col justify-between h-full w-full">
            <div class="flex flex-col gap-3 w-full">
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>{language.t("settings.section.desktop")}</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="general">
                      <Icon name="sliders" />
                      {language.t("settings.tab.general")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="shortcuts">
                      <Icon name="keyboard" />
                      {language.t("settings.tab.shortcuts")}
                    </TabsV2.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>{language.t("settings.section.server")}</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="servers">
                      <Icon name="server" />
                      {language.t("status.popover.tab.servers")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="providers">
                      <Icon name="providers" />
                      {language.t("settings.providers.title")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="models">
                      <Icon name="models" />
                      {language.t("settings.models.title")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="im">
                      <Icon name="speech-bubble" />
                      {language.t("settings.im.title")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="mcp">
                      <Icon name="mcp" />
                      {language.t("status.popover.tab.mcp")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="capabilities">
                      <Icon name="package" />
                      {language.t("settings.capabilities.title")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="plugins">
                      <Icon name="plugin" />
                      {language.t("status.popover.tab.plugins")}
                    </TabsV2.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>{language.t("settings.section.about")}</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="about">
                      <Icon name="help" />
                      {language.t("settings.tab.about")}
                    </TabsV2.Trigger>
                  </div>
                </div>
              </div>
            </div>
            <div class="settings-v2-nav-footer">
              <span>{language.t("app.name.desktop")}</span>
              <span>v{platform.version}</span>
            </div>
          </div>
        </TabsV2.List>
        <TabsV2.Content value="general" class="settings-v2-panel">
          <SettingsGeneralV2 session={props.session} />
        </TabsV2.Content>
        <TabsV2.Content value="mcp" class="settings-v2-panel">
          <div class="settings-v2-tab-body">
            <h2 class="settings-v2-tab-title">{language.t("status.popover.tab.mcp")}</h2>
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
          </div>
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
