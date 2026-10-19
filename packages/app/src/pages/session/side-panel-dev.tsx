import { createResource, createSignal, Show, type Component } from "solid-js"
import { useSDK } from "@/context/sdk"
import { fetchCapabilities } from "@/components/deepagent/panel-goal.api"
import { OversightDashboard } from "@/components/deepagent/oversight-dashboard"
import { SidePanelDebugConsole } from "./side-panel-terminal"
import { Tabs } from "@deepagent-code/ui/tabs"
import { useLanguage } from "@/context/language"
import { SidePanelDebug } from "@/pages/session/side-panel-debug"
import { SidePanelProfile } from "@/pages/session/side-panel-profile"
import { SidePanelContext } from "@/pages/session/side-panel-context"

// WS1 (V2.0.1-001 §2): the Debug / Profiler / Context-evidence rail entries merged into ONE
// "Dev" panel with three tabs. The tab bodies are the original panels unchanged — each keeps
// its own header (title + refresh + close), and close still closes the whole right panel.
export const SidePanelDev: Component<{
  standalone?: boolean
  onClose: () => void
  onNavigate?: (file: string, line: number) => void
}> = (props) => {
  const language = useLanguage()
  const sdk = useSDK()
  const [advanced, setAdvanced] = createSignal(false)
  const [capabilities] = createResource(() =>
    fetchCapabilities(sdk.client as unknown as Parameters<typeof fetchCapabilities>[0]).catch(() => null),
  )

  return (
    <Tabs variant="pill" defaultValue="debug" class="h-full" data-scope="dev">
      <Show when={!props.standalone}>
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
      </Show>
      <Tabs.Content value="debug" class="min-h-0">
        <div class="h-full min-h-0 overflow-y-auto">
          <SidePanelDebug onClose={props.onClose} onNavigate={props.onNavigate} />
          <details
            class="m-3 rounded-lg bg-surface-raised-base px-3 py-2"
            onToggle={(event) => setAdvanced(event.currentTarget.open)}
          >
            <summary class="cursor-pointer text-12-medium">{language.t("session.panel.debugConsole")}</summary>
            <Show when={advanced()}>
              <SidePanelDebugConsole onClose={props.onClose} />
              <Show when={capabilities()?.v4MultiAgentRuntime}>
                <OversightDashboard />
              </Show>
            </Show>
          </details>
        </div>
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
