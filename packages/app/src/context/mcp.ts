import { useMutation } from "@tanstack/solid-query"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { showToast } from "@/utils/toast"

const handleMcpError = (title: string) => (error: unknown) =>
  showToast({
    variant: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  })

export function useMcpToggle() {
  const sync = useSync()
  const language = useLanguage()

  return useMutation(() => ({
    mutationFn: sync.mcp.toggle,
    onError: handleMcpError(language.t("common.requestFailed")),
  }))
}

// U8: one-click MCP server add. Mirrors useMcpToggle's error handling; on success the sync layer
// refetches the mcp query so the new server appears in the list.
export function useMcpAdd() {
  const sync = useSync()
  const language = useLanguage()

  return useMutation(() => ({
    mutationFn: (input: Parameters<typeof sync.mcp.add>[0]) => sync.mcp.add(input),
    onError: handleMcpError(language.t("common.requestFailed")),
  }))
}

export function useMcpUpdate() {
  const sync = useSync()
  const language = useLanguage()

  return useMutation(() => ({
    mutationFn: (input: Parameters<typeof sync.mcp.update>[0]) => sync.mcp.update(input),
    onError: handleMcpError(language.t("common.requestFailed")),
  }))
}

export function useMcpRemove() {
  const sync = useSync()
  const language = useLanguage()

  return useMutation(() => ({
    mutationFn: sync.mcp.remove,
    onError: handleMcpError(language.t("common.requestFailed")),
  }))
}
