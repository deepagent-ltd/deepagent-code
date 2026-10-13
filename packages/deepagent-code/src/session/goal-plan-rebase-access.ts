export * as GoalPlanRebaseAccess from "./goal-plan-rebase-access"

import { Effect, Redacted } from "effect"
import type { HttpServerRequest } from "effect/unstable/http"
import { Server } from "@/server/server"
import { ServerAuth } from "@/server/auth"
import { CorsConfig } from "@/server/cors"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { GoalPlanRebaseSchema } from "@deepagent-code/core/deepagent/goal-plan-rebase.schema"
import { MessagePort, parentPort, isMainThread } from "node:worker_threads"
import { realpath } from "node:fs/promises"
import { Schema } from "effect"

const identity: unique symbol = Symbol("GoalPlanRebaseAccess")
export type Access = { readonly [identity]: true }
const accesses = new WeakMap<
  Access,
  { config: ServerAuth.Info; credentials: ServerAuth.DecodedCredentials; fingerprint: string }
>()
type Placement = { sessionID: string; goalID: string; directory: string; workspaceID?: string }
const localAccesses = new WeakMap<
  Access,
  { active: () => boolean; mutation: boolean; directory: string; sessionID: string; goalID: string }
>()
let closeWorkerBridge: (() => void) | undefined
let workerInstalled = false
const denied = () =>
  new GoalPlanRebaseSchema.Error({
    code: "AUTH_REQUIRED",
    message: "Plan edits require current authenticated operator access and an exact request origin",
  })

/** This adapter consumes the real server request. Neither a JSON identity nor a localhost name mints access. */
export const authenticate = (config: ServerAuth.Info, request: HttpServerRequest.HttpServerRequest) =>
  authenticateRequest(config, request, [])

/** The actual host listener supplies explicit browser origins. CORS conveniences
 * (localhost prefixes and product domains) cannot mint mutation authority. */
export const authenticateOperator = (config: ServerAuth.Info, request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const policy = yield* CorsConfig
    return yield* authenticateRequest(config, request, ["oc://renderer", ...(policy?.cors ?? [])])
  })

function authenticateRequest(
  config: ServerAuth.Info,
  request: HttpServerRequest.HttpServerRequest,
  origins: ReadonlyArray<string>,
) {
  return Effect.try({
    try: () => {
      if (!ServerAuth.required(config)) throw denied()
      const header = request.headers.authorization
      if (!header?.startsWith("Basic ")) throw denied()
      const encoded = header.slice(6)
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 4096) throw denied()
      const decoded = Buffer.from(encoded, "base64").toString("utf8")
      if (Buffer.from(decoded).toString("base64") !== encoded || !decoded.includes(":")) throw denied()
      const split = decoded.indexOf(":")
      const credentials = { username: decoded.slice(0, split), password: Redacted.make(decoded.slice(split + 1)) }
      if (!ServerAuth.authorized(credentials, config)) throw denied()
      const host = request.headers.host
      if (!host || /[\s,/@\\]/.test(host)) throw denied()
      // Node's originalUrl is a relative request target. Its actual socket,
      // rather than forwarded headers, determines the same-origin scheme.
      const socket = "socket" in request.source ? request.source.socket : undefined
      const secure = socket !== null && typeof socket === "object" && "encrypted" in socket && socket.encrypted === true
      const target = new URL(request.originalUrl, `${secure ? "https" : "http"}://${host}`)
      if (target.host !== host || target.searchParams.has("auth_token")) throw denied()
      const origin = request.headers.origin
      if (origin !== undefined && origin !== target.origin && !origins.includes(origin)) throw denied()
      const access: Access = Object.freeze({ [identity]: true })
      accesses.set(access, {
        config,
        credentials,
        fingerprint: GoalControl.fingerprint({ username: config.username, password: config.password }),
      })
      return access
    },
    catch: denied,
  })
}

export const current = (access: Access, placement?: Placement) =>
  Effect.sync(() => {
    const local = localAccesses.get(access)
    if (local)
      return local.active() &&
        (!local.mutation || Server.privateGoalWritesAvailable()) &&
        (!placement ||
          (placement.sessionID === local.sessionID &&
            placement.goalID === local.goalID &&
            placement.directory === local.directory &&
            placement.workspaceID === undefined))
        ? true
        : undefined
    return accesses.get(access)
  }).pipe(
    Effect.flatMap((saved) =>
      saved === true ||
      (saved &&
        ServerAuth.required(saved.config) &&
        ServerAuth.authorized(saved.credentials, saved.config) &&
        saved.fingerprint ===
          GoalControl.fingerprint({ username: saved.config.username, password: saved.config.password }))
        ? Effect.void
        : Effect.fail(
            new GoalPlanRebaseSchema.Error({
              code: "AUTH_CHANGED",
              message: "Plan edit operator authority is no longer current",
            }),
          ),
    ),
  )

export const closeTuiBridge = () => closeWorkerBridge?.()

/** The only local mint is inside a listener on this process's real parentPort.
 * HTTP, generic RPC.fetch, serialized identities and newly constructed local ports
 * have no callable mint. This is an OS-process boundary, not a sandbox against
 * malicious code already executing inside the trusted worker process. */
export async function installTuiBridge() {
  if (isMainThread || !parentPort) throw new Error("Private Goal bridge requires the actual TUI worker parent")
  if (workerInstalled) throw new Error("Private Goal bootstrap is already installed")
  workerInstalled = true
  const directory = await realpath(process.cwd())
  parentPort.on("message", (message: unknown) => {
    if (
      !message ||
      typeof message !== "object" ||
      !("kind" in message) ||
      message.kind !== "goal-plan-bootstrap-v1" ||
      !("port" in message) ||
      !(message.port instanceof MessagePort)
    )
      return
    const port = message.port
    if (closeWorkerBridge) {
      port.close()
      return
    }
    const state = { active: true, pending: 0 }
    const requests = new Map<number, AbortController>()
    const post = (value: unknown) => {
      try {
        port.postMessage(value)
      } catch {
        close()
      }
    }
    const finishClose = () => {
      if (state.active || state.pending) return
      post({ closed: true })
      port.close()
      if (closeWorkerBridge === close) closeWorkerBridge = undefined
    }
    const close = () => {
      if (!state.active) return
      state.active = false
      for (const request of requests.values()) request.abort()
      finishClose()
    }
    closeWorkerBridge = close
    port.on("close", close)
    port.on("message", (value: unknown) => {
      if (!value || typeof value !== "object") return
      if ("kind" in value && value.kind === "close") {
        close()
        return
      }
      if (!state.active || !("id" in value) || typeof value.id !== "number" || !Number.isSafeInteger(value.id)) return
      if ("kind" in value && value.kind === "revoke") {
        requests.get(value.id)?.abort()
        return
      }
      const id = value.id
      if (requests.has(id)) {
        close()
        return
      }
      if (
        !("action" in value) ||
        !("request" in value) ||
        !("deadlineAt" in value) ||
        typeof value.deadlineAt !== "number" ||
        !Number.isSafeInteger(value.deadlineAt) ||
        value.deadlineAt <= Date.now() ||
        value.deadlineAt > Date.now() + 30000 ||
        !["begin", "get", "apply", "cancel", "reconcile"].includes(String(value.action)) ||
        state.pending >= 8
      ) {
        post({ id, error: { code: "UNAVAILABLE", message: "Private Goal operation is unavailable" } })
        post({ id, settled: true })
        return
      }
      const deadlineAt = value.deadlineAt
      const action = value.action
      state.pending++
      const controller = new AbortController()
      requests.set(id, controller)
      // Native parent request expiry is an authority boundary, not proof that file effects
      // were rolled back. The current guard also checks time before every file effect.
      const deadline = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()))
      void (async () => {
        const schema =
          action === "begin"
            ? GoalPlanRebaseSchema.Begin
            : action === "apply"
              ? GoalPlanRebaseSchema.Apply
              : action === "get"
                ? Schema.Struct({
                    sessionID: GoalPlanRebaseSchema.Identity,
                    goalID: GoalPlanRebaseSchema.Identity,
                    editID: GoalPlanRebaseSchema.Ref,
                    requestID: GoalPlanRebaseSchema.Ref,
                  })
                : GoalPlanRebaseSchema.Target
        const request = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value.request)
        if (
          !state.active ||
          controller.signal.aborted ||
          Date.now() >= deadlineAt ||
          (action !== "get" && !Server.privateGoalWritesAvailable())
        )
          throw denied()
        const access: Access = Object.freeze({ [identity]: true })
        localAccesses.set(access, {
          active: () => state.active && !controller.signal.aborted && Date.now() < deadlineAt,
          mutation: action !== "get",
          directory,
          sessionID: request.sessionID,
          goalID: request.goalID,
        })
        const { GoalPlanRebaseHost } = await import("./goal-plan-rebase")
        const { AppRuntime } = await import("@/effect/app-runtime")
        const operation =
          action === "begin"
            ? GoalPlanRebaseHost.begin(Schema.decodeUnknownSync(GoalPlanRebaseSchema.Begin)(request), access)
            : action === "apply"
              ? GoalPlanRebaseHost.apply(Schema.decodeUnknownSync(GoalPlanRebaseSchema.Apply)(request), access)
              : action === "get"
                ? GoalPlanRebaseHost.get(
                    Schema.decodeUnknownSync(
                      Schema.Struct({
                        sessionID: GoalPlanRebaseSchema.Identity,
                        goalID: GoalPlanRebaseSchema.Identity,
                        editID: GoalPlanRebaseSchema.Ref,
                        requestID: GoalPlanRebaseSchema.Ref,
                      }),
                    )(request),
                    access,
                  )
                : action === "cancel"
                  ? GoalPlanRebaseHost.cancel(Schema.decodeUnknownSync(GoalPlanRebaseSchema.Target)(request), access)
                  : GoalPlanRebaseHost.reconcile(Schema.decodeUnknownSync(GoalPlanRebaseSchema.Target)(request), access)
        const result = await AppRuntime.runPromise(Effect.result(operation), { signal: controller.signal })
        if (!state.active) return
        post(
          result._tag === "Success"
            ? { id, data: result.success }
            : { id, error: { code: result.failure.code, message: result.failure.message } },
        )
      })()
        .catch((error: unknown) => {
          if (state.active)
            post({
              id,
              error:
                error instanceof GoalPlanRebaseSchema.Error
                  ? { code: error.code, message: error.message }
                  : { code: "UNAVAILABLE", message: "Private Goal operation could not be confirmed" },
            })
        })
        .finally(() => {
          clearTimeout(deadline)
          controller.abort()
          state.pending--
          requests.delete(id)
          post({ id, settled: true })
          finishClose()
        })
    })
    port.start()
    post({ ready: true, directory })
  })
  parentPort.postMessage({ kind: "goal-plan-bootstrap-ready-v1" })
}
