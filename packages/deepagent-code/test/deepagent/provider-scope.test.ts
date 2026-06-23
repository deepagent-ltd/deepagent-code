import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

describe("DeepAgent global runtime scope", () => {
  test("session LLM passes upstream provider metadata through gateway without changing provider execution", async () => {
    const source = await readFile("src/session/llm.ts", "utf8")

    expect(source).toContain("AgentGateway.manageStream")
    expect(source).toContain("AgentGateway.preflight")
    expect(source.indexOf("AgentGateway.preflight")).toBeLessThan(source.indexOf("streamText({"))
    expect(source.indexOf("configureGateway(cfg)")).toBeLessThan(source.indexOf("AgentGateway.preflight"))
    expect(source).toContain("providerID: input.model.providerID")
    expect(source).toContain("messageID: input.user.id")
    expect(source).not.toContain("ONE" + "AGENT")
  })

  test("DeepAgent provider runtime is fenced to supported upstream providers", async () => {
    const providerSource = await readFile("src/provider/provider.ts", "utf8")
    const transformSource = await readFile("src/provider/transform.ts", "utf8")

    expect(providerSource).toContain("SUPPORTED_DEEPAGENT_PROVIDER_PACKAGES")
    expect(providerSource).toContain("COMPATIBILITY_PROVIDER_LOADERS")
    expect(providerSource).toContain("Unsupported DeepAgent upstream provider")
    expect(transformSource).toContain("Unsupported DeepAgent upstream provider")
    expect(transformSource).toContain('"@ai-sdk/openai-compatible"')
    expect(transformSource).not.toContain('input.model.providerID === "deepagent" && input.model.api.npm === "@ai-sdk/google"')
  })
})
