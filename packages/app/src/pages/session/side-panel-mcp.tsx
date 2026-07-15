import { Icon } from "@deepagent-code/ui/icon"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { McpManagement } from "@/components/mcp-management"
import { useLanguage } from "@/context/language"

export function SidePanelMcp(props: { onClose: () => void }) {
  const language = useLanguage()

  return (
    <div class="flex size-full min-w-0 flex-col overflow-hidden bg-background-base">
      <div class="flex h-10 shrink-0 items-center justify-between px-3">
        <span class="flex items-center gap-1.5 text-12-medium text-text">
          <Icon name="mcp" size="small" class="text-icon-base" />
          {language.t("status.popover.tab.mcp")}
        </span>
        <IconButton
          icon="close-small"
          variant="ghost"
          class="size-7 rounded-md"
          onClick={props.onClose}
          aria-label={language.t("common.close")}
        />
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <McpManagement />
      </div>
    </div>
  )
}
