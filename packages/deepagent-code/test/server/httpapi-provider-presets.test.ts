import { afterAll, beforeAll, expect } from "bun:test"
import { Flag } from "@deepagent-code/core/flag/flag"
import { PROVIDER_PRESETS } from "@deepagent-code/core/provider-presets"
import { Effect, Layer } from "effect"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, request } from "./httpapi-layer"
import os from "node:os"
import path from "node:path"

const original = { path: Flag.DEEPAGENT_CODE_MODELS_PATH, disabled: Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH }
beforeAll(() => {
  Flag.DEEPAGENT_CODE_MODELS_PATH = path.join(os.tmpdir(), `dac-missing-presets-${crypto.randomUUID()}.json`)
  Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = true
})
afterAll(() => {
  Flag.DEEPAGENT_CODE_MODELS_PATH = original.path
  Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = original.disabled
})

const it = testEffect(Layer.mergeAll(FSUtil.defaultLayer, httpApiLayer))

it.instance(
  "offline normal provider HTTP projection retains ten brands without inventing connected accounts",
  Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const response = yield* request("/provider", { headers: { "x-deepagent-code-directory": directory } })
    expect(response.status).toBe(200)
    const body = (yield* response.json) as {
      all: { id: string; models: Record<string, unknown> }[]
      connected: string[]
    }
    for (const preset of PROVIDER_PRESETS) expect(body.all.some((item) => item.id === preset.id)).toBe(true)
    expect(body.all.find((item) => item.id === "openai")?.models).toEqual({})
    expect(body.connected).not.toContain("openai")
    expect(body.connected).not.toContain("alibaba-cn")
  }),
  { config: { formatter: false, lsp: false } },
  30_000,
)

it.instance(
  "offline provider HTTP projection honors explicit allowlist and disabled entries while preserving custom config",
  Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const response = yield* request("/provider", { headers: { "x-deepagent-code-directory": directory } })
    expect(response.status).toBe(200)
    const body = (yield* response.json) as { all: { id: string }[]; connected: string[] }
    expect(body.all.map((item) => item.id)).toEqual(["own-gateway"])
    expect(body.connected).toEqual(["own-gateway"])
  }),
  {
    config: {
      formatter: false,
      lsp: false,
      enabled_providers: ["own-gateway", "openai"],
      disabled_providers: ["openai"],
      provider: {
        "own-gateway": {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://fixture.invalid/v1", apiKey: "unused-fixture-key" },
          models: { "own-model": { name: "Own model", limit: { context: 128_000, output: 8192 } } },
        },
      },
    },
  },
  30_000,
)
