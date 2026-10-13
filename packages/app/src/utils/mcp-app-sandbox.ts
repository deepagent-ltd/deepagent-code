import { McpAppSandbox } from "@deepagent-code/core/mcp/app-sandbox"

export const mcpAppPermissions = McpAppSandbox.permissions

export function mcpAppSandboxUrl(base: string) {
  const url = new URL(base)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Invalid MCP sandbox server URL")
  return new URL(McpAppSandbox.path, url).href
}

type RpcID = string | number
type RpcMessage = { jsonrpc: "2.0"; id?: RpcID; method: string; params?: Record<string, unknown> }

function readMessage(value: unknown): RpcMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const message = value as Record<string, unknown>
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string" || message.method.length > 128) return
  if (
    message.id !== undefined &&
    !(
      (typeof message.id === "string" && message.id.length <= 128) ||
      (typeof message.id === "number" && Number.isSafeInteger(message.id))
    )
  )
    return
  if (
    message.params !== undefined &&
    (!message.params || typeof message.params !== "object" || Array.isArray(message.params))
  )
    return
  if (!withinMessageBudget(message)) return
  return message as RpcMessage
}

function withinMessageBudget(value: unknown) {
  const pending = [{ value, depth: 0 }]
  const seen = new Set<object>()
  let bytes = 0
  let nodes = 0
  while (pending.length) {
    const item = pending.pop()!
    if (++nodes > 128 || item.depth > 8) return false
    if (typeof item.value === "string") {
      if (item.value.length > 32768) return false
      bytes += new TextEncoder().encode(item.value).length
      if (bytes > 32768) return false
      continue
    }
    if (
      item.value === null ||
      typeof item.value === "boolean" ||
      (typeof item.value === "number" && Number.isFinite(item.value))
    )
      continue
    if (!item.value || typeof item.value !== "object" || seen.has(item.value)) return false
    seen.add(item.value)
    const entries = Object.entries(item.value)
    if (entries.length > 64) return false
    entries.forEach(([key, child]) => {
      bytes += key.length
      pending.push({ value: child, depth: item.depth + 1 })
    })
    if (bytes > 32768) return false
  }
  return true
}

export function createMcpAppBridge(input: {
  html: string
  post: (message: Record<string, unknown>) => void
  context?: { theme?: "light" | "dark"; locale?: string }
  onReady?: () => void
  onSize?: (height: number) => void
  onInvalidated?: () => void
  invoke?: (input: {
    rpcID: RpcID
    name: string
    arguments: Record<string, unknown>
  }) => Promise<Record<string, unknown>>
  listTools?: () => Promise<Record<string, unknown>>
}) {
  let state: "proxy" | "initialize" | "confirm" | "ready" | "closed" = "proxy"
  let messages = 0
  const pending = new Map<string, string>()
  const fail = (id: RpcID, code: number, message: string) =>
    input.post({ jsonrpc: "2.0", id, error: { code, message } })
  return {
    receive(value: unknown) {
      if (state === "closed") return
      if (++messages > 512) {
        state = "closed"
        input.post({ jsonrpc: "2.0", method: "ui/notifications/sandbox-close" })
        input.onInvalidated?.()
        return
      }
      const message = readMessage(value)
      if (!message) return
      if (message.method === "ui/notifications/sandbox-resource-invalidated") {
        state = "closed"
        input.post({ jsonrpc: "2.0", method: "ui/notifications/sandbox-close" })
        input.onInvalidated?.()
        return
      }
      if (message.method === "ui/notifications/sandbox-proxy-ready" && state === "proxy") {
        state = "initialize"
        input.post({ jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params: { html: input.html } })
        return
      }
      if (message.method === "ui/initialize" && state === "initialize" && message.id !== undefined) {
        if (message.params?.protocolVersion !== "2026-01-26") {
          fail(message.id, -32602, "Unsupported MCP Apps protocol version")
          return
        }
        state = "confirm"
        input.post({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2026-01-26",
            hostInfo: { name: "DeepAgent Code", version: "2.0.3" },
            hostCapabilities: {
              ...(input.invoke && input.listTools ? { serverTools: {} } : {}),
              sandbox: {
                csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
                permissions: {},
              },
            },
            hostContext: {
              ...input.context,
              displayMode: "inline",
              availableDisplayModes: ["inline"],
              containerDimensions: { maxHeight: 640 },
            },
          },
        })
        return
      }
      if (message.method === "ui/notifications/initialized" && state === "confirm") {
        state = "ready"
        input.onReady?.()
        return
      }
      if (state !== "ready") {
        if (message.id !== undefined) fail(message.id, -32000, "MCP App is not initialized")
        return
      }
      // An in-flight JSON-RPC ID has one reply. Exact retransmission joins the original;
      // conflicting reuse retires this observer rather than starting another effect.
      if (message.id !== undefined && pending.has(JSON.stringify([typeof message.id, message.id]))) {
        if (
          pending.get(JSON.stringify([typeof message.id, message.id])) ===
          JSON.stringify([message.method, message.params])
        )
          return
        state = "closed"
        input.post({ jsonrpc: "2.0", method: "ui/notifications/sandbox-close" })
        input.onInvalidated?.()
        return
      }
      if (message.method === "ping" && message.id !== undefined) {
        input.post({ jsonrpc: "2.0", id: message.id, result: {} })
        return
      }
      if (message.method === "ui/notifications/size-changed") {
        const height = message.params?.height
        if (typeof height === "number" && Number.isFinite(height))
          input.onSize?.(Math.max(120, Math.min(640, Math.round(height))))
        return
      }
      if (message.method === "tools/call" && message.id !== undefined && input.invoke) {
        const name = message.params?.name
        const args = message.params?.arguments ?? {}
        if (
          typeof name !== "string" ||
          !name ||
          name.length > 256 ||
          !args ||
          typeof args !== "object" ||
          Array.isArray(args)
        ) {
          fail(message.id, -32602, "Invalid MCP App tool arguments")
          return
        }
        const rpcID = message.id
        const key = JSON.stringify([typeof rpcID, rpcID])
        if (pending.size >= 8) {
          fail(rpcID, -32000, "MCP App invocation capacity exceeded")
          return
        }
        pending.set(key, JSON.stringify([message.method, message.params]))
        void input
          .invoke({ rpcID, name, arguments: args as Record<string, unknown> })
          .then(
            (result) => {
              if (state === "ready") input.post({ jsonrpc: "2.0", id: rpcID, result })
            },
            () => {
              if (state === "ready")
                fail(
                  rpcID,
                  -32000,
                  "MCP App invocation did not produce an available result; inspect its original status before retrying",
                )
            },
          )
          .finally(() => pending.delete(key))
        return
      }
      if (message.method === "tools/list" && message.id !== undefined && input.listTools) {
        const rpcID = message.id
        if (message.params && Object.keys(message.params).length) {
          fail(rpcID, -32602, "This MCP App tool snapshot does not accept pagination or query parameters")
          return
        }
        if (pending.size >= 8) {
          fail(rpcID, -32000, "MCP App invocation capacity exceeded")
          return
        }
        const key = JSON.stringify([typeof rpcID, rpcID])
        pending.set(key, JSON.stringify([message.method, message.params]))
        void input
          .listTools()
          .then(
            (result) => {
              if (state === "ready") input.post({ jsonrpc: "2.0", id: rpcID, result })
            },
            () => {
              if (state === "ready") fail(rpcID, -32000, "The original MCP App tool snapshot is unavailable")
            },
          )
          .finally(() => pending.delete(key))
        return
      }
      if (message.id !== undefined)
        fail(
          message.id,
          -32601,
          "UNSUPPORTED_CAPABILITY: this view cannot execute tools, read other resources, navigate, or access host services",
        )
    },
    close() {
      if (state === "closed") return
      state = "closed"
      input.post({ jsonrpc: "2.0", method: "ui/notifications/sandbox-close" })
    },
  }
}
