import { randomBytes, createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { isMainThread, MessagePort, parentPort } from "node:worker_threads"
import { Context, Effect, Schema } from "effect"
import { McpOperatorClient } from "@deepagent-code/core/mcp/operator-client"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { EffectBridge } from "@/effect/bridge"

const identity: unique symbol = Symbol("McpLocalOperator")
type Access = { readonly [identity]: true }
const accesses = new WeakMap<Access, { name: string; check: () => Promise<void> }>()
const Active = Context.Reference<Access | undefined>("~deepagent-code/McpLocalOperator", {
  defaultValue: () => undefined,
})
let installed = false
const nativeOperations = new Map<string, number>()
export const startupBlocked = (directory: string) => (nativeOperations.get(directory) ?? 0) > 0
let closeBridge: (() => Promise<void>) | undefined

const changed = () => new McpOperatorClient.RequestError("SCOPE_CHANGED", "The MCP interaction is no longer current")

/** Optional for existing authenticated HTTP/direct CLI callers; an arbitrary
 * object supplied as a reference is never a valid native operator capability. */
export const capture = Effect.gen(function* () {
  const access = yield* Active
  if (!access) return undefined
  const saved = accesses.get(access)
  if (!saved) return yield* Effect.fail(changed())
  return { check: () => saved.check() }
})
export const current = Effect.gen(function* () {
  const guard = yield* capture
  if (guard)
    yield* Effect.tryPromise({
      try: guard.check,
      catch: (error) => (error instanceof McpOperatorClient.RequestError ? error : changed()),
    })
})

export const requireTarget = Effect.fnUntraced(function* (name: string) {
  const access = yield* Active
  if (!access) return
  const saved = accesses.get(access)
  if (!saved || saved.name !== name) return yield* Effect.fail(changed())
  yield* current
})

export const closeTuiBridge = () => closeBridge?.() ?? Promise.resolve()

const observe = Effect.fnUntraced(function* (directory: string, name: string) {
  const { Config } = yield* Effect.promise(() => import("@/config/config"))
  const { AccountRepo } = yield* Effect.promise(() => import("@/account/repo"))
  const { Project } = yield* Effect.promise(() => import("@/project/project"))
  const { InstanceStore } = yield* Effect.promise(() => import("@/project/instance-store"))
  if ((yield* WorkspaceRef) !== undefined || (yield* Effect.promise(() => realpath(directory))) !== directory)
    return yield* Effect.fail(changed())
  const instances = yield* InstanceStore.Service
  const project = yield* (yield* Project.Service).observeDirectory(directory)
  const candidate = yield* instances.peek(directory)
  const observed = candidate?.project.id === project.project?.id ? candidate : undefined
  const config = yield* Config.Service
  if (!config.readonlySnapshot) return yield* Effect.fail(changed())
  const snapshot = yield* config.readonlySnapshot({ ...project, observed })
  const selected = snapshot.config.mcp?.[name]
  if (!selected || !("type" in selected))
    return yield* Effect.fail(
      new McpOperatorClient.RequestError("NOT_FOUND", "The configured MCP server is unavailable"),
    )
  const account = yield* (yield* AccountRepo.Service).authority()
  const fingerprint = createHash("sha256")
    .update(
      CanonicalJson.stringify({
        directory,
        source: snapshot.source,
        config: selected,
        account: account.account
          ? {
              id: account.account.id,
              url: account.account.url,
              generation: account.account.identity_generation,
            }
          : null,
        orgID: account.orgID,
        selectionRevision: account.selectionRevision,
      }),
    )
    .digest("hex")
  return { config: selected, fingerprint }
})

/** The only mint is this actual worker's parentPort. No public API or generic
 * RPC method creates Access; trusted in-process code is not sandboxed here. */
export async function installTuiBridge() {
  if (isMainThread || !parentPort || installed) throw new Error("MCP bridge requires its actual TUI worker parent")
  installed = true
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { Server } = await import("@/server/server")
  const { InstanceStore } = await import("@/project/instance-store")
  const directory = await realpath(process.cwd())
  parentPort.on("message", (message: unknown) => {
    if (
      !message ||
      typeof message !== "object" ||
      !("kind" in message) ||
      message.kind !== "mcp-operator-bootstrap-v1" ||
      !("port" in message) ||
      !(message.port instanceof MessagePort)
    )
      return
    const port = message.port
    if (closeBridge) {
      port.close()
      return
    }
    const state = { active: true, mutation: false, sequence: -1, closing: undefined as Promise<void> | undefined }
    const requests = new Map<number, { controller: AbortController; settled: Promise<void> }>()
    const tickets = new Map<
      string,
      {
        access: Access
        name: string
        fingerprint: string
        expiresAt: number
        active: boolean
        state?: string
        cancel?: () => Promise<void>
        cleanup?: Promise<void>
        timer: ReturnType<typeof setTimeout>
      }
    >()
    const post = (value: unknown) => {
      try {
        port.postMessage(value)
      } catch {
        void close()
      }
    }
    const release = async (key: string) => {
      const ticket = tickets.get(key)
      if (!ticket) return
      if (ticket.cleanup) return ticket.cleanup
      ticket.active = false
      clearTimeout(ticket.timer)
      ticket.cleanup = Promise.resolve()
        .then(() => ticket.cancel?.())
        .finally(() => tickets.delete(key))
      return ticket.cleanup
    }
    const close = (): Promise<void> => {
      if (state.closing) return state.closing
      state.active = false
      for (const request of requests.values()) request.controller.abort()
      const operation = (async () => {
        await Promise.allSettled([...tickets.keys()].map(release))
        await Promise.all([...requests.values()].map((request) => request.settled))
        post({ closed: true })
        port.close()
        if (closeBridge === close) closeBridge = undefined
      })()
      state.closing = operation
      return operation
    }
    closeBridge = close
    port.on("close", () => void close())
    port.on("message", (value: unknown) => {
      if (!value || typeof value !== "object") return
      if ("kind" in value && value.kind === "close") {
        void close()
        return
      }
      if (!state.active || !("id" in value) || typeof value.id !== "number" || !Number.isSafeInteger(value.id)) return
      if ("kind" in value && value.kind === "revoke") {
        requests.get(value.id)?.controller.abort()
        return
      }
      const id = value.id
      if (id <= state.sequence) {
        void close()
        return
      }
      state.sequence = id
      if (
        !("action" in value) ||
        !("request" in value) ||
        !("deadlineAt" in value) ||
        typeof value.deadlineAt !== "number" ||
        !Number.isSafeInteger(value.deadlineAt) ||
        value.deadlineAt <= Date.now() ||
        value.deadlineAt > Date.now() + McpOperatorClient.LIMIT_MS ||
        !["prepare", "send", "release"].includes(String(value.action)) ||
        requests.size >= 8 ||
        Buffer.byteLength(JSON.stringify(value)) > McpOperatorClient.REQUEST_BYTES
      ) {
        post({
          id,
          error: { code: "UNAVAILABLE", message: "Private MCP request is unavailable", unknownOutcome: false },
        })
        post({ id, settled: true })
        return
      }
      const action = value.action
      const controller = new AbortController()
      const deadlineAt = value.deadlineAt
      const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()))
      const operation = (async () => {
        if (action === "release") {
          const request = McpOperatorClient.decode(Schema.Struct({ ticket: McpOperatorClient.Ticket }), value.request)
          await release(request.ticket)
          return {}
        }
        if (action === "prepare") {
          const request = McpOperatorClient.decode(Schema.Struct({ name: McpOperatorClient.Name }), value.request)
          if (tickets.size >= 8)
            throw new McpOperatorClient.RequestError("CAPACITY", "Close an existing MCP interaction first")
          const observed = await AppRuntime.runPromise(observe(directory, request.name), { signal: controller.signal })
          if (!state.active || controller.signal.aborted) throw changed()
          const key = randomBytes(32).toString("hex")
          const access: Access = Object.freeze({ [identity]: true })
          const expiresAt = Date.now() + McpOperatorClient.LIMIT_MS
          const ticket = {
            access,
            name: request.name,
            fingerprint: observed.fingerprint,
            expiresAt,
            active: true,
            timer: setTimeout(() => {
              void release(key).catch(() => undefined)
            }, McpOperatorClient.LIMIT_MS),
          }
          tickets.set(key, ticket)
          accesses.set(access, {
            name: request.name,
            check: async () => {
              if (!state.active || !ticket.active || Date.now() >= expiresAt || !Server.privateLocalWritesAvailable())
                throw new McpOperatorClient.RequestError(
                  "SCOPE_CHANGED",
                  "MCP native interaction expired or listener authority changed",
                )
              const actual = await AppRuntime.runPromise(observe(directory, ticket.name))
              if (
                !state.active ||
                !ticket.active ||
                Date.now() >= expiresAt ||
                !Server.privateLocalWritesAvailable() ||
                actual.fingerprint !== ticket.fingerprint
              )
                throw new McpOperatorClient.RequestError(
                  "SCOPE_CHANGED",
                  "MCP configuration or account changed after preparation",
                )
            },
          })
          const config = observed.config
          const uri =
            config.type === "remote" && typeof config.oauth === "object" ? config.oauth.redirectUri : undefined
          const redirect = uri ? new URL(uri) : undefined
          return {
            ticket: key,
            name: request.name,
            type: config.type,
            target: config.type === "remote" ? new URL(config.url).origin : config.command[0].slice(0, 4096),
            oauth: config.type === "remote" && config.oauth !== false,
            manual:
              !!redirect &&
              (redirect.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(redirect.hostname)),
            expiresAt,
          } satisfies McpOperatorClient.Prepared
        }
        const command = McpOperatorClient.decode(McpOperatorClient.Command, value.request)
        const ticket = tickets.get(command.ticket)
        if (!ticket || state.mutation || (command.action === "finishAuth") !== !!command.callback)
          throw new McpOperatorClient.RequestError("SCOPE_CHANGED", "MCP ticket, action or callback does not match")
        state.mutation = true
        nativeOperations.set(directory, (nativeOperations.get(directory) ?? 0) + 1)
        const revoke = () => {
          ticket.active = false
        }
        controller.signal.addEventListener("abort", revoke, { once: true })
        try {
          await accesses.get(ticket.access)!.check()
          if (controller.signal.aborted) throw changed()
          const { MCP } = await import(".")
          const result = await AppRuntime.runPromise(
            Effect.gen(function* () {
              const instances = yield* InstanceStore.Service
              const instance = yield* instances.load({ directory })
              const bridge = yield* EffectBridge.make()
              const mcp = yield* MCP.Service
              const operation = Effect.gen(function* () {
                yield* current
                if (command.action === "connect") {
                  yield* mcp.connect(ticket.name)
                  return {}
                }
                if (command.action === "disconnect") {
                  yield* mcp.disconnect(ticket.name)
                  return {}
                }
                if (command.action === "clearAuth") {
                  yield* mcp.removeAuth(ticket.name)
                  return {}
                }
                if (command.action === "authenticate") {
                  yield* mcp.authenticate(ticket.name)
                  return {}
                }
                if (command.action === "startAuth") {
                  const result = yield* mcp.startAuth(ticket.name)
                  ticket.state = result.oauthState
                  ticket.cancel = () =>
                    bridge.promise(
                      (mcp.cancelLocalAuth
                        ? mcp.cancelLocalAuth(ticket.name, result.oauthState)
                        : Effect.die(changed())
                      ).pipe(Effect.provideService(InstanceRef, instance)),
                    )
                  return { authorizationUrl: result.authorizationUrl, oauthState: result.oauthState }
                }
                if (ticket.state !== command.callback!.oauthState) return yield* Effect.fail(changed())
                yield* mcp.finishAuth(
                  ticket.name,
                  command.callback!.code,
                  command.callback!.oauthState,
                  command.callback!.iss,
                )
                ticket.cancel = undefined
                return {}
              })
              return yield* operation.pipe(Effect.provideService(InstanceRef, instance))
            }).pipe(Effect.provideService(Active, ticket.access), Effect.provideService(WorkspaceRef, undefined)),
            { signal: controller.signal },
          )
          if (controller.signal.aborted || !state.active)
            throw new McpOperatorClient.RequestError("UNKNOWN", "MCP operation has no confirmed response", true)
          return result
        } finally {
          try {
            if (!ticket.active) await release(command.ticket)
          } finally {
            controller.signal.removeEventListener("abort", revoke)
            state.mutation = false
            const count = (nativeOperations.get(directory) ?? 1) - 1
            if (count === 0) nativeOperations.delete(directory)
            else nativeOperations.set(directory, count)
          }
        }
      })()
        .then((data) => {
          if (state.active) post({ id, data })
        })
        .catch((error: unknown) => {
          if (state.active)
            post({
              id,
              error:
                error instanceof McpOperatorClient.RequestError
                  ? { code: error.code, message: error.message, unknownOutcome: error.unknownOutcome }
                  : {
                      code: "UNAVAILABLE",
                      message: "MCP operation could not be confirmed; refresh its status",
                      unknownOutcome: action === "send",
                    },
            })
        })
        .finally(() => {
          clearTimeout(timer)
          requests.delete(id)
          post({ id, settled: true })
        })
      requests.set(id, { controller, settled: operation })
    })
    port.start()
    post({ ready: true, directory })
  })
  parentPort.postMessage({ kind: "mcp-operator-bootstrap-ready-v1" })
}

export * as McpLocalOperator from "./local-operator"
