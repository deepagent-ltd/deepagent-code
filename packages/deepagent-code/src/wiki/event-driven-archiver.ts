export * as EventDrivenArchiver from "./event-driven-archiver"

import { Context, Deferred, Effect, Layer, Stream, Schedule, Duration, Cause } from "effect"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { archiveSessionOnCompletion } from "./session-archive"
import * as Log from "@deepagent-code/core/util/log"

// V4.0 §L — the EVENT-DRIVEN execution archiver. V3.9 archived a session inline from the
// session-completion hook (`archiveSessionOnCompletion`, still intact). V4.0's §L enhancement moves the
// TRIGGER to the Event Bus: this service subscribes to `session.completed` / `goal.completed` domain
// events and archives in response, so archival is decoupled from the session loop (survives across
// workers, replayable, observable). It ADDS NO archival mechanics — it reuses the exact V3.9
// `archiveSessionOnCompletion` projection (no new source of truth, §B.1).
//
// Gated by v4EventDrivenIm upstream? No — archival is a §L capability independent of IM; the wiring
// only starts this consumer when the event-driven path is desired. It is idempotent and best-effort
// (archiveSessionOnCompletion never throws), so double-delivery just re-projects the same archive.
//
// LAYERING: `deepagent-code`. Bridges the bus (core) to the archiver (deepagent-code).

const log = Log.create({ service: "event-driven-archiver" })

export const ARCHIVE_GROUP = "wiki-archiver"
// §A3 retry-pump cadence for the archiver's own consumer group (mirrors EventDispatcher's pump).
export const DEFAULT_RETRY_PUMP_INTERVAL_MS = 30_000

// The archive-relevant fields a trigger event must carry in its payload.
interface ArchivePayload {
  readonly sessionID?: string
  readonly workspacePath?: string
}

export interface Interface {
  /**
   * Handle ONE archive-trigger event: if it's a session.completed/goal.completed carrying a sessionID
   * + workspacePath, archive the session's execution trajectory as a Wiki page. Returns whether an
   * archive was produced. Exposed for deterministic testing; the background subscription calls it.
   */
  readonly handle: (event: DeepAgentEvent.Event) => Effect.Effect<boolean>
  /**
   * §A3 retry pump for THIS group ("wiki-archiver"). Re-drives pending deliveries whose backoff elapsed
   * (an archive that failed or a crash-orphaned delivery), reloading the event and re-running handle.
   * Without this, a grouped subscriber's pending rows are never discharged. Exposed for testing; the
   * background loop calls it on a cadence.
   */
  readonly pumpRetries: (now?: number) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/EventDrivenArchiver") {}

export interface LayerOptions {
  // start the background bus subscription + retry pump as scoped daemons. Default true; tests set false
  // and call handle()/pumpRetries() directly.
  readonly runLoop?: boolean
  readonly retryPumpIntervalMs?: number
  readonly now?: () => number
}

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const runLoop = options?.runLoop ?? true
      const retryPumpIntervalMs = options?.retryPumpIntervalMs ?? DEFAULT_RETRY_PUMP_INTERVAL_MS

      const ack = (event: DeepAgentEvent.Event) => bus.ack(ARCHIVE_GROUP, event.id)

      // handle ONE event and DISCHARGE its delivery (this group is delivery-tracked, so every event
      // MUST be acked or nacked — an unresolved pending row leaks + breaks at-least-once). Returns
      // whether an archive was produced. Non-triggers and malformed triggers are terminal → ack (they
      // are not this group's work / are unarchivable, not transient). An archive that THREW is
      // transient → nack for retry via the pump. `archiveSessionOnCompletion` is best-effort (returns
      // null, never throws) so a null archive is a successful no-op → ack.
      const handle: Interface["handle"] = (event) =>
        Effect.gen(function* () {
          if (!LMNEvents.isArchiveTrigger(event.type)) {
            yield* ack(event) // not our concern (group receives all events) — discharge it.
            return false
          }
          const payload = (event.payload ?? {}) as ArchivePayload
          const sessionID = payload.sessionID
          const workspacePath = payload.workspacePath
          if (!sessionID || !workspacePath) {
            log.warn("archive trigger missing sessionID/workspacePath", { eventID: event.id, type: event.type })
            yield* ack(event) // unarchivable, terminal — acking avoids an un-fixable retry loop.
            return false
          }
          const outcome = yield* archiveSessionOnCompletion({ workspacePath, sessionID }).pipe(
            Effect.map((archive) => ({ ok: true as const, archive })),
            Effect.catchCause((cause) => Effect.succeed({ ok: false as const, cause })),
          )
          if (!outcome.ok) {
            log.error("archive failed; nacking for retry", { sessionID, cause: Cause.pretty(outcome.cause) })
            yield* bus.nack({ subscriptionGroup: ARCHIVE_GROUP, eventID: event.id, reason: "archive failed" })
            return false
          }
          if (outcome.archive)
            log.info("archived session execution trajectory", { sessionID, entries: outcome.archive.entries.length })
          yield* ack(event) // success (incl. idempotent null = nothing to archive).
          return outcome.archive != null
        })

      const pumpRetries: Interface["pumpRetries"] = (now) =>
        Effect.gen(function* () {
          const due = yield* bus.dueRetries(now)
          let redriven = 0
          for (const delivery of due) {
            if (delivery.subscriptionGroup !== ARCHIVE_GROUP) continue // only OUR group's deliveries.
            const event = yield* bus.getByID(delivery.eventID)
            if (!event) {
              log.warn("retry: event missing for pending archive delivery", { eventID: delivery.eventID })
              continue
            }
            yield* handle(event) // re-runs the full ack/nack cycle.
            redriven++
          }
          return redriven
        })

      if (runLoop) {
        yield* bus.registerConsumerGroup(ARCHIVE_GROUP)
        const ready = yield* Deferred.make<void>()
        yield* bus
          .subscribe({ group: ARCHIVE_GROUP })
          .pipe(
            Stream.onStart(Deferred.succeed(ready, undefined)),
            Stream.runForEach((event) =>
              handle(event).pipe(
                Effect.catchCause((cause) =>
                  Effect.sync(() => log.error("archive handle failed", { cause: Cause.pretty(cause) })),
                ),
                Effect.asVoid,
              ),
            ),
            Effect.forkScoped,
          )
        yield* Deferred.await(ready)

        yield* pumpRetries()
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => log.error("archive retry pump failed", { cause: Cause.pretty(cause) })).pipe(Effect.as(0)),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(retryPumpIntervalMs))),
            Effect.forkScoped,
          )
      }

      return Service.of({ handle, pumpRetries })
    }),
  )

export const layer = layerWith()
