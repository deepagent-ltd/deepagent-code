import { describe, expect, test } from "bun:test"
import { createMcpAppBridge, mcpAppSandboxUrl } from "./mcp-app-sandbox"

describe("MCP App bridge lifecycle", () => {
  test("a bound initialized view keeps one pending RPC and retires conflicting reuse without a second effect", async () => {
    const sent: Record<string, unknown>[] = []
    const calls: unknown[] = []
    let complete: ((result: Record<string, unknown>) => void) | undefined
    const bridge = createMcpAppBridge({ html: "", post: (message) => sent.push(message),
      invoke: (input) => { calls.push(input); return new Promise((resolve) => { complete = resolve }) },
      listTools: async () => ({ tools: [{ name: "owned", inputSchema: { type: "object" } }] }),
    })
    bridge.receive({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" })
    bridge.receive({ jsonrpc: "2.0", id: 0, method: "ui/initialize", params: { protocolVersion: "2026-01-26" } })
    expect(sent.at(-1)?.result).toMatchObject({ hostCapabilities: { serverTools: {} } })
    bridge.receive({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "owned" } })
    expect(calls).toHaveLength(0)
    bridge.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" })
    const original = { jsonrpc: "2.0", id: "call", method: "tools/call", params: { name: "owned", arguments: { text: "hello" } } }
    bridge.receive(original)
    bridge.receive(original)
    expect(calls).toHaveLength(1)
    expect(sent.filter((message) => message.id === "call")).toHaveLength(0)
    bridge.receive({ ...original, params: { name: "other" } })
    expect(sent.at(-1)?.method).toBe("ui/notifications/sandbox-close")
    complete?.({ content: [{ type: "text", text: "original result" }] })
    await Promise.resolve()
    expect(calls).toHaveLength(1)
    expect(sent.filter((message) => message.id === "call")).toHaveLength(0)
  })

  test("list and call share a bounded pending window, preserve typed IDs and discard late results after close", async () => {
    const sent: Record<string, unknown>[] = []
    const releases: (() => void)[] = []
    const bridge = createMcpAppBridge({ html: "", post: (message) => sent.push(message), invoke: async () => ({}),
      listTools: () => new Promise((resolve) => { releases.push(() => resolve({ tools: [] })) }),
    })
    bridge.receive({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" })
    bridge.receive({ jsonrpc: "2.0", id: "init", method: "ui/initialize", params: { protocolVersion: "2026-01-26" } })
    bridge.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" })
    for (const id of [0, "0", 1, 2, 3, 4, 5, 6]) bridge.receive({ jsonrpc: "2.0", id, method: "tools/list" })
    bridge.receive({ jsonrpc: "2.0", id: 7, method: "tools/list" })
    expect(releases).toHaveLength(8)
    expect(sent.at(-1)).toMatchObject({ id: 7, error: { code: -32000 } })
    bridge.close()
    releases.forEach((release) => release())
    await Promise.resolve()
    expect(sent.filter((message) => message.id !== "init" && "result" in message)).toHaveLength(0)
  })
  test("negotiates once without granting tool, resource or host access", () => {
    const sent: Record<string, unknown>[] = []
    const heights: number[] = []
    const ready: boolean[] = []
    const bridge = createMcpAppBridge({ html: "<h1>App</h1>", post: (message) => sent.push(message), onReady: () => ready.push(true), onSize: (height) => heights.push(height) })
    bridge.receive({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "write" } })
    expect(sent.at(-1)?.error).toMatchObject({ code: -32000 })
    bridge.receive({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" })
    expect(sent.at(-1)).toMatchObject({ method: "ui/notifications/sandbox-resource-ready", params: { html: "<h1>App</h1>" } })
    bridge.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26", appCapabilities: {} } })
    expect(sent.at(-1)?.result).toMatchObject({ protocolVersion: "2026-01-26", hostCapabilities: { sandbox: { permissions: {} } } })
    expect((sent.at(-1)?.result as Record<string, unknown>).hostCapabilities).not.toHaveProperty("serverTools")
    bridge.receive({ jsonrpc: "2.0", id: 2, method: "ping" })
    expect(sent.at(-1)?.error).toMatchObject({ code: -32000 })
    bridge.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" })
    bridge.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" })
    expect(ready).toEqual([true])
    bridge.receive({ jsonrpc: "2.0", id: 3, method: "ping" })
    expect(sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 3, result: {} })
    for (const method of ["tools/call", "resources/read", "ui/open-link", "ui/message", "host/ipc", "ui/initialize"]) {
      bridge.receive({ jsonrpc: "2.0", id: method, method, params: {} })
      expect(sent.at(-1)?.error).toMatchObject({ code: -32601 })
    }
    bridge.receive({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 1 } })
    bridge.receive({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 10000 } })
    expect(heights).toEqual([120, 640])
    bridge.close()
    const count = sent.length
    bridge.close()
    bridge.receive({ jsonrpc: "2.0", id: 4, method: "ping" })
    expect(sent).toHaveLength(count)
    expect(sent.at(-1)).toEqual({ jsonrpc: "2.0", method: "ui/notifications/sandbox-close" })
  })

  test("bounds and rejects malformed structured-clone input without breaking the host", () => {
    const sent: Record<string, unknown>[] = []
    const bridge = createMcpAppBridge({ html: "", post: (message) => sent.push(message) })
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const value of [null, [], {}, { jsonrpc: "2.0", method: "ping", id: NaN }, { jsonrpc: "2.0", method: "ping", id: {} }, { jsonrpc: "2.0", method: "ping", params: [] }, { jsonrpc: "2.0", method: "ping", params: { body: "a".repeat(32769) } }, { jsonrpc: "2.0", method: "ping", params: cycle }]) bridge.receive(value)
    expect(sent).toEqual([])
    bridge.receive({ jsonrpc: "2.0", id: 0, method: "ui/initialize", params: { protocolVersion: "bad" } })
    expect(sent.at(-1)?.error).toMatchObject({ code: -32000 })
    bridge.receive({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" })
    bridge.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "bad" } })
    expect(sent.at(-1)?.error).toMatchObject({ code: -32602 })
    for (let index = 0; index < 513; index++) bridge.receive({ jsonrpc: "2.0", id: index, method: "ping" })
    expect(sent.at(-1)?.method).toBe("ui/notifications/sandbox-close")
    const count = sent.length
    bridge.receive({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" })
    expect(sent).toHaveLength(count)
    expect(mcpAppSandboxUrl("https://dac.example/base?token=never")).toBe("https://dac.example/ui/mcp-app-sandbox")
    expect(() => mcpAppSandboxUrl("https://user:secret@dac.example")).toThrow()
  })
})
