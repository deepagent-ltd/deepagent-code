import assert from "node:assert/strict"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import type { SessionSchema } from "@deepagent-code/core/session/schema"

assert(parentPort)
const TaskTuiPrivate = await import("@/attention/task-tui-private-bootstrap")
await TaskTuiPrivate.installTuiBridge()
const pendingSeed = Promise.withResolvers<{ local: string; foreign: string; parent: SessionSchema.Info }>()
parentPort.on("message", (value: unknown) => {
  if (!value || typeof value !== "object" || !("probe" in value) || value.probe !== "seed" || !("id" in value)) return
  const id = value.id
  void pendingSeed.promise.then(
    (data) => parentPort!.postMessage({ probeResult: true, id, data }),
    (error: unknown) => parentPort!.postMessage({ probeResult: true, id, error: String(error) }),
  )
})
if (process.platform === "win32") await import("../../fixture/source-empty-settings-preload")
const { eq, sql } = await import("drizzle-orm")
const { Effect } = await import("effect")
const { AbsolutePath } = await import("@deepagent-code/core/schema")
const { Database } = await import("@deepagent-code/core/database/database")
const { SessionV2 } = await import("@deepagent-code/core/session")
const { SessionMessage } = await import("@deepagent-code/core/session/message")
const { Prompt } = await import("@deepagent-code/core/session/prompt")
const { TaskRunAuthority } = await import("@deepagent-code/core/session/task-run")
const { TaskRunTable } = await import("@deepagent-code/core/session/sql")
const { SessionStore } = await import("@deepagent-code/core/session/store")
const { EventV2Bridge } = await import("@/event-v2-bridge")
const { AppRuntime } = await import("@/effect/app-runtime")
const { Server } = await import("@/server/server")
const directory = process.cwd()
const state: {
  listener?: Awaited<ReturnType<typeof Server.listen>>
  unknown?: { itemID: string; childID: SessionSchema.ID; token: number }
} = {}
const seed = AppRuntime.runPromise(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const sessions = yield* SessionV2.Service
    const parent = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
    const foreign = yield* sessions.create({
      location: { directory: AbsolutePath.make(path.join(directory, "foreign")) },
    })
    const make = (session: typeof parent, name: string) => ({
      parentSessionID: session.id,
      parentMessageID: SessionMessage.ID.make(`msg_task_tui_${name}`),
      toolCallID: `call_task_tui_${name}`,
      prompt: new Prompt({ text: `Task ${name}` }),
      deliveryMode: "foreground" as const,
      agent: "general",
      child: { title: `Task ${name}`, location: { directory: session.location.directory }, permissions: [] },
    })
    const local = yield* TaskRunAuthority.admitRun(db, make(parent, "local"))
    const outside = yield* TaskRunAuthority.admitRun(db, make(foreign, "foreign"))
    // Controlled crash frontier; settlement comes only from the original human
    // reducer. This test proves private authority, not a model execution crash.
    for (const run of [local.run, outside.run])
      yield* db.update(TaskRunTable).set({ state: "recovery_required" }).where(eq(TaskRunTable.run_id, run.runID)).run()
    return {
      local: `task:${local.run.childSessionID}:${local.run.generation}`,
      foreign: `task:${outside.run.childSessionID}:${outside.run.generation}`,
      parent,
    }
  }),
)
pendingSeed.resolve(seed)
const census = () =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      return {
        ledger: yield* db.all(sql`SELECT
      (SELECT count(*) FROM task_run_event) AS events,
      (SELECT coalesce(sum(version),0) FROM task_run) AS versions,
      (SELECT count(*) FROM session_v2_task_run_receipt) AS terminals,
      (SELECT count(*) FROM task_notification_outbox) AS outbox,
      (SELECT count(*) FROM session_input) AS inputs,
      (SELECT count(*) FROM session_v2_provider_turn_receipt) AS providers,
      (SELECT count(*) FROM session_provider_attempt) AS attempts,
      (SELECT count(*) FROM session_v2_tool_effect_admission) AS tools,
      (SELECT count(*) FROM session WHERE execution_claim_token IS NOT NULL) AS claims`),
        token: state.unknown ? yield* (yield* SessionStore.Service).claimToken(state.unknown.childID) : undefined,
      }
    }),
  )
parentPort.on("message", (value: unknown) => {
  if (!value || typeof value !== "object" || !("probe" in value) || !("id" in value)) return
  const id = value.id
  void (async () => {
    if (value.probe === "unknown-seed") {
      const seedValue = await pendingSeed.promise
      state.unknown = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const submitted = yield* TaskRunAuthority.submit(db, yield* EventV2Bridge.Service, yield* SessionV2.Service, {
            parentSessionID: seedValue.parent.id,
            parentMessageID: SessionMessage.ID.make("msg_task_tui_unknown"),
            toolCallID: "call_task_tui_unknown",
            prompt: new Prompt({ text: "Unresolved child ownership" }),
            deliveryMode: "foreground",
            agent: "general",
            child: { title: "Unresolved child", location: seedValue.parent.location, permissions: [] },
          })
          yield* db
            .update(TaskRunTable)
            .set({ state: "recovery_required" })
            .where(eq(TaskRunTable.run_id, submitted.run.runID))
            .run()
          const token = yield* (yield* SessionStore.Service).claim(submitted.run.childSessionID)
          assert(token)
          return {
            itemID: `task:${submitted.run.childSessionID}:${submitted.run.generation}`,
            childID: submitted.run.childSessionID,
            token,
          }
        }),
      )
      return state.unknown
    }
    if (value.probe === "census") return census()
    if (value.probe === "listener") {
      state.listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
      return state.listener.url.toString()
    }
    if (value.probe === "listener-close") {
      await state.listener?.stop(true)
      state.listener = undefined
      return true
    }
    if (value.probe === "reload") {
      await TaskTuiPrivate.closeTuiBridge()
      return true
    }
    if (value.probe === "dispose") {
      await TaskTuiPrivate.closeTuiBridge()
      await state.listener?.stop(true)
      await Server.disposeDefault()
      await AppRuntime.dispose()
      return true
    }
    throw new Error("Unknown fixture probe")
  })().then(
    (data) => parentPort!.postMessage({ probeResult: true, id, data }),
    (error: unknown) => parentPort!.postMessage({ probeResult: true, id, error: String(error) }),
  )
})
