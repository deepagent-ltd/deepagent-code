import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Config } from "@deepagent-code/core/config"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Global } from "@deepagent-code/core/global"
import { Location } from "@deepagent-code/core/location"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SystemContext } from "@deepagent-code/core/system-context"
import { ConfigInstructions } from "@deepagent-code/core/system-context/config-instructions"
import { SystemContextBuiltIns } from "@deepagent-code/core/system-context/builtins"
import { SystemContextRegistry } from "@deepagent-code/core/system-context/registry"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

describe("ConfigInstructions", () => {
  it.live("loads configured local and URL instructions after AGENTS.md and preserves a failed URL snapshot", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          let available = true
          let remoteContent = "Follow the remote guide."
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                port: 0,
                fetch: () =>
                  available ? new Response(remoteContent) : new Response("temporarily unavailable", { status: 503 }),
              }),
            ),
            (server) => Effect.sync(() => server.stop()),
          )
          const url = new URL("instructions.md", server.url).href
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(path.join(tmp.path, "AGENTS.md"), "Follow AGENTS."),
              fs.writeFile(path.join(tmp.path, "LOCAL.md"), "Follow local guide."),
              fs.writeFile(
                path.join(tmp.path, "deepagent-code.json"),
                JSON.stringify({ instructions: ["LOCAL.md", url] }),
              ),
            ]),
          )

          const stack = SystemContextBuiltIns.locationLayer.pipe(
            Layer.provideMerge(Config.locationLayer),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(FSUtil.defaultLayer),
            Layer.provide(Global.layerWith({ home: tmp.path, config: path.join(tmp.path, "global") })),
            Layer.provide(
              Layer.succeed(
                Location.Service,
                Location.Service.of(
                  location(
                    { directory: AbsolutePath.make(tmp.path) },
                    { projectDirectory: AbsolutePath.make(tmp.path) },
                  ),
                ),
              ),
            ),
          )
          yield* Effect.provide(
            Effect.gen(function* () {
              const registry = yield* SystemContextRegistry.Service
              const initialized = yield* SystemContext.initialize(yield* registry.load())
              expect(initialized.snapshot[ConfigInstructions.registryKey]).toBeDefined()
              expect(initialized.baseline).toContain(`Instructions from: ${url}\nFollow the remote guide.`)
              expect(initialized.baseline.indexOf("Follow AGENTS.")).toBeLessThan(
                initialized.baseline.indexOf("Follow local guide."),
              )
              expect(initialized.baseline.indexOf("Follow local guide.")).toBeLessThan(
                initialized.baseline.indexOf("Follow the remote guide."),
              )

              available = false
              expect(yield* SystemContext.reconcile(yield* registry.load(), initialized.snapshot)).toEqual({
                _tag: "Unchanged",
              })
              available = true
              remoteContent = "Follow the revised remote guide."
              const updated = yield* SystemContext.reconcile(yield* registry.load(), initialized.snapshot)
              expect(updated._tag).toBe("Updated")
              if (updated._tag === "Updated") {
                expect(updated.text).toContain("Follow the revised remote guide.")
                expect(updated.snapshot[ConfigInstructions.registryKey]).toBeDefined()
              }
            }),
            stack,
          )
        }),
      ),
    ),
  )
})
