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

  test("DeepAgent hosted provider is fenced at registration time, third-party providers are unrestricted", async () => {
    const providerSource = await readFile("src/provider/provider.ts", "utf8")
    const transformSource = await readFile("src/provider/transform.ts", "utf8")

    // The hosted "deepagent" gateway still self-restricts to vetted upstream providers/packages,
    // but this is now enforced once at catalog-load time (out-of-policy models are dropped) rather
    // than thrown per-request. The whitelist constant and the registration-time guard remain.
    expect(providerSource).toContain("SUPPORTED_DEEPAGENT_PROVIDER_PACKAGES")
    expect(providerSource).toContain("COMPATIBILITY_PROVIDER_LOADERS")
    expect(providerSource).toContain('providerID === "deepagent"')
    expect(providerSource).toContain("dropping unsupported deepagent upstream model")

    // Parity with upstream deepagent-code: third-party providers are NOT gated. The per-request throws that
    // previously rejected non-whitelisted upstreams/packages have been removed from both files.
    expect(providerSource).not.toContain("Unsupported DeepAgent upstream provider")
    expect(transformSource).not.toContain("Unsupported DeepAgent upstream provider")
    expect(transformSource).toContain('"@ai-sdk/openai-compatible"')
  })
})
