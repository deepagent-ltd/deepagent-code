import { eventBaseType } from "@/utils/event-type"
import type { LifecycleEvent, RecoveryLifecycle, ExecutionInterruptReason } from "./recovery-lifecycle-state"

// C6-11 + W9.5 — the real-event pump: `SessionEvent.Execution.*` (core src/session/event.ts:
// session.execution.started/succeeded/failed/interrupted) flow into the per-session lifecycle
// reducer. This module is the single mapping source from the wire event shapes to
// `LifecycleEvent`, plus the two live subscription helpers:
//
//   - `createExecutionJournalSubscription` — PRIMARY source: the durable journal drain
//     (context.eventsCursor/events, snapshot-at-watermark, seq-resumed poll). The journal is the
//     only execution surface when `DEEPAGENT_CODE_EVENT_V2_ADMISSION` is ON: the GlobalBus SSE
//     mirror is skipped by event-v2-bridge.ts in that mode, so `sdk.event` never carries
//     `session.execution.*` and the durable rows are the sole authority.
//   - `subscribeExecutionEvents` — SSE fallback/compat for the admission-OFF mirror (which emits
//     the unversioned definition type in `properties`).
//
// Wire shapes accepted (both carry sessionID in a payload record):
//   - SSE:           { type, properties: { timestamp, sessionID, error?, reason? } }
//   - durable drain: { type: "…started.1", data: { timestamp, sessionID, error?, reason? } }
// The drain row type is VERSIONED (`EventTable.type` = `versionedType(type, sync.version)`);
// `eventBaseType` strips the trailing `.N` before vocabulary matching. The pump filters
// non-execution events out (returns undefined) and drops payload shapes that carry no usable
// sessionID, so an unknown/older server never crashes the reducer.

export const EXECUTION_EVENT_TYPES = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const

export type ExecutionEventType = (typeof EXECUTION_EVENT_TYPES)[number]

/** Match on the version-stripped event name: accepts both `session.execution.started` (SSE) and
 * `session.execution.started.1` (durable journal row). */
export const isExecutionEventType = (type: string): type is ExecutionEventType =>
  (EXECUTION_EVENT_TYPES as readonly string[]).includes(eventBaseType(type))

export type ExecutionEventInput = {
  readonly type: string
  readonly properties?: unknown
  readonly data?: unknown
}

/** Structural event source (dir-SDK emitter `.listen` / global emitter `.listen`). */
export type ExecutionEventSource = {
  listen: (handler: (event: { name: string; details: unknown }) => void) => () => void
}

/** One durable journal row (the generated `ContextSessionEvent` shape). */
export type ExecutionJournalRow = {
  readonly id: string
  readonly seq: number
  readonly type: string
  readonly data?: Record<string, unknown>
}

/** Structural view of the generated client.context drain surface (supertype-compatible). */
export type ExecutionJournalClient = {
  readonly context: {
    eventsCursor(parameters: { session_id: string }): Promise<{
      data?: { watermark?: number; cursor?: number; floor?: number }
      error?: unknown
      response?: Response
    }>
    events(parameters: { session_id: string; after: string; limit?: string }): Promise<{
      data?: { events?: ExecutionJournalRow[]; nextCursor?: number; floor?: number }
      error?: unknown
      response?: Response
    }>
  }
}

export type ExecutionJournalHandlers = {
  /** Fired after every mapped event so callers can trigger reactivity. */
  readonly onEvent?: () => void
  /** Aggregate durable-cursor connectivity: fired on any transition (false = at least one
   * session's poll is failing at the network layer, true = every session polls again). */
  readonly onConnectionChange?: (connected: boolean) => void
  /** Typed/network errors that are not consumed as a resync (never a crash). */
  readonly onErrorEvent?: (error: unknown) => void
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
  const baseType = eventBaseType(event.type)
  if (!isExecutionEventType(baseType)) return undefined
  const sessionID = sessionIDOf(event)
  if (!sessionID) return undefined
  const timestamp = timestampOf(event)
  switch (baseType) {
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
 * Subscribe a live event source to a lifecycle reducer (SSE fallback/compat path). Returns the
 * unsubscribe function. `onEvent` is invoked after every mapped event so callers can trigger
 * reactivity.
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

const POLL_MS = 1000

/** A typed error's C0-03 `code` (stable envelope — never a message). The throwOnError client
 * throws the parsed envelope itself (`{ code, category, httpStatus, … }`); the non-throwing
 * client returns it under `{ error: { data: { code } } }`. */
const typedCodeOf = (error: unknown): string | undefined => {
  if (error === null || typeof error !== "object") return undefined
  const top = (error as { code?: unknown }).code
  if (typeof top === "string") return top
  const data = (error as { data?: { code?: unknown } }).data
  return typeof data?.code === "string" ? data.code : undefined
}

/** A typed API envelope answered the poll (the server is reachable) — not a connectivity loss. */
const isTypedApiError = (error: unknown): boolean => {
  if (error === null || typeof error !== "object") return false
  const envelope = error as { category?: unknown; httpStatus?: unknown; schemaVersion?: unknown }
  return envelope.category !== undefined || envelope.httpStatus !== undefined || envelope.schemaVersion !== undefined
}

/**
 * Durable journal drive for the lifecycle pump (PRIMARY source). Per session: the first subscribe
 * anchors the drain at the journal watermark (snapshot-at-watermark — never a history replay at
 * mount); every following drain resumes from the last seen seq (`after=lastSeq`), so a network
 * blip or a re-mount resumes exactly where the reducer left off. Duplicate absorption is
 * seq-based; a typed 410 `cursor_gap_exceeded` re-anchors at the retained floor (bounded resync);
 * any other typed error is surfaced via `onErrorEvent`; a network-layer failure flips the
 * aggregate connection signal (false) and recovery flips it back (true) — the loop itself already
 * resumes from the last cursor, which is the reconnect semantics. Returns `{ refresh, dispose }`;
 * `refresh()` re-reads the session set and rebuilds only when it actually changed.
 */
export const createExecutionJournalSubscription = (
  input: {
    readonly client: ExecutionJournalClient
    readonly sessionIDs: () => readonly string[]
    readonly lifecycle: RecoveryLifecycle
    readonly handlers?: ExecutionJournalHandlers
  },
  pollMs = POLL_MS,
): { readonly refresh: (force?: boolean) => void; readonly dispose: () => void } => {
  const cancelled = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const lastSeqs = new Map<string, number>()
  const failedSessions = new Set<string>()
  let sessionIDs: readonly string[] = []
  let generation = 0
  let connected = true

  const markFailed = (sessionID: string) => {
    if (failedSessions.has(sessionID)) return
    failedSessions.add(sessionID)
    if (connected) {
      connected = false
      input.handlers?.onConnectionChange?.(false)
    }
  }

  const markRecovered = (sessionID: string) => {
    if (!failedSessions.delete(sessionID)) return
    if (!connected && failedSessions.size === 0) {
      connected = true
      input.handlers?.onConnectionChange?.(true)
    }
  }

  const readAnchor = async (sessionID: string, kind: "watermark" | "floor"): Promise<number> => {
    const cursor = await input.client.context.eventsCursor({ session_id: sessionID })
    if (cursor.error) throw cursor.error
    const anchor = kind === "floor" ? cursor.data?.floor : cursor.data?.watermark
    return typeof anchor === "number" ? anchor : 0
  }

  const startLoop = (sessionID: string, seedSeq: number | undefined) => {
    const myGeneration = generation
    let lastSeq = seedSeq
    let gapResync = false

    const handleError = (error: unknown) => {
      if (typedCodeOf(error) === "cursor_gap_exceeded") {
        // Cursor behind the retained floor (the journal dropped rows while we held the anchor):
        // bounded resync — re-anchor at the floor on the next tick and re-drain the window.
        // The drain after `floor` can only return rows newer than our last seq, so the reducer
        // never re-processes an already-delivered outcome.
        lastSeq = undefined
        gapResync = true
        return
      }
      if (isTypedApiError(error)) {
        // The server answered with a typed refusal (400/404/…): connectivity is fine, surface it.
        input.handlers?.onErrorEvent?.(error)
        return
      }
      // Network-layer failure: flag the disconnect once; the poll keeps running and resumes
      // from `lastSeq` on recovery (seq-resume reconnect — no re-anchor, no lost window).
      markFailed(sessionID)
      input.handlers?.onErrorEvent?.(error)
    }

    const tick = async () => {
      if (cancelled.has(sessionID) || myGeneration !== generation) return
      try {
        let anchor: number
        if (gapResync) {
          anchor = await readAnchor(sessionID, "floor")
          gapResync = false
        } else if (lastSeq === undefined) {
          anchor = await readAnchor(sessionID, "watermark")
        } else {
          anchor = lastSeq
        }
        lastSeq = anchor
        const drain = await input.client.context.events({ session_id: sessionID, after: String(anchor) })
        if (drain.error) {
          handleError(drain.error)
        } else {
          for (const row of drain.data?.events ?? []) {
            if (row.seq <= lastSeq) continue // duplicate absorption (seq-dedupe)
            lastSeq = row.seq
            const mapped = toLifecycleEvent({ type: row.type, data: row.data })
            if (!mapped) continue
            input.lifecycle.onEvent(mapped)
            input.handlers?.onEvent?.()
          }
          markRecovered(sessionID)
        }
      } catch (error) {
        handleError(error)
      } finally {
        if (!cancelled.has(sessionID) && myGeneration === generation) {
          timers.set(
            sessionID,
            setTimeout(() => void tick(), pollMs),
          )
        }
      }
    }
    timers.set(sessionID, setTimeout(() => void tick(), 0))
  }

  const rebuild = () => {
    generation += 1
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    for (const sessionID of sessionIDs) startLoop(sessionID, lastSeqs.get(sessionID))
  }

  const refresh = (force = false) => {
    const next = input.sessionIDs()
    const changed = force || next.length !== sessionIDs.length || !next.every((id) => sessionIDs.includes(id))
    if (!changed) return
    sessionIDs = [...next]
    rebuild()
  }

  const dispose = () => {
    for (const sessionID of sessionIDs) cancelled.add(sessionID)
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }

  // Start draining the known set immediately; later `refresh()` calls (reactively tracked by the
  // caller) add removed/new sessions without re-anchoring the survivors.
  refresh()

  return { refresh, dispose }
}
