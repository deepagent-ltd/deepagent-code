import { writeFileSync } from "node:fs"
import path from "node:path"
import { Effect, Scope } from "effect"
import { ListenerStop } from "../../../../deepagent-code/src/server/listener-stop"

const root = process.env.DAC_SIDECAR_SHUTDOWN_ROOT
const scenario = process.env.DAC_SIDECAR_SHUTDOWN_SCENARIO
if (!root || !scenario) throw new Error("Private sidecar shutdown fixture is required")
const facts = { pid: process.pid, stopCalls: 0, finalized: 0, entered: 0, stages: [] as string[] }
const persist = () => writeFileSync(path.join(root, "utility.json"), JSON.stringify(facts), { mode: 0o600 })

export const BrowserNativeHost = { prepare: async () => {} }
export const Log = { init: async () => {} }
export const Server = {
  listen: async () => {
    const scope = Scope.makeUnsafe()
    await Effect.runPromise(
      Scope.addFinalizer(
        scope,
        Effect.gen(function* () {
          facts.entered++
          persist()
          if (scenario === "failed")
            return yield* Effect.die(new Error("private-finalizer-secret /private/fixture-only"))
          if (scenario === "interrupted") return yield* Effect.interrupt
          if (scenario === "timeout") return yield* Effect.promise(() => new Promise<void>(() => {}))
          yield* Effect.sleep("50 millis")
          facts.finalized++
          persist()
        }),
      ),
    )
    const stop = ListenerStop.make({
      scope,
      unpublish: Effect.sync(() => {
        facts.stages.push("mdns")
      }),
      websockets: {
        closeAll: Effect.sync(() => {
          facts.stages.push("websockets")
        }),
      },
      http: {
        close: Effect.sync(() => {
          facts.stages.push("http")
        }),
        closeAll: Effect.sync(() => {
          facts.stages.push("force")
        }),
      },
    })
    persist()
    return {
      stop: () => {
        facts.stopCalls++
        persist()
        return stop()
      },
    }
  },
}
