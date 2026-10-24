import { Show, type ComponentProps } from "solid-js"
import { Dialog } from "@deepagent-code/ui/v2/dialog-v2"
import { Tabs } from "@deepagent-code/ui/tabs"
import { Icon } from "@deepagent-code/ui/icon"
import { useLanguage } from "@/context/language"
import { KnowledgePanel } from "@/components/knowledge/dialog-knowledge"
import { HistoryProjectsPanel } from "@/components/history/dialog-history-projects"
import { ArchivedSessionsPanel } from "@/components/history/dialog-archived-sessions"

export type LibraryTab = "knowledge" | "history" | "archived"

export function DialogLibrary(props: {
  tab?: LibraryTab
  current?: () => boolean
  knowledge: ComponentProps<typeof KnowledgePanel>
  history: ComponentProps<typeof HistoryProjectsPanel>
  archived: ComponentProps<typeof ArchivedSessionsPanel>
}) {
  const language = useLanguage()
  return (
    <Dialog size="x-large" variant="settings" title={language.t("sidebar.library")}>
      <Show
        when={props.current?.() !== false}
        fallback={
          <p role="status" class="p-6 text-13-regular text-text-weak">
            {language.t("common.requestFailed")}
          </p>
        }
      >
        <Tabs variant="pill" defaultValue={props.tab ?? "knowledge"} class="h-full" data-scope="library">
          <Tabs.List class="shrink-0">
            <Tabs.Trigger value="knowledge" classes={{ button: "gap-2" }}>
              <Icon name="knowledge-check" size="small" />
              {language.t("knowledge.title")}
            </Tabs.Trigger>
            <Tabs.Trigger value="history" classes={{ button: "gap-2" }}>
              <Icon name="history" size="small" />
              {language.t("sidebar.history")}
            </Tabs.Trigger>
            <Tabs.Trigger value="archived" classes={{ button: "gap-2" }}>
              <Icon name="archive" size="small" />
              {language.t("session.archived.title")}
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="knowledge" class="min-h-0">
            <KnowledgePanel {...props.knowledge} />
          </Tabs.Content>
          <Tabs.Content value="history" class="min-h-0">
            <HistoryProjectsPanel {...props.history} />
          </Tabs.Content>
          <Tabs.Content value="archived" class="min-h-0">
            <ArchivedSessionsPanel {...props.archived} />
          </Tabs.Content>
        </Tabs>
      </Show>
    </Dialog>
  )
}
