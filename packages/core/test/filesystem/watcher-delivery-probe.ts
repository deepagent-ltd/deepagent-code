import { eventLayer } from "../fixture/event-layer"
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Option, Stream } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Config } from "@deepagent-code/core/config"
import { EventV2 } from "@deepagent-code/core/event"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Watcher } from "@deepagent-code/core/filesystem/watcher"
import { Git } from "@deepagent-code/core/git"
import { Location } from "@deepagent-code/core/location"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { location } from "../fixture/location"
import { tmpRootAsync, tmpRootSharedAsync } from "../fixture/tmpdir"

/**
 * Does THIS host actually deliver filesystem events?
 *
 * Liveness and delivery are different facts. `Watcher.Service.ready` establishes that the backend
 * accepted the subscriptions; it says nothing about whether callbacks arrive. Under sustained load
 * this machine was observed accepting subscriptions and then delivering nothing at all, which made
 * the watcher suite fail for a reason no assertion can reach.
 *
 * The probe lives in its own module so it can run at import time without depending on any layer the
 * test file defines later (an earlier in-file version awaited a `const` declared below it, threw a
 * temporal-dead-zone error into its own catch, and reported "not delivering" on a perfectly healthy
 * host — the exact false negative this file exists to avoid).
 */
export async function watcherDelivers(): Promise<boolean> {
  const directory = await tmpRootSharedAsync()
  try {
    const configLayer = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
    const flagsLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        DEEPAGENT_CODE_EXPERIMENTAL_FILEWATCHER: "true",
        DEEPAGENT_CODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "false",
      }),
    )
    const locationLayer = Layer.succeed(
      Location.Service,
      Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
    )
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const watcher = yield* Watcher.Service
          const ready = yield* watcher.ready.pipe(Effect.timeoutOption("20 seconds"))
          if (Option.isNone(ready)) return false
          const events = yield* EventV2.Service
          const seen = yield* Deferred.make<string>()
          const fiber = yield* events.subscribe(Watcher.Event.Updated).pipe(
            Stream.runForEach((event) => Deferred.succeed(seen, event.data.file).pipe(Effect.asVoid)),
            Effect.forkScoped,
          )
          yield* Effect.sleep("300 millis")
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "probe.txt"), "probe"))
          const delivered = yield* Deferred.await(seen).pipe(Effect.timeoutOption("15 seconds"))
          yield* Fiber.interrupt(fiber)
          return Option.isSome(delivered)
        }).pipe(
          Effect.provide(
            Watcher.layer.pipe(
              Layer.provide(configLayer),
              Layer.provide(Git.defaultLayer),
              Layer.provide(locationLayer),
              Layer.provide(flagsLayer),
            ),
          ),
          Effect.provide(Layer.mergeAll(FSUtil.defaultLayer, eventLayer())),
        ),
      ),
    )
  } catch (error) {
    console.warn(`[watcher-probe] could not complete: ${error instanceof Error ? error.message : String(error)}`)
    return false
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}
