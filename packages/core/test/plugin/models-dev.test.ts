import { describe, expect } from "bun:test"
import { LLM } from "@deepagent-code/llm"
import { LLMClient, RequestExecutor } from "@deepagent-code/llm/route"
import { DateTime, Effect, Layer, Ref } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Catalog } from "@deepagent-code/core/catalog"
import { EventV2 } from "@deepagent-code/core/event"
import { ModelV2 } from "@deepagent-code/core/model"
import { ModelsDev } from "@deepagent-code/core/models-dev"
import { PluginV2 } from "@deepagent-code/core/plugin"
import { ModelsDevPlugin } from "@deepagent-code/core/plugin/models-dev"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { it } from "./provider-helper"

const fixture: ModelsDev.Provider = {
  id: "deepseek",
  name: "DeepSeek",
  env: ["DEEPSEEK_API_KEY"],
  npm: "@ai-sdk/openai-compatible",
  api: "https://api.deepseek.com",
  models: {
    "deepseek-flash": {
      id: "deepseek-flash",
      name: "DeepSeek V4.1 Flash 1017",
      release_date: "2026-10-17",
      attachment: true,
      reasoning: true,
      temperature: false,
      tool_call: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: 1048576, output: 393216 },
    },
  },
}

const load = (data: ModelsDev.Provider) =>
  Effect.gen(function* () {
    const plugin = yield* PluginV2.Service
    const catalog = yield* Catalog.Service
    const events = yield* EventV2.Service
    yield* plugin.add({
      ...ModelsDevPlugin,
      effect: ModelsDevPlugin.effect.pipe(
        Effect.provideService(Catalog.Service, catalog),
        Effect.provideService(EventV2.Service, events),
        Effect.provideService(
          ModelsDev.Service,
          ModelsDev.Service.of({ get: () => Effect.succeed({ [data.id]: data }), refresh: () => Effect.void }),
        ),
      ),
    })
    return yield* catalog.model.get(ProviderV2.ID.make(data.id), ModelV2.ID.make(Object.keys(data.models)[0]))
  })

const selected = (model: ModelV2.Info, variant: string) =>
  SessionV2.Info.make({
    id: SessionV2.ID.make("ses_catalog_variant"),
    projectID: ProjectV2.ID.global,
    title: "catalog variant",
    permissions: [],
    model: { id: model.id, providerID: model.providerID, variant: ModelV2.VariantID.make(variant) },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: AbsolutePath.make("/catalog-variant-test") },
  })

describe("ModelsDevPlugin runtime variants", () => {
  for (const effort of ["none", "low", "high", "max"]) {
    it.effect(`lowers the official DeepSeek Flash ${effort} selection into the actual provider body`, () =>
      Effect.gen(function* () {
        const model = yield* load(fixture)
        expect(model.variants.map((variant) => String(variant.id))).toEqual(["none", "low", "high", "max"])
        const resolved = yield* SessionRunnerModel.resolve(selected(model, effort), model)
        const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))
        expect(prepared.body).toMatchObject({ model: "deepseek-flash", reasoning_effort: effort })
        expect(prepared.body).not.toHaveProperty("reasoningEffort")
        const sent = yield* Ref.make<unknown>(undefined)
        yield* LLMClient.generate(LLM.request({ model: resolved, prompt: "Hello" })).pipe(
          Effect.provide(
            LLMClient.layer.pipe(
              Layer.provide(
                Layer.succeed(
                  RequestExecutor.Service,
                  RequestExecutor.Service.of({
                    execute: (outgoing) =>
                      Effect.gen(function* () {
                        const web = yield* HttpClientRequest.toWeb(outgoing).pipe(Effect.orDie)
                        yield* Ref.set(sent, yield* Effect.promise(() => web.json()))
                        return HttpClientResponse.fromWeb(
                          outgoing,
                          new Response(
                            'data: {"id":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                            { headers: { "content-type": "text/event-stream" } },
                          ),
                        )
                      }),
                  }),
                ),
              ),
            ),
          ),
        )
        expect(yield* Ref.get(sent)).toMatchObject({
          model: "deepseek-flash",
          reasoning_effort: effort,
          thinking: { type: effort === "none" ? "disabled" : "enabled" },
        })
      }),
    )
  }

  it.effect("keeps explicit catalog mode settings over generated defaults", () =>
    Effect.gen(function* () {
      const model = yield* load({
        ...fixture,
        models: {
          "deepseek-flash": {
            ...fixture.models["deepseek-flash"],
            experimental: {
              modes: { high: { provider: { headers: { "x-mode": "explicit" }, body: { reasoning_effort: "low" } } } },
            },
          },
        },
      })
      const resolved = yield* SessionRunnerModel.resolve(selected(model, "high"), model)
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))
      expect(resolved.route.defaults.headers).toMatchObject({ "x-mode": "explicit" })
      expect(prepared.body).toMatchObject({ reasoning_effort: "low" })
    }),
  )

  it.effect("does not mix generated effort into an explicit mode that disables thinking", () =>
    Effect.gen(function* () {
      const model = yield* load({
        ...fixture,
        models: {
          "deepseek-flash": {
            ...fixture.models["deepseek-flash"],
            experimental: { modes: { high: { provider: { body: { thinking: { type: "disabled" } } } } } },
          },
        },
      })
      const resolved = yield* SessionRunnerModel.resolve(selected(model, "high"), model)
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))
      expect(prepared.body).not.toHaveProperty("reasoning_effort", "high")
      expect(prepared.body).toMatchObject({ thinking: { type: "disabled" } })
    }),
  )

  it.effect("lowers generated OpenAI effort options without models.dev modes", () =>
    Effect.gen(function* () {
      const model = yield* load({
        ...fixture,
        id: "openai",
        npm: "@ai-sdk/openai",
        api: "https://api.openai.com/v1",
        models: { "gpt-5.4": { ...fixture.models["deepseek-flash"], id: "gpt-5.4", name: "GPT-5.4" } },
      })
      const resolved = yield* SessionRunnerModel.resolve(selected(model, "xhigh"), model)
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))
      expect(prepared.body).toMatchObject({
        model: "gpt-5.4",
        reasoning: { effort: "xhigh", summary: "auto" },
        include: ["reasoning.encrypted_content"],
      })
    }),
  )

  it.effect("lowers generated Anthropic adaptive thinking and effort without models.dev modes", () =>
    Effect.gen(function* () {
      const model = yield* load({
        ...fixture,
        id: "anthropic",
        npm: "@ai-sdk/anthropic",
        api: "https://api.anthropic.com/v1",
        models: {
          "claude-opus-4-7": { ...fixture.models["deepseek-flash"], id: "claude-opus-4-7", name: "Claude Opus 4.7" },
        },
      })
      const resolved = yield* SessionRunnerModel.resolve(selected(model, "high"), model)
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))
      expect(prepared.body).toMatchObject({
        model: "claude-opus-4-7",
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
      })
    }),
  )
})
