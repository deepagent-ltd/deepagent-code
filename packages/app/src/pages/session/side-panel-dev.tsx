import type { Component } from "solid-js"
import { Tabs } from "@deepagent-code/ui/tabs"
import { useLanguage } from "@/context/language"
import { SidePanelDebug } from "@/pages/session/side-panel-debug"
import { SidePanelProfile } from "@/pages/session/side-panel-profile"
import { SidePanelContext } from "@/pages/session/side-panel-context"

// WS1 (V2.0.1-001 §2): the Debug / Profiler / Context-evidence rail entries merged into ONE
// "Dev" panel with three tabs. The tab bodies are the original panels unchanged — each keeps
// its own header (title + refresh + close), and close still closes the whole right panel.
export const SidePanelDev: Component<{
  onClose: () => void
  onNavigate?: (file: string, line: number) => void
}> = (props) => {
  const language = useLanguage()

  return (
    <Tabs variant="pill" defaultValue="debug" class="h-full" data-scope="dev">
      <Tabs.List>
        <Tabs.Trigger value="debug" class="flex-1" classes={{ button: "w-full" }}>
          {language.t("session.panel.debug")}
        </Tabs.Trigger>
        <Tabs.Trigger value="profile" class="flex-1" classes={{ button: "w-full" }}>
          {language.t("session.panel.profile")}
        </Tabs.Trigger>
        <Tabs.Trigger value="context" class="flex-1" classes={{ button: "w-full" }}>
          {language.t("session.context.title")}
        </Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="debug" class="min-h-0">
        <SidePanelDebug onClose={props.onClose} onNavigate={props.onNavigate} />
      </Tabs.Content>
      <Tabs.Content value="profile" class="min-h-0">
        <SidePanelProfile onClose={props.onClose} />
      </Tabs.Content>
      <Tabs.Content value="context" class="min-h-0">
        <SidePanelContext onClose={props.onClose} />
      </Tabs.Content>
    </Tabs>
  )
}
