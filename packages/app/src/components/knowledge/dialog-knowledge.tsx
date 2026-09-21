import { Component, Show } from "solid-js"
import { Dialog } from "@deepagent-code/ui/v2/dialog-v2"
import { Tabs } from "@deepagent-code/ui/tabs"
import { useLanguage } from "@/context/language"
import { ReviewPanel, type ReviewClient } from "@/components/review/dialog-review"
import { WikiPanel, type WikiClient } from "@/components/wiki/dialog-wiki"
import { PacksPanel, type PackClient } from "@/components/packs/dialog-packs"
import "../settings-v2/settings-v2.css"

export type KnowledgeTab = "review" | "wiki" | "packs"

// WS1 (V2.0.1-001 §2): the three left-rail knowledge entries — Knowledge Governance review,
// Repo & Wiki, Domain Packs — merged into ONE "Knowledge" dialog with tabs 审核 | Wiki | 领域包.
// The Wiki tab only shows when the server has the wiki capability (same gating the old rail
// entry used). Default tab is the governance review queue.
export const DialogKnowledge: Component<{
  client: ReviewClient & WikiClient & PackClient
  tab?: KnowledgeTab
  wikiAvailable?: boolean
}> = (props) => {
  const language = useLanguage()
  const wiki = () => props.wikiAvailable !== false
  const initial = (): KnowledgeTab => {
    if (props.tab === "wiki" && !wiki()) return "review"
    return props.tab ?? "review"
  }

  return (
    <Dialog size="x-large" variant="settings" title={language.t("knowledge.title")}>
      <Tabs variant="pill" defaultValue={initial()} class="h-full" data-scope="knowledge">
        <Tabs.List>
          <Tabs.Trigger value="review">{language.t("knowledge.tab.review")}</Tabs.Trigger>
          <Show when={wiki()}>
            <Tabs.Trigger value="wiki">{language.t("knowledge.tab.wiki")}</Tabs.Trigger>
          </Show>
          <Tabs.Trigger value="packs">{language.t("packs.title")}</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="review" class="min-h-0">
          <ReviewPanel client={props.client} />
        </Tabs.Content>
        <Show when={wiki()}>
          <Tabs.Content value="wiki" class="min-h-0">
            <WikiPanel client={props.client} />
          </Tabs.Content>
        </Show>
        <Tabs.Content value="packs" class="min-h-0">
          <PacksPanel client={props.client} />
        </Tabs.Content>
      </Tabs>
    </Dialog>
  )
}
