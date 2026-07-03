/**
 * D1H (S1-v3.7): Debug HTTP handler — DAP session routes.
 *
 * Delegates all operations to DebugService. The R0 privilege gate is
 * inside DebugService.start(); routes here are intentionally thin.
 *
 * SSE stream (/debug/events): subscribes to EventV2Bridge, filters to
 * debug.* event types, and optionally to a single sessionId.
 */
import * as InstanceState from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@deepagent-code/core/event"
import { DebugService } from "@/debug/service"
import { DebugAdapter } from "@/debug/adapter"
import { RuntimeBase } from "@/runtime/base"
import * as Log from "@deepagent-code/core/util/log"
import { Effect, Layer, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import path from "path"
import { InstanceHttpApi } from "../api"

const log = Log.create({ service: "debug.handler" })

function sseData(data: unknown): Sse.Event {
  return { _tag: "Event", event: "message", id: undefined, data: JSON.stringify(data) }
}

/** Debug event type names that we forward over the SSE stream. */
const DEBUG_EVENT_TYPES = new Set(["debug.stopped", "debug.output", "debug.terminated", "debug.updated"])

export const debugHandlers = HttpApiBuilder.group(InstanceHttpApi, "debug", (handlers) =>
  Effect.gen(function* () {
    const debug = yield* DebugService.Service
    const events = yield* EventV2Bridge.Service
    const base = yield* RuntimeBase.Service
    // V3.7 review P0-1: resolve adapters through the D2 registry (whitelist:
    // debugpy/delve/lldb/gdb …). NEVER treat the caller-supplied adapter string
    // as a command to spawn.
    const adapterRegistry = DebugAdapter.make()

    // ── start ─────────────────────────────────────────────────────────────────
    const start = Effect.fn("DebugHttpApi.start")(function* (ctx: {
      payload: {
        adapter: string
        program: string
        args?: readonly string[] | undefined
        cwd?: string | undefined
        sessionId?: string | undefined
      }
    }) {
      const { adapter, program, args, cwd, sessionId } = ctx.payload
      const directory = (yield* InstanceState.context).directory

      // V3.7 review P0-1 (RCE fix): resolve `adapter` against the registry by id.
      // Unknown ids are rejected — the caller can no longer spawn an arbitrary
      // binary via `command: adapter`. resolution.spec carries the REAL command,
      // args, and declared privileges.
      const resolution = adapterRegistry.resolveById(adapter)
      if (!resolution.available) {
        return { error: "adapter_unavailable" as const, message: resolution.message }
      }
      const spec = resolution.spec

      const resolvedCwd = cwd ?? directory
      const resolvedId = sessionId ?? crypto.randomUUID()
      const absProgram = path.isAbsolute(program) ? program : path.join(directory, program)

      // R0 isolation + gate: DebugService.start runs the privilege gate
      // (fail-closed) + approve-once internally. A human initiating start via
      // HTTP counts as approval (recorded, not re-prompted), but the privilege
      // probe (ptrace / perf_event / gpu counters declared by the adapter) still
      // hard-blocks unsupported platforms.
      const state = yield* base
        .withIsolation({ name: `debug-${spec.id}` }, (workdir) =>
          debug.start({
            spec,
            sessionId: resolvedId,
            launch: {
              program: absProgram,
              args: args ? [...args] : [],
              cwd: workdir,
            },
            cwd: workdir,
            requestApproval: () => Effect.void,
          }),
        )
        .pipe(Effect.orDie)

      return { sessionId: resolvedId, state }
    })

    // ── breakpoints ──────────────────────────────────────────────────────────
    const breakpoints = Effect.fn("DebugHttpApi.breakpoints")(function* (ctx: {
      payload: {
        sessionId: string
        file: string
        breakpoints: ReadonlyArray<{ line: number; condition?: string | undefined }>
      }
    }) {
      const directory = (yield* InstanceState.context).directory
      const source = path.isAbsolute(ctx.payload.file)
        ? ctx.payload.file
        : path.join(directory, ctx.payload.file)

      const state = yield* debug.setBreakpoints({
        sessionId: ctx.payload.sessionId,
        source,
        breakpoints: ctx.payload.breakpoints.map((b) => ({ line: b.line, condition: b.condition })),
      }).pipe(Effect.orDie)
      return { sessionId: ctx.payload.sessionId, state }
    })

    // ── continue ─────────────────────────────────────────────────────────────
    const continue_ = Effect.fn("DebugHttpApi.continue")(function* (ctx: {
      payload: { sessionId: string }
    }) {
      const state = yield* debug.continue(ctx.payload.sessionId).pipe(Effect.orDie)
      return { sessionId: ctx.payload.sessionId, state }
    })

    // ── step ─────────────────────────────────────────────────────────────────
    const step = Effect.fn("DebugHttpApi.step")(function* (ctx: {
      payload: { sessionId: string; kind: "next" | "stepIn" | "stepOut" }
    }) {
      const state = yield* debug.step(ctx.payload.sessionId, ctx.payload.kind).pipe(Effect.orDie)
      return { sessionId: ctx.payload.sessionId, state }
    })

    // ── stack ─────────────────────────────────────────────────────────────────
    const stack = Effect.fn("DebugHttpApi.stack")(function* (ctx: {
      query: { sessionId: string }
    }) {
      const frames = yield* debug.stackTrace(ctx.query.sessionId).pipe(Effect.orDie)
      return { frames }
    })

    // ── scopes ────────────────────────────────────────────────────────────────
    const scopes = Effect.fn("DebugHttpApi.scopes")(function* (ctx: {
      query: { sessionId: string; frameId: number }
    }) {
      const result = yield* debug.scopes(ctx.query.sessionId, ctx.query.frameId).pipe(Effect.orDie)
      return { scopes: result }
    })

    // ── variables ─────────────────────────────────────────────────────────────
    const variables = Effect.fn("DebugHttpApi.variables")(function* (ctx: {
      query: { sessionId: string; variablesReference: number }
    }) {
      const result = yield* debug.variables(ctx.query.sessionId, ctx.query.variablesReference).pipe(Effect.orDie)
      return { variables: result }
    })

    // ── evaluate ──────────────────────────────────────────────────────────────
    const evaluate = Effect.fn("DebugHttpApi.evaluate")(function* (ctx: {
      payload: { sessionId: string; expression: string; frameId?: number | undefined }
    }) {
      const result = yield* debug.evaluate({
        sessionId: ctx.payload.sessionId,
        expression: ctx.payload.expression,
        frameId: ctx.payload.frameId,
      }).pipe(Effect.orDie)
      return { result }
    })

    // ── terminate ─────────────────────────────────────────────────────────────
    const terminate = Effect.fn("DebugHttpApi.terminate")(function* (ctx: {
      payload: { sessionId: string }
    }) {
      const state = yield* debug.terminate(ctx.payload.sessionId).pipe(Effect.orDie)
      return { sessionId: ctx.payload.sessionId, state }
    })

    // ── sessions ──────────────────────────────────────────────────────────────
    const sessions = Effect.fn("DebugHttpApi.sessions")(function* () {
      const list = yield* debug.list()
      return { sessions: list }
    })

    // ── events (SSE) ──────────────────────────────────────────────────────────
    // Subscribes to the instance EventV2Bridge and forwards debug.* events,
    // optionally filtered to one sessionId, as a Server-Sent Events stream.
    const eventsHandler = Effect.fn("DebugHttpApi.events")(function* (ctx: {
      query: { sessionId?: string | undefined }
    }) {
      const instance = yield* InstanceState.context
      const filterSessionId = ctx.query.sessionId

      const queue = yield* Queue.unbounded<EventV2.Payload>()
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => Queue.offerUnsafe(queue, event)),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      const stream = Stream.fromQueue(queue).pipe(
        // Filter to the right instance
        Stream.filter((e) => e.location?.directory === instance.directory),
        // Only debug.* event types
        Stream.filter((e) => DEBUG_EVENT_TYPES.has(e.type)),
        // Optionally restrict to one session
        Stream.filter((e) => {
          if (!filterSessionId) return true
          const sid = (e.data as { sessionId?: string } | undefined)?.sessionId
          return sid === filterSessionId
        }),
        Stream.map((e) => sseData({ type: e.type, data: e.data })),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.sync(() => log.info("debug/events disconnected"))),
      )

      log.info("debug/events connected", { sessionId: filterSessionId })
      return HttpServerResponse.stream(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      })
    })

    return handlers
      .handle("start", start)
      .handle("breakpoints", breakpoints)
      .handle("continue", continue_)
      .handle("step", step)
      .handle("stack", stack)
      .handle("scopes", scopes)
      .handle("variables", variables)
      .handle("evaluate", evaluate)
      .handle("terminate", terminate)
      .handle("sessions", sessions)
      .handle("events", eventsHandler)
  }),
).pipe(
  Layer.provide(DebugService.layer),
  Layer.provide(RuntimeBase.layer),
)
