import { expect, test } from "bun:test"
import { McpOperatorClient } from "../../src/mcp/operator-client"

test("private MCP requests reject scope minting, generic actions and excess callback fields", () => {
  const command = { ticket: "a".repeat(64), action: "connect" as const }
  expect(McpOperatorClient.decode(McpOperatorClient.Command, command)).toEqual(command)
  for (const extra of [{ directory: "/" }, { operator: "local" }, { headers: {} }, { action: "fetch" }])
    expect(() => McpOperatorClient.decode(McpOperatorClient.Command, { ...command, ...extra })).toThrow()
  expect(() =>
    McpOperatorClient.decode(McpOperatorClient.Command, {
      ...command,
      action: "finishAuth",
      callback: { code: "code", oauthState: "state", token: "forged" },
    }),
  ).toThrow()
})
