import fs from "node:fs/promises"
import path from "node:path"
import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { Config } from "@deepagent-code/core/config"
import { Catalog } from "@deepagent-code/core/catalog"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Global } from "@deepagent-code/core/global"
import { Flag } from "@deepagent-code/core/flag/flag"
import { Location } from "@deepagent-code/core/location"
import { LocationRuntimeHost, LocationServiceMap, defaultLocationRuntimeHost, locationServiceMapDependencies } from "@deepagent-code/core/location-layer"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { PluginBoot } from "@deepagent-code/core/plugin/boot"
import { Policy } from "@deepagent-code/core/policy"
import { Project } from "@deepagent-code/core/project"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { WorkExecutionProfile } from "@deepagent-code/core/session/work-execution-profile"
import { tmpdir } from "./fixture/tmpdir"

test("original Location map and PluginBoot consume the inherited parent service instead of reopening child config", async () => {
  await using tmp = await tmpdir()
  const saved = { home: process.env.DEEPAGENT_CODE_TEST_HOME, fetch: Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH,
    plugins: process.env.DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS }
  process.env.DEEPAGENT_CODE_TEST_HOME = tmp.path
  process.env.DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS = "1"
  Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = true
  try {
    const parent = path.join(tmp.path, "parent")
    const child = path.join(tmp.path, "isolated")
    await Promise.all([parent, child].map((directory) => fs.mkdir(directory)))
    await fs.writeFile(path.join(parent, "deepagent-code.json"), JSON.stringify({
      providers: { deepseek: { api: { type: "native", settings: {}, protocol: "openai.responses", url: "https://api.deepseek.com" },
        models: { "deepseek-flash": { api: { id: "deepseek-flash" } } } } },
      experimental: { policies: [{ action: "provider.use", resource: "denied", effect: "deny" }] },
    }))
    await Effect.runPromise(Effect.gen(function* () {
      const parentLocation = Layer.succeed(Location.Service, { directory: AbsolutePath.make(parent),
        project: { id: Project.ID.make("parent"), directory: AbsolutePath.make(parent) } })
      const actual = Context.get(yield* Layer.build(Config.locationLayer.pipe(Layer.provide(parentLocation),
        Layer.provide(FSUtil.defaultLayer), Layer.provide(Global.defaultLayer))), Config.Service)
      const documents = yield* actual.entries()
      // Only the configuration selector is instrumentation. No Native/Work authority exists in
      // this zero-provider composition test, and every execution port dies if unexpectedly used.
      const installed: WorkExecutionProfile.Installed = {
        configuration: (ref) => Effect.succeed(ref.directory === child && ref.workspaceID === undefined ? actual : undefined),
        profile: { preflight: () => Effect.die("unexpected Work execution"), observe: () => Effect.die("unexpected Work execution"),
          bind: () => Effect.die("unexpected Work execution"), current: () => Effect.die("unexpected Work execution"),
          acquireCount: () => Effect.die("unexpected Work execution") },
        verifier: { authorizeSource: () => Effect.die("unexpected Work authority"), resolveRoute: () => Effect.die("unexpected Work authority") },
        evidence: { resolve: () => Effect.die("unexpected Work authority"), readCount: () => Effect.die("unexpected Work count") },
        approval: { captured: () => Effect.die("unexpected Native capture"), authenticate: () => Effect.die("unexpected Native capture"), verify: () => Effect.die("unexpected Native capture") },
        count: { requireCapture: () => Effect.die("unexpected Native count"), authenticate: () => Effect.die("unexpected Native count"), verify: () => Effect.die("unexpected Native count") },
      }
      const host = Layer.effect(LocationRuntimeHost, Effect.map(LocationRuntimeHost, (host) => ({ ...host, work: installed })))
        .pipe(Layer.provide(defaultLocationRuntimeHost))
      const db = Database.layerFromPath(":memory:")
      const map = Context.get(yield* Layer.build(LocationServiceMap.layerNoDeps.pipe(Layer.provide([...locationServiceMapDependencies(
        host, db, EventV2.layer.pipe(Layer.provide(db)), AgentGateway.runtimeLayer({ enabled: false, runsDir: path.join(tmp.path, "runs"), durableLearning: false }),
      )]))), LocationServiceMap)
      const context = yield* map.contextEffect({ directory: AbsolutePath.make(child) })
      yield* Context.get(context, PluginBoot.Service).wait()
      expect(Context.get(context, Config.Service)).toBe(actual)
      expect(yield* Context.get(context, Config.Service).entries()).toBe(documents)
      const selected = yield* Context.get(context, Catalog.Service).model.get(ProviderV2.ID.make("deepseek"), ModelV2.ID.make("deepseek-flash"))
      expect(selected.providerID).toBe(ProviderV2.ID.make("deepseek"))
      expect(selected.id).toBe(ModelV2.ID.make("deepseek-flash"))
      expect(yield* Context.get(context, Policy.Service).evaluate("provider.use", "denied", "allow")).toBe("deny")
      expect(Context.get(context, Location.Service).directory).toBe(AbsolutePath.make(child))
    }).pipe(Effect.scoped))
    expect(await fs.readdir(child)).toEqual([])
  } finally {
    Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = saved.fetch
    if (saved.home === undefined) delete process.env.DEEPAGENT_CODE_TEST_HOME
    if (saved.home !== undefined) process.env.DEEPAGENT_CODE_TEST_HOME = saved.home
    if (saved.plugins === undefined) delete process.env.DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS
    if (saved.plugins !== undefined) process.env.DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS = saved.plugins
  }
}, 20_000)
