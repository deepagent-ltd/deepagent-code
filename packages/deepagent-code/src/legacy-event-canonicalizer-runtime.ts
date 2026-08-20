export * as LegacyEventCanonicalizerRuntime from "./legacy-event-canonicalizer-runtime"

import { EventV2 } from "@deepagent-code/core/event"
import { Cause, Duration, Effect, Layer, Schedule } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"

// RISK-003 ④ (BUG-407-010 legacy data governance): durable automated schedule for the legacy
// event canonicalizer. The canonicalizer itself is already implemented and wired
// (core event.ts `canonicalizeLegacyArtifacts` + the sync `artifacts` maintenance endpoint);
// what was missing is an automated schedule, so backlog convergence depended on a client manually
// driving the maintenance endpoint. This daemon closes that gap with a conservative loop:
//   - flag-gated (RuntimeFlags.legacyEventCanonicalizer), DEFAULT OFF
//   - bounded batches (a few events per tick) on a spaced interval
//   - failures only log a warning; the loop never blocks a turn
//   - evidence-only: it canonicalizes oversized legacy payloads into event_artifact rows and
//     NEVER deletes events or VACUUMs (those remain gated human-runbook steps, bug-407-010 §14).
const defaultPollInterval = Duration.minutes(5)
const defaultMaxEventsPerTick = 16

export const makeLayer = (options?: {
  readonly pollInterval?: Duration.Duration
  readonly maxEventsPerTick?: number
}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      if (!flags.legacyEventCanonicalizer) return
      const events = yield* EventV2.Service
      const pollInterval = options?.pollInterval ?? defaultPollInterval
      const maxEventsPerTick = Math.max(1, options?.maxEventsPerTick ?? defaultMaxEventsPerTick)
      // The stateless scan resumes from the first not-yet-canonicalized event, but rows that are
      // skipped as invalid never acquire an artifact row, so the loop keeps an in-memory cursor
      // that walks past them; the cursor resets when the scan exhausts, re-scanning (and cheaply
      // re-skipping) those rows on the next cycle. Durable progress lives in the event_artifact
      // rows themselves, so a restart resumes from the database without any extra bookkeeping.
      let afterID: EventV2.ID | undefined
      const tick = Effect.suspend(() =>
        Effect.gen(function* () {
          let processed = 0
          for (let step = 0; step < maxEventsPerTick; step++) {
            const result = yield* events.canonicalizeLegacyArtifacts({
              ...(afterID ? { afterID } : {}),
              limit: EventV2.LEGACY_ARTIFACT_BATCH_EVENTS,
            })
            processed += result.processed
            if (!result.next) {
              afterID = undefined
              break
            }
            afterID = result.next
          }
          return processed
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("legacy event canonicalizer tick failed", { cause: Cause.pretty(cause) }).pipe(
            Effect.as(0),
          ),
        ),
      )
      yield* tick
      yield* tick.pipe(Effect.repeat(Schedule.spaced(pollInterval)), Effect.forkScoped)
    }),
  )

export const layer = makeLayer()

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)
