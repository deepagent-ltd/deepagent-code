import { Dialog } from "@deepagent-code/ui/v2/dialog-v2"
import { Tabs } from "@deepagent-code/ui/tabs"
import { useLanguage } from "@/context/language"
import { SessionContextTab } from "@/components/session/session-context-tab"
import { SessionStatsContent } from "@/pages/session/side-panel-stats"
import "@/components/settings-v2/settings-v2.css"

// WS1 (V2.0.1-001 §2): the old "stats" (Usage & cost) rail panel moved here — the popup now has
// two tabs: the current session's context usage and the cross-session 全部会话/All sessions view.
// Kept in its own module so message-timeline only pays for it when the dialog actually opens.
export function SessionContextUsageDialog() {
  const language = useLanguage()

  return (
    <Dialog size="x-large" variant="settings" title={language.t("session.stats.title")}>
      <Tabs variant="pill" defaultValue="session" class="h-full" data-scope="context-usage">
        <Tabs.List>
          <Tabs.Trigger value="session">{language.t("session.stats.currentSession")}</Tabs.Trigger>
          <Tabs.Trigger value="all">{language.t("session.stats.allSessions")}</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="session" class="min-h-0">
          <SessionContextTab />
        </Tabs.Content>
        <Tabs.Content value="all" class="min-h-0">
          <SessionStatsContent />
        </Tabs.Content>
      </Tabs>
    </Dialog>
  )
}
