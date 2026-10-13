import { Show } from "solid-js"
import type { MessageMetadata } from "./types"
import { useLanguage } from "@/context/language"
import { Button } from "@deepagent-code/ui/button"
import { Icon } from "@deepagent-code/ui/icon"

interface MessageMetadataCardProps {
  metadata: MessageMetadata
  onOpenConversationSession?: () => void
}

export function MessageMetadataCard(props: MessageMetadataCardProps) {
  const language = useLanguage()
  const handleFileClick = (path: string, line?: number) => {
    // In a real VSCode extension environment, use the VSCode API
    if (typeof window !== "undefined" && (window as any).vscode) {
      const vscode = (window as any).vscode
      vscode.postMessage({
        type: "openFile",
        path,
        line,
      })
    } else {
      // Fallback: construct vscode:// URL
      const lineParam = line ? `#L${line}` : ""
      window.open(`vscode://file/${path}${lineParam}`, "_blank")
    }
  }

  const handleCodeClick = (path?: string, startLine?: number) => {
    if (path) {
      handleFileClick(path, startLine)
    }
  }

  const metadata = props.metadata

  switch (metadata.type) {
    case "file_ref":
      return (
        <button
          type="button"
          onClick={() => handleFileClick(metadata.path, metadata.line)}
          class="inline-flex items-center gap-2 px-3 py-1.5 bg-surface-raised-base border border-border-base rounded-lg hover:bg-surface-raised-base-hover transition-colors cursor-pointer"
        >
          <span class="text-accent-base">📄</span>
          <div class="text-left">
            <div class="text-sm font-medium text-text-strong">{metadata.path}</div>
            <Show when={metadata.line}>
              <div class="text-xs text-text-weak">Line {metadata.line}</div>
            </Show>
          </div>
        </button>
      )

    case "code_ref":
      return (
        <button
          type="button"
          onClick={() => handleCodeClick(metadata.path, metadata.startLine)}
          class="inline-flex items-center gap-2 px-3 py-1.5 bg-surface-raised-base border border-border-base rounded-lg hover:bg-surface-raised-base-hover transition-colors cursor-pointer"
        >
          <span class="text-accent-base">💻</span>
          <div class="text-left">
            <div class="text-sm font-medium text-text-strong">{metadata.path ?? "Code reference"}</div>
            <Show when={metadata.startLine}>
              <div class="text-xs text-text-weak">
                Lines {metadata.startLine}-{metadata.endLine || metadata.startLine}
              </div>
            </Show>
          </div>
        </button>
      )

    case "agent_run":
      return (
        <div
          data-im-dac-result-card
          class="min-w-0 max-w-full grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 bg-surface-raised-base border border-border-base rounded-lg"
        >
          <div class="min-w-0 flex items-start gap-2 text-left">
            <Icon name="agent-tree" size="small" class="shrink-0 text-icon-weak mt-0.5" />
            <div class="min-w-0">
              <div class="whitespace-nowrap text-12-medium text-text-strong">{language.t("im.dac.resultTitle")}</div>
              <div class="text-12-regular text-text-weak [overflow-wrap:anywhere]">
                {language.t("im.dac.resultStatus")}: {metadata.status}
              </div>
            </div>
          </div>
          <Show when={props.onOpenConversationSession}>
            <Button
              size="small"
              variant="secondary"
              class="im-dac-result-open shrink-0 whitespace-nowrap"
              onClick={() => props.onOpenConversationSession?.()}
            >
              {language.t("im.dac.conversationSession")}
            </Button>
          </Show>
        </div>
      )

    case "debug":
      return (
        <div class="inline-flex items-center gap-2 px-3 py-1.5 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
          <span class="text-yellow-500">🐛</span>
          <div class="text-left">
            <div class="text-sm font-medium text-text-strong">Debug Info</div>
            <div class="text-xs text-text-weak font-mono">{metadata.info}</div>
          </div>
        </div>
      )

    case "profile":
      return (
        <div class="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-500/10 border border-blue-500/30 rounded-lg">
          <span class="text-blue-500">⏱️</span>
          <div class="text-left">
            <div class="text-sm font-medium text-text-strong">Performance: {metadata.operation}</div>
            <div class="text-xs text-text-weak">{metadata.duration}ms</div>
          </div>
        </div>
      )

    case "error":
      return (
        <div class="inline-flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border border-red-500/30 rounded-lg">
          <span class="text-red-500">❌</span>
          <div class="text-left">
            <div class="text-sm font-medium text-text-strong">Error: {metadata.code}</div>
            <div class="text-xs text-text-weak">{metadata.message}</div>
          </div>
        </div>
      )
  }
}
