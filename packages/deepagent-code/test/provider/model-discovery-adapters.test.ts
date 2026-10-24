import { expect, test } from "bun:test"
import {
  discoverProviderModels,
  discoverWithProtocol,
  discoveryKind,
  normalizeBaseURL,
} from "@/provider/model-discovery"

test("runtime and refresh discovery preserve the selected SDK protocol", () => {
  expect(discoveryKind("@ai-sdk/google")).toBe("google")
  expect(discoveryKind("@ai-sdk/anthropic")).toBe("anthropic")
  expect(discoveryKind("@ai-sdk/openai-compatible")).toBe("openai-compatible")
})

test("Google discovery uses its native key header, paginated names and generateContent capability", async () => {
  const calls: { path: string; key: string | null; bearer: string | null }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url)
      calls.push({
        path: url.pathname + url.search,
        key: request.headers.get("x-goog-api-key"),
        bearer: request.headers.get("authorization"),
      })
      if (url.searchParams.get("pageToken") === "next")
        return Response.json({
          models: [
            { name: "models/gemini-next", displayName: "Gemini Next", supportedGenerationMethods: ["generateContent"] },
          ],
        })
      return Response.json({
        models: [
          { name: "models/gemini-first", displayName: "Gemini First", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
        ],
        nextPageToken: "next",
      })
    },
  })
  try {
    const result = await discoverWithProtocol({
      providerID: "google",
      baseURL: `${server.url}v1beta`,
      apiKey: "fixture-only",
      kind: "google",
    })
    expect(result).toEqual({
      kind: "google",
      models: [
        { id: "gemini-first", name: "Gemini First" },
        { id: "gemini-next", name: "Gemini Next" },
      ],
    })
    expect(calls).toEqual([
      { path: "/v1beta/models", key: "fixture-only", bearer: null },
      { path: "/v1beta/models?pageToken=next", key: "fixture-only", bearer: null },
    ])
  } finally {
    server.stop(true)
  }
})

test("Anthropic discovery retains native headers and follows its model page cursor", async () => {
  const calls: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url)
      calls.push(url.pathname + url.search)
      expect(request.headers.get("x-api-key")).toBe("fixture-only")
      expect(request.headers.get("anthropic-version")).toBe("2023-06-01")
      return Response.json(
        url.searchParams.has("after_id")
          ? { data: [{ id: "claude-second" }], has_more: false }
          : { data: [{ id: "claude-first" }], has_more: true, last_id: "claude-first" },
      )
    },
  })
  try {
    expect(
      await discoverProviderModels({
        providerID: "anthropic",
        baseURL: `${server.url}v1`,
        apiKey: "fixture-only",
        kind: "anthropic",
      }),
    ).toHaveLength(2)
    expect(calls).toEqual(["/v1/models", "/v1/models?after_id=claude-first"])
  } finally {
    server.stop(true)
  }
})

test("model discovery never forwards credentials to a redirect destination", async () => {
  const forwarded = { count: 0 }
  const target = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      forwarded.count++
      return Response.json({ data: [{ id: "unexpected" }] })
    },
  })
  const origin = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.redirect(`${target.url}models`) })
  try {
    await expect(
      discoverProviderModels({ providerID: "custom", baseURL: String(origin.url), apiKey: "fixture-only" }),
    ).rejects.toBeDefined()
    expect(forwarded.count).toBe(0)
  } finally {
    origin.stop(true)
    target.stop(true)
  }
})

test.each([
  {
    name: "unsupported shape",
    payload: { items: [{ id: "not-a-model-list" }] },
    kind: "openai-compatible" as const,
    error: "unsupported model list",
  },
  {
    name: "Google without generative models",
    payload: { models: [{ name: "models/embedding", supportedGenerationMethods: ["embedContent"] }] },
    kind: "google" as const,
    error: "No provider models",
  },
  {
    name: "oversized model list",
    payload: { data: [{ id: "x", name: "x".repeat(1024 * 1024) }] },
    kind: "openai-compatible" as const,
    error: "response size limit",
  },
])("discovery rejects $name without claiming catalog fallback success", async (input) => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json(input.payload) })
  try {
    await expect(
      discoverWithProtocol({
        providerID: "custom",
        baseURL: String(server.url),
        apiKey: "fixture-only",
        kind: input.kind,
      }),
    ).rejects.toThrow(input.error)
  } finally {
    server.stop(true)
  }
})

test("discovery rejects a repeated cursor instead of looping", async () => {
  const count = { value: 0 }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      count.value++
      return Response.json({ data: [{ id: "claude-first" }], has_more: true, last_id: "same" })
    },
  })
  try {
    await expect(
      discoverProviderModels({
        providerID: "anthropic",
        baseURL: String(server.url),
        apiKey: "fixture-only",
        kind: "anthropic",
      }),
    ).rejects.toThrow("repeated its page cursor")
    expect(count.value).toBe(2)
  } finally {
    server.stop(true)
  }
})

test("discovery URL normalization preserves explicit local HTTP but rejects userinfo and non-HTTP protocols", () => {
  expect(normalizeBaseURL("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080/v1")
  for (const url of ["file:///etc/passwd", "ftp://localhost/models", "https://user:secret@example.com/v1"])
    expect(() => normalizeBaseURL(url)).toThrow("HTTP(S) without embedded credentials")
})

test("invalid upstream JSON does not expose response text through the discovery error", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("<html>echoed-fixture-credential</html>"),
  })
  try {
    await expect(
      discoverProviderModels({ providerID: "custom", baseURL: String(server.url), apiKey: "fixture-only" }),
    ).rejects.toThrow("invalid JSON model list")
  } finally {
    server.stop(true)
  }
})
