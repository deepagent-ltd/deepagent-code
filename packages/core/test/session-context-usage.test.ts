import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, LayerMap, Scope } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/database/database"
import { SessionContextUsage } from "../src/session/context-usage"
import { SessionTable } from "../src/session/sql"
import { existingContext } from "../src/location-layer"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { testEffect } from "./lib/effect"
import { seedSession } from "./fixture/attention"

const database = Database.layerFromPath(":memory:")
const it = testEffect(database)
const scope = { projectID: "project-a", directory: "/tmp/project-a", draftRevision: "draft" }

describe("read-only Session context usage", () => {
  it.effect("keeps legacy recorded totals without doubling them into receipt totals", () =>
    Effect.gen(function* () {
      const db = yield* Database.Service
      const sessionID = yield* seedSession(db, "usage-legacy")
      yield* db.db
        .update(SessionTable)
        .set({ tokens_input: 5_000, tokens_output: 800, tokens_reasoning: 100 })
        .where(eq(SessionTable.id, sessionID))
        .run()
      const result = yield* SessionContextUsage.read(db.db, { ...scope, sessionID })
      expect(result.totals).toMatchObject({ nonCachedInput: 5_000, output: 800, reasoning: 100 })
      expect(result.totalCalls).toBe(0)
      expect(result.coverage).toBe("partial")
      expect(result.totalsReasoningReported).toBe(false)
    }),
  )

  it.effect("rejects a different placement before returning usage", () =>
    Effect.gen(function* () {
      const db = yield* Database.Service
      const sessionID = yield* seedSession(db, "usage-scope")
      const result = yield* SessionContextUsage.read(db.db, { ...scope, sessionID, directory: "/other" }).pipe(
        Effect.flip,
      )
      expect(result.reason).toBe("scope_changed")
    }),
  )
})

class Cached extends Context.Service<Cached, { value: string }>()("test/ContextUsageCached") {}
const ref = { directory: AbsolutePath.make("/tmp/context-usage-cache"), workspaceID: undefined }
const plain = testEffect(Layer.empty)
plain.effect("observes only completed existing Location contexts and never builds missing or released entries", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const ready = yield* Deferred.make<void>()
    const calls = { count: 0 }
    const map = yield* LayerMap.make(
      (_ref: Location.Ref) =>
        Layer.effect(
          Cached,
          Effect.gen(function* () {
            calls.count++
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(ready)
            return { value: "existing" }
          }),
        ),
      { idleTimeToLive: "1 minute" },
    )
    expect(yield* existingContext(map, ref)).toBeUndefined()
    expect(calls.count).toBe(0)
    const scope = yield* Scope.make()
    const loading = yield* map.contextEffect(ref).pipe(Effect.provideService(Scope.Scope, scope), Effect.forkChild)
    yield* Deferred.await(started)
    expect(yield* existingContext(map, ref)).toBeUndefined()
    expect(calls.count).toBe(1)
    yield* Deferred.succeed(ready, undefined)
    yield* Fiber.join(loading)
    const observed = yield* existingContext(map, { directory: ref.directory })
    expect(observed && Context.get(observed.context, Cached).value).toBe("existing")
    expect(observed?.current()).toBe(true)
    yield* map.invalidate(ref)
    expect(yield* existingContext(map, ref)).toBeUndefined()
    expect(observed?.current()).toBe(false)
    expect(calls.count).toBe(1)
    yield* Scope.close(scope, Exit.void)
  }),
)

plain.effect("renders prospective DeepAgent state on a detached copy without creating or saving a session", () =>
  Effect.gen(function* () {
    const { mkdtemp, readdir, readFile, rm } = yield* Effect.promise(() => import("node:fs/promises"))
    const state = yield* Effect.promise(() => import("../src/deepagent/session-state"))
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp("/tmp/dac-context-observe-")),
      (value) => Effect.promise(() => rm(value, { recursive: true, force: true })),
    )
    const runtime = state.createRuntime(directory)
    state.withRuntime(runtime, () => {
      const preview = state.snapshot("preview", "high", "msg_preview")
      preview.userRequest = "only a draft"
      expect(runtime.sessions.size).toBe(0)
      state.getOrCreate("existing", "high")
    })
    const files = yield* Effect.promise(() => readdir(directory))
    const before = yield* Effect.promise(() =>
      Promise.all(files.map((file) => readFile(`${directory}/${file}`, "utf8"))),
    )
    state.withRuntime(runtime, () => {
      const preview = state.snapshot("existing", "high", "msg_changed")
      preview.userRequest = "a future input"
      expect(state.get("existing")?.userRequest).not.toBe("a future input")
    })
    expect(yield* Effect.promise(() => readdir(directory))).toEqual(files)
    expect(
      yield* Effect.promise(() => Promise.all(files.map((file) => readFile(`${directory}/${file}`, "utf8")))),
    ).toEqual(before)
  }),
)

plain.effect("observes an absent plan without creating graph or docs directories", () =>
  Effect.gen(function* () {
    const { mkdtemp, readdir, rm } = yield* Effect.promise(() => import("node:fs/promises"))
    const { DeepAgentPlanStore } = yield* Effect.promise(() => import("../src/deepagent/plan-store"))
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp("/tmp/dac-plan-observe-")),
      (value) => Effect.promise(() => rm(value, { recursive: true, force: true })),
    )
    const runtime = DeepAgentPlanStore.createRuntime(directory)
    expect(DeepAgentPlanStore.withRuntime(runtime, () => DeepAgentPlanStore.observe("no-plan"))).toBeUndefined()
    expect(yield* Effect.promise(() => readdir(directory))).toEqual([])
  }),
)
