import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

describe("DeepAgent direct helper guard", () => {
  test("wraps agent generation helper and does not enable DeepAgent by default", async () => {
    const source = await readFile("src/agent/agent.ts", "utf8")

    expect(source).toContain("AgentGateway.runAuxiliary")
    expect(source).toContain("configureGateway(cfg)")
    expect(source).toContain('providerID: model.providerID')
    expect(source).toContain('feature: "agent_generate"')
    expect(source).not.toContain("ONE" + "AGENT")
  })
})
