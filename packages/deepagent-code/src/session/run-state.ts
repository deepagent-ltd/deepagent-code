import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import type { Image } from "@/image/image"
import type { SessionPromptIntent } from "./prompt-intent"
import type { LegacyExecutionUnavailable } from "./legacy-execution-zero"

type RunError = Image.Error | SessionPromptIntent.Error | LegacyExecutionUnavailable

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  // V4.1 §S1.2: non-throwing busy probe for the steering ingress decision. Returns true iff a runner
  // for this session currently holds a live (busy) turn. The result is advisory — busy state can flip
  // between this read and a subsequent admit — so callers must handle the race (a steer admitted right
  // as the turn ends is still durably buffered and re-drained; see the ingress `promptOrSteer`).
  readonly isBusy: (sessionID: SessionID) => Effect.Effect<boolean>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  /** Cancels the session lane only while a shell holds it; a running/idle lane is untouched. */
  readonly cancelShell: (sessionID: SessionID) => Effect.Effect<void>
  /** True while the session lane is held by a shell (optionally with a queued run behind it). */
  readonly shellBusy: (sessionID: SessionID) => Effect.Effect<boolean>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts, RunError>,
    onRunning?: Effect.Effect<void>,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly startRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts, RunError>,
  ) => Effect.Effect<SessionV1.WithParts, RunError | Session.BusyError>
  readonly markFinalizing: (sessionID: SessionID) => Effect.Effect<void>
  readonly markRunning: (sessionID: SessionID) => Effect.Effect<void>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SessionRunState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<SessionV1.WithParts, RunError>>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: 16,
              discard: true,
            })
            runners.clear()
          }),
        )
        return { runners, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<SessionV1.WithParts, RunError>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) yield* busyError(sessionID)
    })

    const isBusy = Effect.fn("SessionRunState.isBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.runners.get(sessionID)?.busy ?? false
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      yield* cancelBackgroundJobs(background, sessionID)
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing) {
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      yield* existing.cancel
    })

    const cancelShell = Effect.fn("SessionRunState.cancelShell")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing) return
      yield* existing.cancelShell
    })

    const shellBusy = Effect.fn("SessionRunState.shellBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const tag = data.runners.get(sessionID)?.state._tag
      return tag === "Shell" || tag === "ShellThenRun"
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts, RunError>,
      onRunning?: Effect.Effect<void>,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt))
        .ensureRunning(work, onRunning)
        .pipe(Effect.catch(Effect.die))
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt))
        .startShell(work, ready)
        .pipe(
          Effect.catch((error) =>
            error instanceof Runner.Busy ? Effect.fail(busyError(sessionID)) : Effect.die(error),
          ),
        )
    })

    const startRunning = Effect.fn("SessionRunState.startRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts, RunError>,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt))
        .startRunning(work)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    const markFinalizing = Effect.fn("SessionRunState.markFinalizing")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) yield* existing.markFinalizing
    })

    const markRunning = Effect.fn("SessionRunState.markRunning")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) yield* existing.markRunning
    })

    return Service.of({
      assertNotBusy,
      isBusy,
      cancel,
      cancelShell,
      shellBusy,
      ensureRunning,
      startRunning,
      markFinalizing,
      markRunning,
      startShell,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: 16, discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export * as SessionRunState from "./run-state"
