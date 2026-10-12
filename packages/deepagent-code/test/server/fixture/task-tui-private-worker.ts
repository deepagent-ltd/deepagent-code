import assert from "node:assert/strict"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Database } from "@deepagent-code/core/database/database"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { TaskRunAuthority } from "@deepagent-code/core/session/task-run"
import { TaskRunTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AppRuntime } from "@/effect/app-runtime"
import { TaskTuiPrivate } from "@/attention/task-tui-private"
import { Server } from "@/server/server"

assert(parentPort)
const directory = process.cwd()
const state: {
  listener?: Awaited<ReturnType<typeof Server.listen>>
  unknown?: { itemID: string; childID: SessionSchema.ID; token: number }
} = {}
const seed = await AppRuntime.runPromise(
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
    if (value.probe === "seed") return seed
    if (value.probe === "unknown-seed") {
      state.unknown = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const submitted = yield* TaskRunAuthority.submit(db, yield* EventV2Bridge.Service, yield* SessionV2.Service, {
            parentSessionID: seed.parent.id,
            parentMessageID: SessionMessage.ID.make("msg_task_tui_unknown"),
            toolCallID: "call_task_tui_unknown",
            prompt: new Prompt({ text: "Unresolved child ownership" }),
            deliveryMode: "foreground",
            agent: "general",
            child: { title: "Unresolved child", location: seed.parent.location, permissions: [] },
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
await TaskTuiPrivate.installTuiBridge()
