import { GlobalBus } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import * as Log from "@deepagent-code/core/util/log"
import { Effect } from "effect"
import { Event } from "./event"

const log = Log.create({ service: "server" })

export const emitGlobalDisposed = Effect.sync(() =>
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.Disposed.type,
      properties: {},
    },
  }),
)

export const disposeAllInstancesAndEmitGlobalDisposed = Effect.fn("Server.disposeAllInstancesAndEmitGlobalDisposed")(
  function* (options?: { swallowErrors?: boolean }) {
    const store = yield* InstanceStore.Service
    yield* Effect.gen(function* () {
      yield* options?.swallowErrors
        ? store.disposeAll().pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                log.warn("global disposal failed", { cause })
              }),
            ),
          )
        : store.disposeAll()
      yield* emitGlobalDisposed
    }).pipe(Effect.uninterruptible)
  },
)

// Dispose any running instances rooted at the given directories, swallowing per-directory
// failures. Used before deleting a project so a live instance does not keep writing to a
// row that is about to disappear. disposeDirectory is a no-op for directories with no
// booted instance, so passing every known project directory is safe.
export const disposeInstancesForDirectories = Effect.fn("Server.disposeInstancesForDirectories")(
  function* (directories: readonly string[]) {
    const store = yield* InstanceStore.Service
    yield* Effect.forEach(
      directories,
      (directory) =>
        store.disposeDirectory(directory).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              log.warn("instance disposal failed", { directory, cause })
            }),
          ),
        ),
      { discard: true },
    )
  },
)

export * as GlobalLifecycle from "./global-lifecycle"
