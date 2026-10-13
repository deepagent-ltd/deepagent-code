export * as TaskTuiPrivate from "./task-tui-private"

import { isMainThread, MessagePort, parentPort } from "node:worker_threads"
import { realpath } from "node:fs/promises"
import { userInfo } from "node:os"
import { and, eq, isNull } from "drizzle-orm"
import { Config, Effect, Schema } from "effect"
import { Attention } from "@deepagent-code/core/attention"
import { Database } from "@deepagent-code/core/database/database"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { TaskHumanControl } from "@deepagent-code/core/session/task-human-control"
import { TaskHumanControlSchema } from "@deepagent-code/core/session/task-human-control.schema"
import { Hash } from "@deepagent-code/core/util/hash"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Server } from "@/server/server"

let installed = false
let closeBridge: (() => Promise<void>) | undefined
export const closeTuiBridge = () => closeBridge?.() ?? Promise.resolve()
const denied = () =>
  new TaskHumanControlSchema.Error({
    code: "auth_required",
    message: "The private Task operator is no longer current",
  })

/** Only the real worker parent can establish this purpose-specific channel.
 * It exposes no Access mint to HTTP, generic RPC or serialized callers. */
export async function installTuiBridge() {
  if (isMainThread || !parentPort) throw new Error("Private Task bridge requires the actual TUI worker parent")
  if (installed) throw new Error("Private Task bootstrap is already installed")
  installed = true
  const directory = await realpath(process.cwd())
  const operator = userInfo()
  // OS identity is stable across worker reloads, so exact command retries retain
  // their receipt namespace. Authority still comes from the real parent channel.
  const principal = `tui:${Hash.sha256(JSON.stringify([operator.uid, operator.username]))}`
  parentPort.on("message", (message: unknown) => {
    if (
      !message ||
      typeof message !== "object" ||
      !("kind" in message) ||
      message.kind !== "task-human-bootstrap-v1" ||
      !("port" in message) ||
      !(message.port instanceof MessagePort)
    )
      return
    const port = message.port
    if (closeBridge) {
      port.close()
      return
    }
    const state: { active: boolean; settle?: () => void } = { active: true }
    const closed = new Promise<void>((resolve) => {
      state.settle = resolve
    })
    const requests = new Map<number, AbortController>()
    const post = (value: unknown) => {
      try {
        port.postMessage(value)
      } catch {
        close()
      }
    }
    const finishClose = () => {
      if (state.active || requests.size) return
      post({ closed: true })
      port.close()
      if (closeBridge === close) closeBridge = undefined
      state.settle?.()
    }
    const close = () => {
      if (!state.active) return closed
      state.active = false
      requests.forEach((request) => request.abort())
      finishClose()
      return closed
    }
    closeBridge = close
    port.on("close", close)
    port.on("message", (value: unknown) => {
      if (!value || typeof value !== "object") return
      if ("kind" in value && value.kind === "close") {
        close()
        return
      }
      if (
        !state.active ||
        !("id" in value) ||
        typeof value.id !== "number" ||
        !Number.isSafeInteger(value.id) ||
        value.id < 0
      )
        return
      if ("kind" in value && value.kind === "revoke") {
        requests.get(value.id)?.abort()
        return
      }
      if (requests.has(value.id)) {
        close()
        return
      }
      if (
        !("action" in value) ||
        !["get", "control"].includes(String(value.action)) ||
        !("request" in value) ||
        !("deadlineAt" in value) ||
        typeof value.deadlineAt !== "number" ||
        !Number.isSafeInteger(value.deadlineAt) ||
        value.deadlineAt <= Date.now() ||
        value.deadlineAt > Date.now() + 30000 ||
        requests.size >= 8
      ) {
        post({ id: value.id, error: { code: "invalid_request", message: "Private Task request is unavailable" } })
        post({ id: value.id, settled: true })
        return
      }
      const id = value.id
      const deadlineAt = value.deadlineAt
      const controller = new AbortController()
      requests.set(id, controller)
      const deadline = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()))
      const active = () => state.active && !controller.signal.aborted && Date.now() < deadlineAt
      void (async () => {
        const { AppRuntime } = await import("@/effect/app-runtime")
        const operation = Effect.gen(function* () {
          if (!active()) return yield* denied()
          const database = yield* Database.Service
          const sessions = yield* SessionV2.Service
          const flags = yield* RuntimeFlags.Service
          const profile = yield* Config.string("DEEPAGENT_CODE_ATTENTION_PROFILE").pipe(Config.withDefault(""))
          const workspaceID = yield* Config.string("DEEPAGENT_CODE_WORKSPACE_ID").pipe(Config.withDefault(""))
          const capability = Attention.localCapability({ profile, workspaceID, gateway: flags.gateway })
          if (!capability.enabled || (database.mode && (!database.mode.ready || database.mode.mode !== "ready")))
            return yield* new TaskHumanControlSchema.Error({
              code: "unavailable",
              message: "Private Task control requires the ready local attention profile",
            })
          const actor = {
            current: (sessionID: string) =>
              Effect.gen(function* () {
                if (!active() || !Server.privateLocalWritesAvailable()) return yield* denied()
                yield* sessions.requireWritable(SessionSchema.ID.make(sessionID)).pipe(
                  Effect.mapError(
                    () =>
                      new TaskHumanControlSchema.Error({
                        code: "unsupported",
                        message: "Private Task controls require an ordinary parent Session",
                      }),
                  ),
                )
                const parent = yield* database.db
                  .select({ id: SessionTable.id })
                  .from(SessionTable)
                  .where(
                    and(
                      eq(SessionTable.id, SessionSchema.ID.make(sessionID)),
                      eq(SessionTable.directory, directory),
                      isNull(SessionTable.workspace_id),
                    ),
                  )
                  .get()
                  .pipe(Effect.orDie)
                if (!parent || !active() || !Server.privateLocalWritesAvailable())
                  return yield* new TaskHumanControlSchema.Error({
                    code: "scope_changed",
                    message: "The Task parent no longer belongs to this worker directory",
                  })
                return { principal }
              }),
          }
          if (value.action === "control")
            return yield* TaskHumanControl.control(database.db, value.request).pipe(
              Effect.provideService(Attention.Access, capability),
              Effect.provideService(TaskHumanControl.Actor, actor),
            )
          const query = Schema.decodeUnknownOption(
            Schema.Struct({ itemID: TaskHumanControlSchema.Input.fields.itemID }),
            { onExcessProperty: "error" },
          )(value.request)
          if (query._tag === "None")
            return yield* new TaskHumanControlSchema.Error({
              code: "invalid_request",
              message: "Private Task read requires an exact item ID",
            })
          return yield* Effect.gen(function* () {
            const attention = yield* Attention.Service
            const item = yield* attention.get(query.value.itemID)
            if (!item.source.task || item.kind !== "task")
              return yield* new TaskHumanControlSchema.Error({
                code: "unsupported",
                message: "This channel only advertises original Task controls",
              })
            const allowed = yield* actor
              .current(item.source.task.parentSessionID)
              .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
            if (!active()) return yield* denied()
            return yield* attention.get(query.value.itemID).pipe(Effect.provideService(Attention.ActionAccess, allowed))
          }).pipe(
            Effect.provide(Attention.layer()),
            Effect.provideService(Attention.Access, capability),
            Effect.provideService(Attention.GoalActionAccess, false),
          )
        })
        const result = await AppRuntime.runPromise(Effect.result(operation), { signal: controller.signal })
        if (!state.active) return
        post(
          result._tag === "Success"
            ? { id, data: result.success }
            : {
                id,
                error:
                  result.failure instanceof TaskHumanControlSchema.Error
                    ? { code: result.failure.code, message: result.failure.message }
                    : { code: "unavailable", message: "The original Task source is unavailable" },
              },
        )
      })()
        .catch(() => {
          if (state.active)
            post({
              id,
              error: { code: "connection_unknown", message: "Private Task operation could not be confirmed" },
            })
        })
        .finally(() => {
          clearTimeout(deadline)
          controller.abort()
          requests.delete(id)
          post({ id, settled: true })
          finishClose()
        })
    })
    port.start()
    post({ ready: true, directory })
  })
  parentPort.postMessage({ kind: "task-human-bootstrap-ready-v1" })
}
