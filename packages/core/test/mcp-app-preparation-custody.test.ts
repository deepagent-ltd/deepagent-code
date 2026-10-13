import { expect, test } from "bun:test"
import path from "node:path"
import { Deferred, Effect, Fiber, Layer, Scope } from "effect"
import { AgentV2 } from "../src/agent"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { Location } from "../src/location"
import { Project } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { McpAppInvocation } from "../src/session/mcp-app-invocation"
import { SessionSchema } from "../src/session/schema"
import { tmpRoot } from "./fixture/tmpdir"

test("MCP App original preparing custody reserves 64 before asynchronous host capture and releases failed preparation", async () => {
  const directory = AbsolutePath.make(tmpRoot())
  const location = Location.Service.of({ directory, project: { id: Project.ID.global, directory } })
  const database = Database.layerFromPath(path.join(directory, "apps.sqlite"))
  const events = EventV2.layer.pipe(Layer.provide(database))
  await Effect.runPromise(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const captures = { value: 0 }
      yield* McpAppInvocation.registerHost(location, {
        // A real blocked host callback, not an invented Native/view/agent witness. No callback
        // returns a Native or reaches SQL admission; this case proves the pre-capture boundary.
        capture: () =>
          Effect.gen(function* () {
            captures.value++
            if (captures.value > 64) return yield* McpAppInvocation.failure("unavailable")
            if (captures.value === 64) yield* Deferred.succeed(ready, undefined)
            return yield* Effect.never
          }),
      })
      const app = yield* McpAppInvocation.make()
      const scope = yield* Scope.Scope
      const input = (id: number) => ({
        sessionID: SessionSchema.ID.make("ses_apps_preparing"),
        viewID: "a".repeat(8) + "-" + "b".repeat(4) + "-" + "c".repeat(4) + "-" + "d".repeat(4) + "-" + "e".repeat(12),
        rpcID: id,
        name: "original-tool",
        arguments: {},
      })
      const fibers = yield* Effect.forEach(
        Array.from({ length: 64 }, (_, index) => index),
        (index) => Effect.forkIn(app.invoke(input(index)), scope),
      )
      yield* Deferred.await(ready)
      const full = yield* app.invoke(input(64)).pipe(Effect.result)
      expect(full._tag).toBe("Failure")
      if (full._tag === "Failure") expect(full.failure.code).toBe("capacity")
      expect(captures.value).toBe(64)
      yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true })
      const next = yield* app.invoke(input(65)).pipe(Effect.result)
      expect(next._tag).toBe("Failure")
      if (next._tag === "Failure") expect(next.failure.code).toBe("unavailable")
      expect(captures.value).toBe(65)
    }).pipe(
      Effect.provide(Layer.mergeAll(database, events, AgentV2.layer, Layer.succeed(Location.Service, location))),
      Effect.scoped,
    ),
  )
})
