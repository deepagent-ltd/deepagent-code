import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"
import * as Log from "@deepagent-code/core/util/log"
import { Process } from "@/util/process"
import { spawn as dapspawn } from "@/lsp/launch"
import { Schema } from "effect"
import { withTimeout } from "../util/timeout"
import type { AdapterSpec, DapEvent, DapMessage, DapResponse } from "./types"

/**
 * D1 (S1-v3.5): DAP (Debug Adapter Protocol) client.
 *
 * ISOMORPHIC to `lsp/client.ts`: spawn a process, talk a Content-Length-framed
 * JSON protocol over stdio, with request timeouts and graceful shutdown. DAP is
 * the same wire framing as LSP (Content-Length headers + JSON body), so we reuse
 * `vscode-jsonrpc`'s `StreamMessageReader`/`StreamMessageWriter` for the framing.
 * We do NOT use `createMessageConnection`, because that enforces JSON-RPC 2.0
 * semantics (`jsonrpc`/`id`), whereas DAP messages carry `seq`/`type`/`command`.
 * Sequencing (request_seq matching) is implemented here, deliberately thin.
 *
 * Architecture铁律: this is a protocol client only — every debugging primitive
 * (breakpoints, stepping, evaluation, stack/var inspection) is a request handed
 * to the adapter. There is zero self-written debugging logic here.
 */

const REQUEST_TIMEOUT_MS = 15_000
const INITIALIZE_TIMEOUT_MS = 30_000

const log = Log.create({ service: "debug.client" })

export type Info = NonNullable<Awaited<ReturnType<typeof create>>>

export class DapRequestError extends Schema.TaggedErrorClass<DapRequestError>()("DapRequestError", {
  command: Schema.String,
  message: Schema.String,
}) {}

export class InitializeError extends Schema.TaggedErrorClass<InitializeError>()("DapInitializeError", {
  adapterID: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export type EventHandler = (event: DapEvent) => void

/**
 * Spawn a debug adapter and bring up a DAP client over its stdio. Mirrors
 * `lsp/client.ts:create`: spawn, wire reader/writer, run the `initialize`
 * handshake, return an Info object with request/notify helpers + graceful
 * shutdown.
 */
export async function create(input: {
  /** The adapter to spawn (provided by D2). */
  spec: AdapterSpec
  /** Working directory for the adapter process (R0 worktree or main dir). */
  cwd: string
  /** Extra environment for the adapter process. */
  env?: Record<string, string>
}) {
  const logger = log.clone().tag("adapterID", input.spec.id)
  logger.info("starting dap client")

  if (input.spec.transport !== "stdio") {
    // D1 implements stdio (the common case for debugpy/delve/lldb). Socket
    // transport is reserved for D2+ and intentionally not silently downgraded.
    throw new InitializeError({
      adapterID: input.spec.id,
      cause: new Error(`transport "${input.spec.transport}" not supported by D1 (stdio only)`),
    })
  }

  const proc = dapspawn(input.spec.command, input.spec.args, {
    cwd: input.cwd,
    env: { ...process.env, ...input.env },
  })

  const reader = new StreamMessageReader(proc.stdout as any)
  const writer = new StreamMessageWriter(proc.stdin as any)

  proc.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trim()
    if (text) logger.debug("adapter stderr", { text: text.slice(0, 1000) })
  })

  // --- Connection state ---

  let seq = 1
  let closed = false
  const pending = new Map<number, { resolve: (r: DapResponse) => void; reject: (e: Error) => void; command: string }>()
  const eventHandlers = new Set<EventHandler>()

  const dispatch = (message: DapMessage) => {
    if (message.type === "response") {
      const entry = pending.get(message.request_seq)
      if (!entry) return
      pending.delete(message.request_seq)
      if (message.success) {
        entry.resolve(message)
      } else {
        entry.reject(new DapRequestError({ command: message.command, message: message.message ?? "request failed" }))
      }
      return
    }
    if (message.type === "event") {
      // Reverse requests (`runInTerminal`/`startDebugging`) arrive as type:"request"
      // FROM the adapter; we only consume events here. Fan out to subscribers
      // (DebugService bridges stopped/output/terminated to EventV2).
      for (const handler of [...eventHandlers]) {
        try {
          handler(message)
        } catch (err) {
          logger.warn("event handler threw", { error: String(err) })
        }
      }
    }
  }

  reader.listen((data) => dispatch(data as unknown as DapMessage))

  // --- DAP request primitive ---

  const sendRequest = <T = any>(command: string, args?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> => {
    if (closed) return Promise.reject(new DapRequestError({ command, message: "client is closed" }))
    const requestSeq = seq++
    const promise = new Promise<DapResponse>((resolve, reject) => {
      pending.set(requestSeq, { resolve, reject, command })
      writer.write({ seq: requestSeq, type: "request", command, arguments: args } as any).catch((err) => {
        pending.delete(requestSeq)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
    return withTimeout(promise, timeoutMs, `DAP request "${command}" timed out after ${timeoutMs}ms`)
      .then((response) => response.body as T)
      .catch((err) => {
        pending.delete(requestSeq)
        throw err
      })
  }

  // --- Initialize handshake ---

  logger.info("sending initialize")
  const capabilities = await withTimeout(
    sendRequest<Record<string, unknown>>(
      "initialize",
      {
        clientID: "deepagent-code",
        clientName: "DeepAgent Code",
        adapterID: input.spec.id,
        pathFormat: "path",
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsRunInTerminalRequest: false,
        locale: "en-US",
      },
      INITIALIZE_TIMEOUT_MS,
    ),
    INITIALIZE_TIMEOUT_MS,
  ).catch((err) => {
    logger.error("initialize error", { error: err })
    throw new InitializeError({ adapterID: input.spec.id, cause: err })
  })

  logger.info("initialized")

  // --- Public API ---

  const result = {
    get adapterID() {
      return input.spec.id
    },
    get capabilities() {
      return capabilities
    },
    get process() {
      return proc
    },
    /** Low-level escape hatch: send an arbitrary DAP request. */
    request: sendRequest,
    /** Subscribe to DAP events; returns an unsubscribe fn. */
    onEvent(handler: EventHandler) {
      eventHandlers.add(handler)
      return () => eventHandlers.delete(handler)
    },
    // —— Typed DAP requests (thin pass-throughs to the adapter) ——————————————
    launch: (args: Record<string, unknown>) => sendRequest("launch", args, INITIALIZE_TIMEOUT_MS),
    attach: (args: Record<string, unknown>) => sendRequest("attach", args, INITIALIZE_TIMEOUT_MS),
    configurationDone: () => sendRequest("configurationDone", {}),
    setBreakpoints: (args: {
      source: { path: string; name?: string }
      breakpoints: { line: number; condition?: string }[]
    }) => sendRequest("setBreakpoints", args),
    continue: (args: { threadId: number }) => sendRequest("continue", args),
    next: (args: { threadId: number }) => sendRequest("next", args),
    stepIn: (args: { threadId: number }) => sendRequest("stepIn", args),
    stepOut: (args: { threadId: number }) => sendRequest("stepOut", args),
    stackTrace: (args: { threadId: number; startFrame?: number; levels?: number }) => sendRequest("stackTrace", args),
    scopes: (args: { frameId: number }) => sendRequest("scopes", args),
    variables: (args: { variablesReference: number }) => sendRequest("variables", args),
    evaluate: (args: { expression: string; frameId?: number; context?: string }) => sendRequest("evaluate", args),
    threads: () => sendRequest("threads", {}),
    terminate: (args?: { restart?: boolean }) => sendRequest("terminate", args ?? {}),
    disconnect: (args?: { terminateDebuggee?: boolean }) => sendRequest("disconnect", args ?? {}),
    /** Graceful shutdown: disconnect, dispose streams, stop the process. */
    async shutdown() {
      if (closed) return
      closed = true
      logger.info("shutting down")
      // Best-effort polite disconnect; never let it block teardown.
      await withTimeout(sendRequestSilently("disconnect", { terminateDebuggee: true }), 2_000).catch(() => undefined)
      for (const [, entry] of pending) entry.reject(new DapRequestError({ command: entry.command, message: "client shutting down" }))
      pending.clear()
      eventHandlers.clear()
      try {
        reader.dispose()
        writer.dispose()
      } catch {
        // streams may already be torn down
      }
      await Process.stop(proc)
      logger.info("shutdown")
    },
  }

  // disconnect during shutdown must bypass the `closed` guard above.
  function sendRequestSilently(command: string, args?: unknown): Promise<void> {
    const requestSeq = seq++
    return new Promise<void>((resolve) => {
      pending.set(requestSeq, {
        resolve: () => resolve(),
        reject: () => resolve(),
        command,
      })
      writer.write({ seq: requestSeq, type: "request", command, arguments: args } as any).catch(() => resolve())
    })
  }

  return result
}

export * as DapClient from "./client"
