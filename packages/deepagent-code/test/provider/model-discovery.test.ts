import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { discoverProviderModels, isChatModel, normalizeBaseURL } from "@/provider/model-discovery"

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
