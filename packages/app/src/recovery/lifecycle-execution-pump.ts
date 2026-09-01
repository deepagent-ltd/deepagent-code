import type { LifecycleEvent, RecoveryLifecycle, ExecutionInterruptReason } from "./recovery-lifecycle-state"

// C6-11 — the real-event pump: `SessionEvent.Execution.*` (core src/session/event.ts:
// session.execution.started/succeeded/failed/interrupted) flow into the per-session
// lifecycle reducer. This module is the single mapping source from the wire event shapes to
// `LifecycleEvent`, and the subscription helper that attaches a live event source
// (SSE dir-SDK emitter or the durable journal drain) to a reducer instance.
//
// Wire shapes accepted (both carry sessionID in a payload record):
//   - SSE:           { type, properties: { timestamp, sessionID, error?, reason? } }
//   - durable drain: { type, data:      { timestamp, sessionID, error?, reason? } }
// The pump filters non-execution events out (returns undefined) and drops payload shapes
// that carry no usable sessionID, so an unknown/older server never crashes the reducer.

export const EXECUTION_EVENT_TYPES = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const

export type ExecutionEventType = (typeof EXECUTION_EVENT_TYPES)[number]

export const isExecutionEventType = (type: string): type is ExecutionEventType =>
  (EXECUTION_EVENT_TYPES as readonly string[]).includes(type)

export type ExecutionEventInput = {
  readonly type: string
  readonly properties?: unknown
  readonly data?: unknown
}

/** Structural event source (dir-SDK emitter `.listen` / global emitter `.listen`). */
export type ExecutionEventSource = {
  listen: (handler: (event: { name: string; details: unknown }) => void) => () => void
}

const payloadOf = (event: ExecutionEventInput): Record<string, unknown> | undefined => {
  const payload = event.properties ?? event.data
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : undefined
}

const sessionIDOf = (event: ExecutionEventInput): string | undefined => {
  const sessionID = payloadOf(event)?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

const timestampOf = (event: ExecutionEventInput): number => {
  const timestamp = payloadOf(event)?.timestamp
  return typeof timestamp === "number" ? timestamp : 0
}

const reasonOf = (event: ExecutionEventInput): ExecutionInterruptReason | undefined => {
  const reason = payloadOf(event)?.reason
  if (reason !== "user" && reason !== "shutdown" && reason !== "superseded") return undefined
  return reason
}

/** Map one wire event to a `LifecycleEvent`; non-execution events map to undefined. */
export const toLifecycleEvent = (event: ExecutionEventInput): LifecycleEvent | undefined => {
  if (!isExecutionEventType(event.type)) return undefined
  const sessionID = sessionIDOf(event)
  if (!sessionID) return undefined
  const timestamp = timestampOf(event)
  switch (event.type) {
    case "session.execution.started":
      return { type: "execution-started", sessionID, timestamp }
    case "session.execution.succeeded":
      return { type: "execution-succeeded", sessionID, timestamp }
    case "session.execution.failed":
      return { type: "execution-failed", sessionID, timestamp, error: payloadOf(event)?.error }
    case "session.execution.interrupted":
      return { type: "execution-interrupted", sessionID, timestamp, reason: reasonOf(event) ?? "user" }
  }
}

/**
 * Subscribe a live event source to a lifecycle reducer. Returns the unsubscribe function.
 * `onEvent` is invoked after every mapped event so callers can trigger reactivity.
 */
export const subscribeExecutionEvents = (
  source: ExecutionEventSource,
  lifecycle: RecoveryLifecycle,
  onEvent?: () => void,
): (() => void) =>
  source.listen((event) => {
    const mapped = toLifecycleEvent(event.details as ExecutionEventInput)
    if (!mapped) return
    lifecycle.onEvent(mapped)
    onEvent?.()
  })
