import { Show } from "solid-js"
import type { MessageMetadata } from "./types"

interface MessageMetadataCardProps {
  metadata: MessageMetadata
}

export function MessageMetadataCard(props: MessageMetadataCardProps) {
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
        <div class="inline-flex items-center gap-2 px-3 py-1.5 bg-surface-raised-base border border-border-base rounded-lg">
          <span class="text-accent-base">🤖</span>
          <div class="text-left">
            <div class="text-sm font-medium text-text-strong">Agent Run</div>
            <div class="text-xs text-text-weak">Status: {metadata.status}</div>
          </div>
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
