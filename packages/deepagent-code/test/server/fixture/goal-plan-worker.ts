import { NativeBootstrap } from "@/runtime/native-bootstrap"
import { GoalPlanRebaseAccess } from "@/session/goal-plan-rebase-access"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { GoalManager } from "@/session/goal-manager"
import { AppRuntime } from "@/effect/app-runtime"
import { WorkAuthorityFixture } from "../../../../core/test/fixture/work-authority"
import { GoalPlanClientFixture } from "../../../../core/test/fixture/goal-plan-client"
import { Database } from "@deepagent-code/core/database/database"
import { Effect } from "effect"
import { Server } from "@/server/server"
import { parentPort } from "node:worker_threads"
import fs from "node:fs/promises"
import path from "node:path"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { sql } from "drizzle-orm"

NativeBootstrap.install()
const seedFile = path.join(process.env.DAC_GOAL_PLAN_FIXTURE_ROOT!, "seed.json")
const saved: { sessionID: string; goalID: string } | undefined = await fs
  .readFile(seedFile, "utf8")
  .then((text) => JSON.parse(text))
  .catch(() => undefined)
if (saved) await AppRuntime.runPromise(Database.Service)
const setup = saved
  ? { parent: { id: saved.sessionID }, goalID: saved.goalID }
  : await (async () => {
      await AppRuntime.runPromise(WorkAuthorityFixture.initialize())
      const fresh = await AppRuntime.runPromise(
        GoalPlanClientFixture.prepare(process.cwd(), undefined, GoalManager.goalStoreRoot),
      )
      if (process.env.DAC_GOAL_PLAN_FIXTURE_PORT)
        await AppRuntime.runPromise(
          GoalControl.control(fresh.db, {
            sessionID: fresh.parent.id,
            goalId: fresh.goalID,
            expectedRevision: 1,
            requestID: "fixture-pause-before-server",
            action: "pause",
          }),
        )
      await fs.writeFile(seedFile, JSON.stringify({ sessionID: fresh.parent.id, goalID: fresh.goalID }))
      return fresh
    })()
const listener = process.env.DAC_GOAL_PLAN_FIXTURE_PORT
  ? await Server.listen({ hostname: "127.0.0.1", port: Number(process.env.DAC_GOAL_PLAN_FIXTURE_PORT) })
  : undefined
const extraListeners: Awaited<ReturnType<typeof Server.listen>>[] = []
const permissions = <A, E>(read: (value: PermissionV2.Interface) => Effect.Effect<A, E>) =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap
      return yield* Effect.gen(function* () {
        return yield* read(yield* PermissionV2.Service)
      }).pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(process.cwd()) })))
    }),
  )
const before = await AppRuntime.runPromise(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return {
      inputs: yield* db.all(sql`SELECT * FROM session_input`),
      events: yield* db.all(sql`SELECT * FROM session_activity`),
    }
  }),
)
parentPort!.on("message", (value: unknown) => {
  if (!value || typeof value !== "object" || !("fixture" in value)) return
  if (value.fixture === "start-listener")
    void Server.listen({ hostname: "127.0.0.1", port: 0 }).then((server) => {
      extraListeners.push(server)
      parentPort!.postMessage({
        fixture: "start-listener",
        available: Server.privateGoalWritesAvailable(),
        url: server.url.toString(),
      })
    })
  if (value.fixture === "permissions")
    void permissions((service) => service.list()).then((data) =>
      parentPort!.postMessage({ fixture: "permissions", data }),
    )
  if (value.fixture === "approve")
    void permissions((service) =>
      Effect.gen(function* () {
        const requests = yield* service.list()
        for (const request of requests) yield* service.reply({ requestID: request.id, reply: "once" })
        return requests.length
      }),
    ).then((count) => parentPort!.postMessage({ fixture: "approve", count }))
  if (value.fixture === "snapshot")
    void AppRuntime.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        return {
          inputs: yield* db.all(sql`SELECT * FROM session_input`),
          events: yield* db.all(sql`SELECT * FROM session_activity`),
          edits: yield* db.all(sql`SELECT * FROM goal_plan_rebase`),
        }
      }),
    ).then((data) => parentPort!.postMessage({ fixture: "snapshot", data, before }))
  if (value.fixture === "http-forgery")
    void Promise.resolve(
      Server.Default().app.fetch(
        new Request("http://deepagent-code.internal/deepagent/goal/plan-rebase/begin", {
          method: "POST",
          headers: { "content-type": "application/json", host: "deepagent-code.internal" },
          body: JSON.stringify({
            sessionID: setup.parent.id,
            goalID: setup.goalID,
            expectedControlRevision: 1,
            requestID: "forged",
            operator: "local",
            access: {},
          }),
        }),
      ),
    ).then(async (response) =>
      parentPort!.postMessage({ fixture: "http-forgery", status: response.status, body: await response.text() }),
    )
  if (value.fixture === "reset-channel") {
    GoalPlanRebaseAccess.closeTuiBridge()
    parentPort!.postMessage({ fixture: "reset-channel" })
  }
  if (value.fixture === "shutdown") {
    GoalPlanRebaseAccess.closeTuiBridge()
    void (async () => {
      await listener?.stop(true)
      await Promise.all(extraListeners.map((server) => server.stop(true)))
      await AppRuntime.dispose()
      process.exit(0)
    })()
  }
})
parentPort!.postMessage({
  fixture: "seed",
  sessionID: setup.parent.id,
  goalID: setup.goalID,
  url: listener?.url.toString(),
})
await GoalPlanRebaseAccess.installTuiBridge()
