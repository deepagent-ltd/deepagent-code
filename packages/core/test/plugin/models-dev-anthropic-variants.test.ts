import { describe, expect } from "bun:test"
import { LLM, LLMClient } from "@deepagent-code/llm"
import { DateTime, Effect } from "effect"
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

describe("ModelsDevPlugin current adaptive Claude variants", () => {
  for (const id of [
    "claude-sonnet-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-mythos-preview",
    "claude-mythos-5",
    "claude-mythos-5-1",
  ]) {
    it.effect(`prepares ${id} high efforts with the native adaptive contract`, () =>
      Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        const catalog = yield* Catalog.Service
        const events = yield* EventV2.Service
        const data: ModelsDev.Provider = {
          id: "anthropic",
          name: "Anthropic",
          npm: "@ai-sdk/anthropic",
          api: "https://api.anthropic.com/v1",
          env: ["ANTHROPIC_API_KEY"],
          models: {
            [id]: {
              id,
              name: id,
              release_date: "2026-09-28",
              reasoning: true,
              temperature: false,
              attachment: true,
              tool_call: true,
              limit: { context: 1_000_000, output: 128_000 },
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          },
        }
        yield* plugin.add({
          ...ModelsDevPlugin,
          effect: ModelsDevPlugin.effect.pipe(
            Effect.provideService(Catalog.Service, catalog),
            Effect.provideService(EventV2.Service, events),
            Effect.provideService(
              ModelsDev.Service,
              ModelsDev.Service.of({ get: () => Effect.succeed({ anthropic: data }), refresh: () => Effect.void }),
            ),
          ),
        })
        const model = yield* catalog.model.get(ProviderV2.ID.make("anthropic"), ModelV2.ID.make(id))
        expect(model.variants.map((variant) => String(variant.id))).toEqual(["low", "medium", "high", "xhigh", "max"])
        for (const effort of ["high", "xhigh", "max"]) {
          const session = SessionV2.Info.make({
            id: SessionV2.ID.make("ses_adaptive_claude"),
            projectID: ProjectV2.ID.global,
            title: "adaptive Claude",
            permissions: [],
            model: { id: model.id, providerID: model.providerID, variant: ModelV2.VariantID.make(effort) },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
            location: { directory: AbsolutePath.make("/adaptive-claude-test") },
          })
          const resolved = yield* SessionRunnerModel.resolve(session, model)
          const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello", cache: "none" }))
          expect(prepared.body).toMatchObject({
            model: id,
            max_tokens: 128_000,
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort },
          })
          expect(prepared.body).not.toHaveProperty("effort")
          expect(prepared.body).not.toHaveProperty("thinking.budget_tokens")
        }
      }),
    )
  }
})
