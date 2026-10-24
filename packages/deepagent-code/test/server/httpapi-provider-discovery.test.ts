import { afterAll, beforeAll, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Global } from "@deepagent-code/core/global"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"
import path from "node:path"

const calls: { method: string; path: string; key: string | null }[] = []
let endpoint: ReturnType<typeof Bun.serve>
beforeAll(async () => {
  endpoint = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      calls.push({
        method: request.method,
        path: new URL(request.url).pathname,
        key: request.headers.get("authorization"),
      })
      return Response.json({ data: [{ id: "fixture-chat", name: "Fixture Chat" }] })
    },
  })
  // The package preload redirects Global.Path.config into this process's isolated test root.
  await Bun.write(
    path.join(Global.Path.config, "auth.json"),
    JSON.stringify({
      "saved-discovery": { type: "api", key: "stored-discovery-fixture" },
      "oauth-discovery": { type: "oauth", access: "not-an-api-key", refresh: "fixture-only", expires: 1 },
    }),
  )
})
afterAll(() => endpoint?.stop(true))

const it = testEffect(Layer.mergeAll(FSUtil.defaultLayer, httpApiLayer))
const configuration = () => ({
  formatter: false as const,
  lsp: false as const,
  provider: {
    "saved-discovery": { npm: "@ai-sdk/openai-compatible", options: { baseURL: `${endpoint.url}v1` } },
    "oauth-discovery": { npm: "@ai-sdk/openai-compatible", options: { baseURL: `${endpoint.url}v1` } },
  },
})

it.instance(
  "a requested model absent from the remote list is not synthesized into a verified selection",
  Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const response = yield* requestInDirectory("/provider/models/discover", directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerID: "temporary-discovery",
        baseURL: `${endpoint.url}v1`,
        apiKey: "temporary-fixture",
        kind: "openai-compatible",
        modelID: "not-returned-by-provider",
      }),
    })
    expect(response.status).toBe(400)
    expect(yield* response.text).toContain("requested model was not returned")
  }),
  { config: configuration },
  30_000,
)

it.instance(
  "temporary model discovery lists remotely without saving its key or changing configuration",
  Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const authBefore = yield* Effect.promise(() => Bun.file(path.join(Global.Path.config, "auth.json")).text())
    const configBefore = yield* Effect.promise(() => Bun.file(path.join(directory, "deepagent-code.json")).text())
    const start = calls.length
    const response = yield* requestInDirectory("/provider/models/discover", directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerID: "temporary-discovery",
        baseURL: `${endpoint.url}v1`,
        apiKey: "temporary-fixture",
        kind: "openai-compatible",
      }),
    })
    expect(response.status).toBe(200)
    expect(yield* response.json).toMatchObject({
      kind: "openai-compatible",
      models: [{ id: "fixture-chat" }],
      selected: { id: "fixture-chat" },
    })
    expect(calls.slice(start)).toEqual([{ method: "GET", path: "/v1/models", key: "Bearer temporary-fixture" }])
    expect(yield* Effect.promise(() => Bun.file(path.join(Global.Path.config, "auth.json")).text())).toBe(authBefore)
    expect(yield* Effect.promise(() => Bun.file(path.join(directory, "deepagent-code.json")).text())).toBe(configBefore)
  }),
  { config: configuration },
  30_000,
)

it.instance(
  "stored discovery credentials stay bound to the same provider and its saved endpoint",
  Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const start = calls.length
    const accepted = yield* requestInDirectory("/provider/models/discover", directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerID: "saved-discovery",
        baseURL: `${endpoint.url}v1`,
        authProviderID: "saved-discovery",
        kind: "openai-compatible",
      }),
    })
    expect(accepted.status).toBe(200)
    yield* accepted.text
    expect(calls.slice(start)).toEqual([{ method: "GET", path: "/v1/models", key: "Bearer stored-discovery-fixture" }])
    const noMore = calls.length
    for (const payload of [
      { providerID: "saved-discovery", baseURL: `${endpoint.url}other` },
      { providerID: "different-discovery", baseURL: `${endpoint.url}v1`, authProviderID: "saved-discovery" },
      { providerID: "openai", baseURL: `${endpoint.url}v1`, apiKey: "inline-fixture" },
      { providerID: "saved-discovery", baseURL: "file:///etc/passwd", apiKey: "inline-fixture" },
      { providerID: "saved-discovery", baseURL: "https://name:secret@example.com/v1", apiKey: "inline-fixture" },
    ]) {
      const rejected = yield* requestInDirectory("/provider/models/discover", directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      expect(rejected.status).toBe(400)
      expect(yield* rejected.text).not.toContain("stored-discovery-fixture")
    }
    expect(calls.length).toBe(noMore)
  }),
  { config: configuration },
  30_000,
)

it.instance(
  "stored subscription OAuth is not sent as an API key or called a verified model list",
  Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const start = calls.length
    const response = yield* requestInDirectory("/provider/models/discover", directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerID: "oauth-discovery", baseURL: `${endpoint.url}v1`, kind: "openai-compatible" }),
    })
    expect(response.status).toBe(400)
    expect(yield* response.text).toContain("Missing provider API key")
    expect(calls.length).toBe(start)
  }),
  { config: configuration },
  30_000,
)
