import type { McpStatus } from "@deepagent-code/sdk/client"

export class McpRecoveryRequiredError extends Error {
  constructor() {
    super("MCP authentication outcome requires review")
    this.name = "McpRecoveryRequiredError"
  }
}

export function mcpConnectionBlocked(status: McpStatus | undefined) {
  return (
    status?.status === "disconnected" &&
    (!["authenticated", "expired", "not_authenticated", "legacy_unverified"].includes(status.authStatus) ||
      !["explicit_connect_required", "scope_changed"].includes(status.reason))
  )
}

export function mcpConnectionMessage(status: McpStatus | undefined) {
  if (status?.status !== "disconnected") return
  if (mcpConnectionBlocked(status) || status.authStatus === "unknown") return "mcp.connection.unknown_outcome" as const
  if (status.reason === "scope_changed") return "mcp.connection.scope_changed" as const
  return `mcp.connection.${status.authStatus}` as const
}

export async function toggleMcp(input: {
  status: McpStatus | undefined
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  authenticate: () => Promise<void>
  refresh: () => Promise<void>
}) {
  if (!input.status) throw new Error("MCP connection status is unavailable")
  if (mcpConnectionBlocked(input.status)) throw new McpRecoveryRequiredError()
  await {
    connected: input.disconnect,
    disconnected: input.connect,
    needs_auth: input.authenticate,
    disabled: input.connect,
    failed: input.connect,
    needs_client_registration: input.connect,
  }[input.status.status]()
  await input.refresh()
}
