import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@deepagent-code/core/event"
import * as Log from "@deepagent-code/core/util/log"
import { Context, Effect, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeBase } from "@/runtime/base"
import { DapClient } from "./client"
import type { AdapterSpec, DapEvent, SessionState, SessionStatus } from "./types"

const log = Log.create({ service: "debug.service" })

/**
 * D1 (S1-v3.5): `DebugService` — the DAP debug-session state machine.
 *
 * One session == one adapter process (a `DapClient`). Sessions are kept in a
 * map keyed by session id and are fully isolated. The session lifecycle is a
 * FINITE, SERIALIZABLE state machine:
 *
 *   initializing → initialized → configuring → running ⇄ stopped → terminated
 *                                                       ↘ exited / failed
 *
 * The serializable `SessionState` is what the frontend renders and what D4
 * writes to the debug-evidence artifact — it carries no live handles.
 *
 * DAP `stopped` / `output` / `terminated` events are bridged onto EventV2 (the
 * same link LSP events use), so the frontend observes a debug session exactly
 * like any other runtime stream.
 *
 * Architecture铁律: control-plane only. Every primitive (breakpoints, stepping,
 * eval, stack/var inspection) is a DAP request forwarded to the adapter; the
 * service only owns approval/gating, lifecycle, and event routing.
 */
export namespace DebugService {
  export const Event = {
    /** Program hit a breakpoint / step / exception and is paused. */
    Stopped: EventV2.define({
      type: "debug.stopped",
      schema: { sessionId: Schema.String, reason: Schema.String, threadId: Schema.optional(Schema.Number) },
    }),
    /** Adapter produced program/console output. */
    Output: EventV2.define({
      type: "debug.output",
      schema: { sessionId: Schema.String, category: Schema.String, output: Schema.String },
    }),
    /** Debuggee terminated. */
    Terminated: EventV2.define({
      type: "debug.terminated",
      schema: { sessionId: Schema.String },
    }),
    /** Generic session-state change, for frontend/audit observation. */
    Updated: EventV2.define({
      type: "debug.updated",
      schema: { sessionId: Schema.String, status: Schema.String },
    }),
  }

  export type StepKind = "next" | "stepIn" | "stepOut"

  export interface StartInput {
    /** Adapter to spawn (from D2's registry). */
    spec: AdapterSpec
    /** Caller-chosen session id; must be unique among live sessions. */
    sessionId: string
    /** "launch" config object (program/args/cwd…) passed straight to the adapter. */
    launch?: Record<string, unknown>
    /** "attach" config object; mutually exclusive with `launch`. */
    attach?: Record<string, unknown>
    /** Working directory for the adapter process (R0 worktree or main dir). */
    cwd?: string
    /** Extra env for the adapter process. */
    env?: Record<string, string>
    /**
     * Drives the tool's `ctx.ask`; called once on session start via R0's gate.
     * Tests pass a no-op. In-session sub-ops (step/continue/eval) reuse the grant.
     */
    requestApproval?: () => Effect.Effect<void>
  }

  export interface Interface {
    /** Start a session: gate (approve-once + privilege), spawn adapter, initialize + launch/attach + configurationDone. */
    readonly start: (input: StartInput) => Effect.Effect<SessionState, Error>
    /** Set breakpoints for a source file (delegated to the adapter). */
    readonly setBreakpoints: (input: {
      sessionId: string
      source: string
      breakpoints: { line: number; condition?: string }[]
    }) => Effect.Effect<SessionState, Error>
    /** Resume execution. */
    readonly continue: (sessionId: string) => Effect.Effect<SessionState, Error>
    /** Single-step (next/stepIn/stepOut). */
    readonly step: (sessionId: string, kind: StepKind) => Effect.Effect<SessionState, Error>
    /** Stack frames at the current stop (delegated; returns the adapter's frames). */
    readonly stackTrace: (sessionId: string) => Effect.Effect<any[], Error>
    /** Scopes for a frame (delegated). */
    readonly scopes: (sessionId: string, frameId: number) => Effect.Effect<any[], Error>
    /** Variables for a scope/variable reference (delegated). */
    readonly variables: (sessionId: string, variablesReference: number) => Effect.Effect<any[], Error>
    /** Evaluate an expression in a frame (delegated). */
    readonly evaluate: (input: {
      sessionId: string
      expression: string
      frameId?: number
      context?: string
    }) => Effect.Effect<any, Error>
    /** Terminate the session and tear down the adapter process. */
    readonly terminate: (sessionId: string) => Effect.Effect<SessionState, Error>
    /** Serializable snapshot of one session. */
    readonly get: (sessionId: string) => Effect.Effect<SessionState | undefined>
    /** Serializable snapshots of all live sessions. */
    readonly list: () => Effect.Effect<SessionState[]>
  }

  export class Service extends Context.Service<Service, Interface>()("@deepagent-code/DebugService") {}

  interface Session {
    client: DapClient.Info
    state: SessionState
    /** One-shot event waiters keyed by DAP event name. */
    waiters: Map<string, Array<(event: DapEvent) => void>>
    unsubscribe: () => void
  }

  interface State {
    sessions: Map<string, Session>
    /** Instance context captured at first use; events publish with this location. */
    instance: import("@/project/instance-context").InstanceContext
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const base = yield* RuntimeBase.Service
      const events = yield* EventV2Bridge.Service

      const state = yield* InstanceState.make<State>(
        Effect.fnUntraced(function* (instance) {
          const s: State = { sessions: new Map(), instance }
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              await Promise.all([...s.sessions.values()].map((session) => session.client.shutdown().catch(() => {})))
              s.sessions.clear()
            }),
          )
          return s
        }),
      )

      // —— EventV2 bridging (runs from the adapter's stdio callback) —————————————
      // Events are published from a Node stdio callback (outside the Effect run
      // loop), so we fork them onto the runtime with the captured instance
      // location, exactly like LSP events flow through the EventV2 bridge.
      const publish = (instance: State["instance"], effect: Effect.Effect<unknown, never, any>) =>
        Effect.runFork(effect.pipe(Effect.provideService(InstanceRef, instance)) as Effect.Effect<unknown>)

      const now = () => Date.now()

      const transition = (session: Session, instance: State["instance"], patch: Partial<SessionState>): SessionState => {
        session.state = { ...session.state, ...patch, updatedAt: now() }
        publish(instance, events.publish(Event.Updated, { sessionId: session.state.id, status: session.state.status }))
        return session.state
      }

      const onAdapterEvent = (session: Session, instance: State["instance"]) => (event: DapEvent) => {
        // Resolve any one-shot waiters first (start() awaits "initialized").
        const waiters = session.waiters.get(event.event)
        if (waiters?.length) {
          session.waiters.set(event.event, [])
          for (const w of waiters) w(event)
        }
        switch (event.event) {
          case "stopped": {
            const reason = (event.body?.reason as string) ?? "unknown"
            const threadId = event.body?.threadId as number | undefined
            transition(session, instance, { status: "stopped", stoppedReason: reason, threadId })
            publish(instance, events.publish(Event.Stopped, { sessionId: session.state.id, reason, threadId }))
            break
          }
          case "continued": {
            // Some adapters emit `continued`; reflect running unless already terminal.
            if (session.state.status === "stopped") transition(session, instance, { status: "running" })
            break
          }
          case "output": {
            const category = (event.body?.category as string) ?? "console"
            const output = (event.body?.output as string) ?? ""
            publish(instance, events.publish(Event.Output, { sessionId: session.state.id, category, output }))
            break
          }
          case "terminated": {
            transition(session, instance, { status: "terminated" })
            publish(instance, events.publish(Event.Terminated, { sessionId: session.state.id }))
            break
          }
          case "exited": {
            const exitCode = event.body?.exitCode as number | undefined
            transition(session, instance, { status: "exited", ...(exitCode === undefined ? {} : { exitCode }) })
            break
          }
          default:
            break
        }
      }

      // Register a one-shot waiter for a DAP event and return the Promise
      // EAGERLY (synchronously). The waiter must be registered before the
      // request that triggers the event is sent, otherwise the event races
      // ahead of the subscription. The returned promise is awaited via Effect.
      const registerWaiter = (session: Session, name: string, timeoutMs: number): Promise<DapEvent | undefined> =>
        new Promise<DapEvent | undefined>((resolve) => {
          const list = session.waiters.get(name) ?? []
          list.push(resolve)
          session.waiters.set(name, list)
          // Resolve undefined on timeout rather than reject — a missing
          // `initialized` is non-fatal (some adapters skip configurationDone).
          setTimeout(() => resolve(undefined), timeoutMs)
        })

      const getSession = (sessionId: string) =>
        Effect.gen(function* () {
          const s = yield* InstanceState.get(state)
          const session = s.sessions.get(sessionId)
          if (!session) return yield* Effect.fail(new Error(`no debug session "${sessionId}"`))
          return session
        })

      const requireThread = (session: Session) => {
        if (session.state.threadId === undefined) {
          return Effect.fail(new Error(`session "${session.state.id}" is not stopped on a thread`))
        }
        return Effect.succeed(session.state.threadId)
      }

      const start: Interface["start"] = (input) =>
        Effect.gen(function* () {
          const s = yield* InstanceState.get(state)
          if (s.sessions.has(input.sessionId)) {
            return yield* Effect.fail(new Error(`debug session "${input.sessionId}" already exists`))
          }

          // R0 gate: privilege fail-closed first, then approve-once-per-session.
          yield* base
            .gate({
              sessionKey: input.sessionId,
              privileges: input.spec.privileges,
              requestApproval: input.requestApproval ?? (() => Effect.void),
            })
            .pipe(Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))))

          const cwd = input.cwd ?? s.instance.directory

          const client = yield* Effect.tryPromise({
            try: () => DapClient.create({ spec: input.spec, cwd, env: input.env }),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          })

          const initial: SessionState = {
            id: input.sessionId,
            adapterId: input.spec.id,
            status: "initialized",
            breakpoints: [],
            workdir: cwd,
            createdAt: now(),
            updatedAt: now(),
          }
          const session: Session = {
            client,
            state: initial,
            waiters: new Map(),
            unsubscribe: () => {},
          }
          session.unsubscribe = client.onEvent(onAdapterEvent(session, s.instance))
          s.sessions.set(input.sessionId, session)

          // launch/attach → wait for `initialized` event → configurationDone.
          // Per DAP: the adapter signals readiness for configuration with the
          // `initialized` event; configurationDone unblocks it to run.
          transition(session, s.instance, { status: "configuring" })
          // Register the waiter BEFORE sending launch so we never miss the event.
          const initializedEvent = registerWaiter(session, "initialized", 20_000)
          yield* Effect.tryPromise({
            try: () =>
              input.attach ? client.attach(input.attach) : client.launch(input.launch ?? {}),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          })
          // Wait for `initialized` (best-effort; undefined on timeout).
          yield* Effect.promise(() => initializedEvent)
          yield* Effect.tryPromise({
            try: () => client.configurationDone(),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }).pipe(Effect.catch(() => Effect.void))

          // If a stopped event already arrived during the handshake, keep it;
          // otherwise the program is running.
          if (session.state.status === "configuring") transition(session, s.instance, { status: "running" })
          return session.state
        }).pipe(
          Effect.tapCause((cause) => Effect.sync(() => log.warn("debug start failed", { cause: String(cause) }))),
        )

      const setBreakpoints: Interface["setBreakpoints"] = (input) =>
        Effect.gen(function* () {
          const s = yield* InstanceState.get(state)
          const session = yield* getSession(input.sessionId)
          yield* Effect.tryPromise({
            try: () =>
              session.client.setBreakpoints({
                source: { path: input.source },
                breakpoints: input.breakpoints,
              }),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          })
          const others = session.state.breakpoints.filter((b) => b.source !== input.source)
          return transition(session, s.instance, {
            breakpoints: [...others, { source: input.source, lines: input.breakpoints.map((b) => b.line) }],
          })
        })

      const resume = (sessionId: string, kind: "continue" | StepKind) =>
        Effect.gen(function* () {
          const s = yield* InstanceState.get(state)
          const session = yield* getSession(sessionId)
          const threadId = yield* requireThread(session)
          yield* Effect.tryPromise({
            try: () =>
              kind === "continue"
                ? session.client.continue({ threadId })
                : session.client[kind]({ threadId }),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          })
          // Optimistically mark running; a subsequent `stopped` event flips it back.
          return transition(session, s.instance, { status: "running", threadId: undefined, stoppedReason: undefined })
        })

      const continue_: Interface["continue"] = (sessionId) => resume(sessionId, "continue")
      const step: Interface["step"] = (sessionId, kind) => resume(sessionId, kind)

      const delegated = <T>(sessionId: string, fn: (client: DapClient.Info) => Promise<T>) =>
        Effect.gen(function* () {
          const session = yield* getSession(sessionId)
          return yield* Effect.tryPromise({
            try: () => fn(session.client),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          })
        })

      const stackTrace: Interface["stackTrace"] = (sessionId) =>
        Effect.gen(function* () {
          const session = yield* getSession(sessionId)
          const threadId = yield* requireThread(session)
          const body = yield* Effect.tryPromise({
            try: () => session.client.stackTrace({ threadId }),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          })
          return (body?.stackFrames as any[]) ?? []
        })

      const scopes: Interface["scopes"] = (sessionId, frameId) =>
        delegated(sessionId, (c) => c.scopes({ frameId })).pipe(Effect.map((b) => (b?.scopes as any[]) ?? []))

      const variables: Interface["variables"] = (sessionId, variablesReference) =>
        delegated(sessionId, (c) => c.variables({ variablesReference })).pipe(
          Effect.map((b) => (b?.variables as any[]) ?? []),
        )

      const evaluate: Interface["evaluate"] = (input) =>
        delegated(input.sessionId, (c) =>
          c.evaluate({ expression: input.expression, frameId: input.frameId, context: input.context ?? "repl" }),
        )

      const terminate: Interface["terminate"] = (sessionId) =>
        Effect.gen(function* () {
          const s = yield* InstanceState.get(state)
          const session = s.sessions.get(sessionId)
          if (!session) return yield* Effect.fail(new Error(`no debug session "${sessionId}"`))
          session.unsubscribe()
          yield* Effect.promise(() => session.client.shutdown().catch(() => {}))
          const final = transition(session, s.instance, { status: "terminated" })
          s.sessions.delete(sessionId)
          return final
        })

      const get: Interface["get"] = (sessionId) =>
        InstanceState.get(state).pipe(Effect.map((s) => s.sessions.get(sessionId)?.state))

      const list: Interface["list"] = () =>
        InstanceState.get(state).pipe(Effect.map((s) => [...s.sessions.values()].map((x) => x.state)))

      return Service.of({
        start,
        setBreakpoints,
        continue: continue_,
        step,
        stackTrace,
        scopes,
        variables,
        evaluate,
        terminate,
        get,
        list,
      })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(RuntimeBase.layer),
    Layer.provide(EventV2Bridge.defaultLayer),
  )
}

export * as Debug from "./service"
