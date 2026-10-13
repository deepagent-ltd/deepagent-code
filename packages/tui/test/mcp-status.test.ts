import { expect, test } from "bun:test"
import { mcpConnectionBlocked, mcpConnectionMessage } from "../src/util/mcp-status"
import { pluginTranslator } from "../src/i18n/standalone"

test("plugin and TUI cold display preserves verified identity without reporting enabled", () => {
  const status = { status: "disconnected", authStatus: "authenticated", reason: "explicit_connect_required" } as const
  const key = mcpConnectionMessage(status)
  const zh = pluginTranslator({ get: () => "zh" })
  expect(mcpConnectionBlocked(status)).toBe(false)
  expect(key).toBe("tui.mcp.connection.authenticated")
  expect(zh("tui.mcp.status.disconnected")).toBe("未连接")
  expect(zh(key!)).toBe("凭据已验证，点击连接。")
})

test("current and previous plugin metadata generations retain the unknown recovery barrier", () => {
  const unknown = { status: "disconnected", authStatus: "unknown", reason: "unknown_outcome" } as const
  expect(mcpConnectionBlocked(unknown)).toBe(true)
  expect(mcpConnectionBlocked({ status: "disconnected" })).toBe(true)
  const key = mcpConnectionMessage(unknown)
  const zht = pluginTranslator({ get: () => "zht" })
  expect(key).toBe("tui.mcp.connection.unknown_outcome")
  expect(zht(key!)).toBe("認證結果未能確認，請先重新整理並核對狀態。")
})
