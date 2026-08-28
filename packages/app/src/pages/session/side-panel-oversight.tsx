import { type Component } from "solid-js"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { useLanguage } from "@/context/language"
import { OversightDashboard } from "@/components/deepagent/oversight-dashboard"

// V4.0 §D2 — Oversight as a right-side-panel tab. Mirrors SidePanelIM: owns a header + close button
// (calls onClose), fills the panel with the OversightDashboard body. Read-mostly observability +
// approval queue + trace + human-takeover control, all scoped to the routed workspace/directory.
export const SidePanelOversight: Component<{ onClose: () => void }> = (props) => {
  const language = useLanguage()

  return (
    <div class="h-full w-full min-w-0 flex flex-col overflow-hidden bg-background-base">
      <div class="sticky top-0 z-10 h-10 shrink-0 flex items-center justify-between gap-1 px-2 bg-background-base border-b border-border-weaker-base">
        <span class="text-13-medium text-text-strong truncate pl-1">Oversight</span>
        <IconButton
          icon="close-small"
          variant="ghost"
          class="h-7 w-7 rounded-md"
          onClick={props.onClose}
          aria-label={language.t("common.close")}
        />
      </div>
      <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
        <OversightDashboard />
      </div>
    </div>
  )
}
