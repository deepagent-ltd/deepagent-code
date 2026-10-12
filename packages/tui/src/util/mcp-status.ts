import type { McpStatus } from "@deepagent-code/sdk/client"

type Disconnected = Extract<McpStatus, { status: "disconnected" }>
export type McpConnectionView = {
  status: McpStatus["status"]
  authStatus?: Disconnected["authStatus"]
  reason?: Disconnected["reason"]
}

export function mcpConnectionBlocked(status: McpConnectionView | undefined) {
  return (
    status?.status === "disconnected" &&
    (!["authenticated", "expired", "not_authenticated", "legacy_unverified"].includes(status.authStatus ?? "") ||
      !["explicit_connect_required", "scope_changed"].includes(status.reason ?? ""))
  )
}

export function mcpConnectionMessage(status: McpConnectionView | undefined) {
  if (status?.status !== "disconnected") return
  if (mcpConnectionBlocked(status)) return "tui.mcp.connection.unknown_outcome" as const
  if (status.reason === "scope_changed") return "tui.mcp.connection.scope_changed" as const
  if (status.authStatus === "unknown" || status.authStatus === undefined)
    return "tui.mcp.connection.unknown_outcome" as const
  return `tui.mcp.connection.${status.authStatus}` as const
}
