import path from "node:path"
import fs from "node:fs/promises"
import { expect, test } from "bun:test"
import { Context, Effect, Exit, Layer } from "effect"
import { Config } from "@deepagent-code/core/config"
import { ConfigProviderPlugin } from "@deepagent-code/core/config/plugin/provider"
import { Catalog } from "@deepagent-code/core/catalog"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Global } from "@deepagent-code/core/global"
import { Location } from "@deepagent-code/core/location"
import { Project } from "@deepagent-code/core/project"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { Policy } from "@deepagent-code/core/policy"
import { tmpdir } from "../fixture/tmpdir"
import { eventLayer } from "../fixture/event-layer"

test("isolated child inherits actual opened parent configuration and denial policies without filesystem copies", async () => {
  await using tmp = await tmpdir()
  const parent = path.join(tmp.path, "parent")
  const child = path.join(tmp.path, "isolated")
  const global = path.join(tmp.path, "global")
  await Promise.all([parent, child, global].map((directory) => fs.mkdir(directory)))
  await fs.writeFile(path.join(parent, "deepagent-code.json"), JSON.stringify({
    providers: { deepseek: { api: { type: "native", settings: {}, protocol: "openai.responses", url: "https://api.deepseek.com" },
      models: { "deepseek-flash": { api: { id: "deepseek-flash" } } } } },
    experimental: { policies: [{ action: "provider.use", resource: "denied", effect: "deny" }] },
  }))
  const location = (directory: string) => Layer.succeed(Location.Service, Location.Service.of({ directory: AbsolutePath.make(directory),
    project: { id: Project.ID.make("same-project"), directory: AbsolutePath.make(directory) } }))
  const config = (directory: string) => Config.locationLayer.pipe(Layer.provide(location(directory)),
    Layer.provide(FSUtil.defaultLayer), Layer.provide(Global.layerWith({ config: global })))
  await Effect.runPromise(Effect.gen(function* () {
    const original = Context.get(yield* Layer.build(config(parent)), Config.Service)
    const parentEntries = yield* original.entries()
    const observe = Effect.gen(function* () {
      const actual = yield* Config.Service
      yield* ConfigProviderPlugin.Plugin.effect
      const model = yield* (yield* Catalog.Service).model.get(ProviderV2.ID.make("deepseek"), ModelV2.ID.make("deepseek-flash")).pipe(Effect.exit)
      return { actual, entries: yield* actual.entries(), model,
        denied: yield* (yield* Policy.Service).evaluate("provider.use", "denied", "allow") }
    })
    const catalog = Catalog.locationLayer.pipe(Layer.provide(eventLayer()))
    const normal = yield* observe.pipe(Effect.provide(Layer.mergeAll(config(child), catalog).pipe(Layer.provide(location(child)))))
    expect(Exit.isFailure(normal.model)).toBe(true)
    const inherited = yield* observe.pipe(Effect.provide(Layer.mergeAll(Config.inheritedLayer(original), catalog)
      .pipe(Layer.provide(location(child)))))
    expect(inherited.actual).toBe(original)
    expect(inherited.entries).toBe(parentEntries)
    expect(Exit.isSuccess(inherited.model)).toBe(true)
    expect(inherited.denied).toBe("deny")
    expect(inherited.entries.filter((entry) => entry.type === "document").some((entry) => entry.path === path.join(parent, "deepagent-code.json"))).toBe(true)
  }).pipe(Effect.scoped))
  expect(await fs.readdir(child)).toEqual([])
})
