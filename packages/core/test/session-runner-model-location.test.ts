import fs from "fs/promises"
import { mkdtempSync, rmSync } from "node:fs"
import os from "os"
import path from "path"
import { afterAll, beforeAll, describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Ref } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LLM } from "@deepagent-code/llm"
import { LLMClient, RequestExecutor } from "@deepagent-code/llm/route"
import { Catalog } from "@deepagent-code/core/catalog"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { ModelV2 } from "@deepagent-code/core/model"
import { PluginBoot } from "@deepagent-code/core/plugin/boot"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { Auth } from "../src/auth"
import { EventV2 } from "../src/event"
import { Flag } from "../src/flag/flag"
import { FSUtil } from "../src/fs-util"
import { Global } from "../src/global"
import { ModelsDev } from "../src/models-dev"
import { Npm } from "../src/npm"
import { Project } from "../src/project"
import { ApplicationTools } from "../src/tool/application-tools"

// RI-22 vertical oracle: a production Location (LocationServiceMap) boots the real
// Config.locationLayer -> PluginBoot -> ConfigProviderPlugin -> V2 Catalog ->
// SessionRunnerModel chain from an on-disk config file, and the resolved model lowers
// into a concrete runner request with no V1 fallback anywhere in the chain.
const it = testEffect(
  Layer.merge(
    ApplicationTools.layer,
    LocationServiceMap.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Project.defaultLayer,
          EventV2.defaultLayer,
          Auth.defaultLayer,
          Npm.defaultLayer,
          ModelsDev.defaultLayer,
          FSUtil.defaultLayer,
          Global.defaultLayer,
        ),
      ),
    ),
  ),
)

// Same isolation as location-layer.test.ts: the models.dev fetch holds a cross-process
// Flock, so disable it — the catalog then contains only the vendored first-party
// `deepagent` seed plus what the Location config file defines. The Global roots are
// isolated so a developer's real ~/.deepagent config cannot leak into the Location.
const ORIGINAL_DISABLE_FETCH = Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH
const ORIGINAL_DATABASE = Flag.DEEPAGENT_CODE_DB
const ORIGINAL_TEST_HOME = process.env.DEEPAGENT_CODE_TEST_HOME
const testHome = mkdtempSync(path.join(os.tmpdir(), "runner-model-location-home-"))
beforeAll(() => {
  Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = true
  Flag.DEEPAGENT_CODE_DB = ":memory:"
  process.env.DEEPAGENT_CODE_TEST_HOME = testHome
})
afterAll(() => {
  Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = ORIGINAL_DISABLE_FETCH
  Flag.DEEPAGENT_CODE_DB = ORIGINAL_DATABASE
  if (ORIGINAL_TEST_HOME === undefined) delete process.env.DEEPAGENT_CODE_TEST_HOME
  if (ORIGINAL_TEST_HOME !== undefined) process.env.DEEPAGENT_CODE_TEST_HOME = ORIGINAL_TEST_HOME
  rmSync(testHome, { recursive: true, force: true })
})

const session = (directory: string, model?: SessionV2.Info["model"]) =>
  SessionV2.Info.make({
    id: SessionV2.ID.make("ses_ri22_vertical"),
    projectID: ProjectV2.ID.global,
    title: "test",
    permissions: [],
    model,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: AbsolutePath.make(directory) },
  })

const sse = (...chunks: ReadonlyArray<unknown>) =>
  `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`

describe("SessionRunnerModel production Location vertical", () => {
  it.live(
    "resolves a config-defined custom provider into the exact V2 runner request",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              fs.writeFile(
                path.join(tmp.path, "deepagent-code.json"),
                JSON.stringify({
                  model: "acme/acme-chat-large",
                  providers: {
                    acme: {
                      name: "Acme",
                      env: ["ACME_RI22_API_KEY"],
                      api: {
                        type: "aisdk",
                        package: "@ai-sdk/openai-compatible",
                        url: "https://acme.example/v1",
                        protocol: "openai-compatible.responses",
                      },
                      request: {
                        headers: { "x-acme-provider": "on" },
                        body: { acme_provider_extension: { trace: true } },
                      },
                      models: {
                        "acme-chat-large": {
                          name: "Acme Chat Large",
                          api: { id: "acme-chat-large-2026" },
                          capabilities: { tools: true, input: ["text"], output: ["text"] },
                          limit: { context: 128000, input: 100000, output: 8192 },
                          request: {
                            headers: { "x-acme-model": "large" },
                            body: {
                              apiKey: "config-secret",
                              temperature: 0.3,
                              reasoningEffort: "high",
                              acme_extension: { enabled: true },
                            },
                          },
                        },
                      },
                    },
                  },
                }),
              ),
            )

            const resolved = yield* Effect.gen(function* () {
              yield* PluginBoot.Service.use((boot) => boot.wait())
              const catalog = yield* Catalog.Service
              // The models.dev fetch is disabled; the only catalog entries are the vendored
              // first-party `deepagent` seed (models-dev OFFICIAL_VENDORED_CATALOG) and the
              // provider this Location's config file defined.
              const providers = yield* catalog.provider.all()
              expect(providers.map((provider) => provider.id)).toEqual([
                ProviderV2.ID.make("deepagent"),
                ProviderV2.ID.make("acme"),
              ])
              // No session model: the config `model` scalar selects the default.
              return yield* SessionRunnerModel.Service.use((service) => service.resolve(session(tmp.path)))
            }).pipe(
              Effect.scoped,
              Effect.provide(LocationServiceMap.get({ directory: AbsolutePath.make(tmp.path) })),
            )

            expect(resolved.info?.providerID).toBe(ProviderV2.ID.make("acme"))
            expect(resolved.info?.id).toBe(ModelV2.ID.make("acme-chat-large"))
            // `enabled` via "custom" is ConfigProviderPlugin's marker: the catalog entry was
            // written from Core config, not from models.dev or any V1 provider path.
            expect(resolved.provider?.enabled).toEqual({ via: "custom", data: {} })
            expect(resolved.provider?.api).toMatchObject({
              package: "@ai-sdk/openai-compatible",
              url: "https://acme.example/v1",
              protocol: "openai-compatible.responses",
            })
            expect(resolved.model).toMatchObject({ id: "acme-chat-large-2026", provider: "acme" })
            // Source classification alone would route @ai-sdk/openai-compatible to Chat; the
            // Responses route proves the config's explicit protocol drove the lowering.
            expect(resolved.model.route).toMatchObject({
              id: "openai-compatible-responses",
              endpoint: { baseURL: "https://acme.example/v1" },
              defaults: {
                headers: { "x-acme-provider": "on", "x-acme-model": "large" },
                generation: { temperature: 0.3 },
                providerOptions: { openai: { reasoningEffort: "high" } },
                http: { body: { acme_extension: { enabled: true }, acme_provider_extension: { trace: true } } },
                limits: { context: 128000, input: 100000, output: 8192 },
              },
            })
            expect(JSON.stringify(resolved.model.route.defaults.http?.body)).not.toContain("apiKey")

            const wire = yield* Ref.make<{ url: string; headers: Record<string, string>; text: string } | undefined>(
              undefined,
            )
            const request = LLM.request({ model: resolved.model, prompt: "Hello" })
            // Capture the exact request the runner's executor would put on the wire.
            const executor = Layer.succeed(
              RequestExecutor.Service,
              RequestExecutor.Service.of({
                execute: (outgoing) =>
                  Effect.gen(function* () {
                    const web = yield* HttpClientRequest.toWeb(outgoing).pipe(Effect.orDie)
                    const text = yield* Effect.promise(() => web.text())
                    yield* Ref.set(wire, { url: web.url, headers: outgoing.headers, text })
                    return HttpClientResponse.fromWeb(
                      outgoing,
                      new Response(
                        sse(
                          { type: "response.output_text.delta", item_id: "msg_1", delta: "ok" },
                          {
                            type: "response.completed",
                            response: { id: "resp_1", usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } },
                          },
                        ),
                        { headers: { "content-type": "text/event-stream" } },
                      ),
                    )
                  }),
              }),
            )
            const client = LLMClient.layer.pipe(Layer.provide(executor))
            const prepared = yield* LLMClient.prepare(request).pipe(Effect.provide(client))
            const response = yield* LLMClient.generate(request).pipe(Effect.provide(client))

            expect(prepared.route).toBe("openai-compatible-responses")
            expect(prepared.protocol).toBe("openai-responses")
            expect(prepared.body).toMatchObject({
              model: "acme-chat-large-2026",
              temperature: 0.3,
              reasoning: { effort: "high" },
            })

            const sent = yield* Ref.get(wire)
            expect(sent?.url).toBe("https://acme.example/v1/responses")
            expect(sent?.headers["authorization"]).toBe("Bearer config-secret")
            expect(sent?.headers["x-acme-provider"]).toBe("on")
            expect(sent?.headers["x-acme-model"]).toBe("large")
            expect(JSON.parse(sent?.text ?? "{}")).toMatchObject({
              model: "acme-chat-large-2026",
              stream: true,
              temperature: 0.3,
              reasoning: { effort: "high" },
              acme_extension: { enabled: true },
              acme_provider_extension: { trace: true },
            })
            expect(sent?.text).not.toContain("apiKey")
            expect(sent?.text).not.toContain("config-secret")
            expect(response.text).toBe("ok")
          }),
        ),
      ),
    20000,
  )

  it.live(
    "fails closed when a config-defined custom provider has no resolvable protocol",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              fs.writeFile(
                path.join(tmp.path, "deepagent-code.json"),
                JSON.stringify({
                  providers: {
                    acme: {
                      api: { type: "aisdk", package: "acme-private-sdk", url: "https://acme.example/v1" },
                      models: { "acme-chat": {} },
                    },
                  },
                }),
              ),
            )

            const failure = yield* Effect.gen(function* () {
              yield* PluginBoot.Service.use((boot) => boot.wait())
              return yield* SessionRunnerModel.Service.use((service) =>
                service.resolve(
                  session(tmp.path, {
                    id: ModelV2.ID.make("acme-chat"),
                    providerID: ProviderV2.ID.make("acme"),
                  }),
                ),
              ).pipe(Effect.flip)
            }).pipe(
              Effect.scoped,
              Effect.provide(LocationServiceMap.get({ directory: AbsolutePath.make(tmp.path) })),
            )

            // An unknown source with no explicit protocol is a typed error end-to-end —
            // never a silent fallback to a guessed Chat route or a V1 resolver.
            expect(failure).toMatchObject({
              _tag: "SessionRunnerModel.ModelProtocolDisabledError",
              providerID: "acme",
              modelID: "acme-chat",
              reason: "model_protocol_selection_required",
              selectionState: "disabled",
            })
          }),
        ),
      ),
    20000,
  )
})
