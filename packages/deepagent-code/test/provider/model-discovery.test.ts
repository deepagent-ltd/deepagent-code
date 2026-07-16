import { describe, expect, test } from "bun:test"
import { discoverWithProtocol, isChatModel, normalizeBaseURL } from "@/provider/model-discovery"

describe("normalizeBaseURL", () => {
  test("strips query, hash and trailing slashes", () => {
    expect(normalizeBaseURL("https://api.example.com/v1/?x=1#frag")).toBe("https://api.example.com/v1")
  })
})

describe("isChatModel", () => {
  test("filters out non-chat model ids", () => {
    expect(isChatModel("gpt-4o")).toBe(true)
    expect(isChatModel("text-embedding-3-small")).toBe(false)
    expect(isChatModel("whisper-1")).toBe(false)
    expect(isChatModel("dall-e-3-image")).toBe(false)
  })
})

describe("discoverWithProtocol", () => {
  const input = { baseURL: "https://relay.example.com", apiKey: "k", providerID: "relay" }

  test("uses the explicit kind without probing others", async () => {
    const tried: string[] = []
    const result = await discoverWithProtocol({ ...input, kind: "anthropic" }, async (kind) => {
      tried.push(kind)
      return [{ id: "claude-x", name: "Claude X" }]
    })
    expect(tried).toEqual(["anthropic"])
    expect(result.kind).toBe("anthropic")
    expect(result.models).toHaveLength(1)
  })

  test("probes openai-compatible first when kind omitted", async () => {
    const tried: string[] = []
    const result = await discoverWithProtocol(input, async (kind) => {
      tried.push(kind)
      return [{ id: "m", name: "M" }]
    })
    expect(tried).toEqual(["openai-compatible"])
    expect(result.kind).toBe("openai-compatible")
  })

  test("falls back to anthropic when openai-compatible yields nothing", async () => {
    const tried: string[] = []
    const result = await discoverWithProtocol(input, async (kind) => {
      tried.push(kind)
      if (kind === "openai-compatible") return []
      return [{ id: "claude-x", name: "Claude X" }]
    })
    expect(tried).toEqual(["openai-compatible", "anthropic"])
    expect(result.kind).toBe("anthropic")
  })

  test("falls back to anthropic when openai-compatible throws", async () => {
    const result = await discoverWithProtocol(input, async (kind) => {
      if (kind === "openai-compatible") throw new Error("HTTP 404")
      return [{ id: "claude-x", name: "Claude X" }]
    })
    expect(result.kind).toBe("anthropic")
  })

  test("throws the last error when every protocol fails", async () => {
    await expect(
      discoverWithProtocol(input, async (kind) => {
        throw new Error(`fail-${kind}`)
      }),
    ).rejects.toThrow("fail-anthropic")
  })
})
