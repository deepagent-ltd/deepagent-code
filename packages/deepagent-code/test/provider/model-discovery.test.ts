import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { discoverProviderModels, discoverWithProtocol, isChatModel, normalizeBaseURL } from "@/provider/model-discovery"

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

describe("discoverProviderModels (real fetch)", () => {
  let server: ReturnType<typeof Bun.serve> | undefined
  let baseURL = ""

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        // A responsive /models endpoint that answers well under the discovery timeout.
        if (url.pathname.endsWith("/models")) {
          await Bun.sleep(50)
          return Response.json({ data: [{ id: "model-a", display_name: "Model A" }] })
        }
        return new Response("not found", { status: 404 })
      },
    })
    baseURL = `http://localhost:${server.port}/v1`
  })

  afterAll(() => server?.stop(true))

  test("returns models from a responsive endpoint", async () => {
    const models = await discoverProviderModels({ baseURL, apiKey: "k", providerID: "relay" })
    expect(models).toEqual([{ id: "model-a", name: "Model A" }])
  })

  test("rejects (does not hang) when the host is unreachable", async () => {
    // Port 1 is a reserved port nothing listens on → connection refused resolves fast, proving the
    // call surfaces an error instead of blocking the caller forever.
    await expect(
      discoverProviderModels({ baseURL: "http://127.0.0.1:1/v1", apiKey: "k", providerID: "dead" }),
    ).rejects.toBeDefined()
  })
})
