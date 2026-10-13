import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Scope, Exit, Fiber, Deferred } from "effect"
import { PermissionV2 } from "../src/permission"
import { PermissionSaved } from "../src/permission/saved"
import { Database } from "../src/database/database"
import { AgentV2 } from "../src/agent"
import { EventV2 } from "../src/event"
import { Location } from "../src/location"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { SessionTable } from "../src/session/sql"
import { SessionSchema } from "../src/session/schema"
import { SessionStore } from "../src/session/store"
import { AbsolutePath } from "../src/schema"
import { location } from "./fixture/location"

const rules = (permissions: PermissionV2.Ruleset) => Effect.gen(function* () {
  const transform = yield* (yield* AgentV2.Service).transform()
  yield* transform((editor) => editor.update(AgentV2.ID.make("test"), (agent) => { agent.permissions = [...permissions] }))
})

test("real PermissionV2 once permits bind exact action, live policy and scope; checks never ask again", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-browser-permission-"))
  const database = Database.layerFromPath(path.join(root, "permissions.sqlite"))
  const current = Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(root) }))
  const dependencies = Layer.mergeAll(database, current,
    EventV2.layer.pipe(Layer.provide(database)), SessionStore.layer.pipe(Layer.provide(database)),
    PermissionSaved.layer.pipe(Layer.provide(database)))
  const layer = PermissionV2.locationLayer.pipe(Layer.provideMerge(dependencies))
  await Effect.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(root), sandboxes: [] }).onConflictDoNothing().run()
    yield* db.insert(SessionTable).values({ id: SessionSchema.ID.make("ses_browser_permit"), project_id: Project.ID.global,
      directory: root, slug: "browser", title: "browser", version: "fixture", agent: "test", v2_authority: true }).run()
    yield* rules([])
    const service = yield* PermissionV2.Service
    const scope = yield* Scope.make()
    const asked = yield* Deferred.make<PermissionV2.Request>()
    let prompts = 0
    const unsubscribe = yield* (yield* EventV2.Service).listen((event) => {
      if (event.type !== PermissionV2.Event.Asked.type) return Effect.void
      prompts++
      return Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    const input: PermissionV2.AssertInput = { sessionID: SessionSchema.ID.make("ses_browser_permit"), agent: AgentV2.ID.make("test"),
      action: "browser", resources: ["control/navigate/tab/digest"], metadata: { origin: "http://127.0.0.1:12345" } }
    const waiting = yield* service.authorizeAction!(input).pipe(Effect.provideService(Scope.Scope, scope), Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    yield* service.reply({ requestID: request.id, reply: "once" })
    const permit = yield* Fiber.join(waiting)
    yield* service.checkAction!(permit, input)
    expect(prompts).toBe(1)
    expect(Exit.isFailure(yield* Effect.exit(service.checkAction!({ ...permit }, input)))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(service.checkAction!(permit, { ...input, resources: ["another-control"] })))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(service.checkAction!(permit, { ...input, metadata: { origin: "http://127.0.0.1:12346" } })))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(service.checkAction!(permit, { ...input, action: "browser-clipboard" })))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(service.checkAction!(permit, { ...input, action: "browser-program" })))).toBe(true)
    const foreign = yield* PermissionV2.Service.pipe(Effect.provide(PermissionV2.layer.pipe(Layer.fresh)))
    expect(Exit.isFailure(yield* Effect.exit(foreign.checkAction!(permit, input)))).toBe(true)
    yield* rules([{ action: "browser", resource: "*", effect: "deny" }])
    expect(Exit.isFailure(yield* Effect.exit(service.checkAction!(permit, input)))).toBe(true)
    yield* rules([])
    yield* Scope.close(scope, Exit.void)
    expect(Exit.isFailure(yield* Effect.exit(service.checkAction!(permit, input)))).toBe(true)
    expect(prompts).toBe(1)
    expect(yield* service.list()).toEqual([])
  }).pipe(Effect.provide(layer), Effect.scoped))
}, 30_000)
