import { toNotificationEvent, type NotificationEvent } from "./v2-notification-mapping"
import { eventBaseType } from "@/utils/event-type"

// C6-07 — the compat SSE cursor (sessionEventStream over /api/session/:id/events)
// is gone. The durable surface is the REST drain (context.eventsCursor/events)
// polled at a fixed interval: snapshot-at-watermark — the first subscribe anchors
// at the journal watermark; every following drain resumes from the last seen seq;
// duplicate absorption is seq-based (order-preserving); a typed 410
// (cursor_gap_exceeded) performs a bounded resync (re-anchor at the fresh
// watermark + onResync notice); any other typed error is surfaced via
// onErrorEvent. Decisions branch on code/httpStatus — never on `message`.

export type NotificationHandlers = {
  readonly onIdle: (sessionID: string) => void
  readonly onError: (sessionID: string, error: NonNullable<NotificationEvent["error"]>) => void
  readonly onResync?: (sessionID: string) => void
  readonly onErrorEvent?: (error: unknown) => void
  readonly onJournalEvent?: (
    sessionID: string,
    event: { readonly type: string; readonly seq: number; readonly data?: Record<string, unknown> },
  ) => void
}

export type DrainEventRow = {
  readonly id: string
  readonly seq: number
  readonly type: string
  readonly data?: Record<string, unknown>
}

/** Structural view of the generated client.context drain surface (supertype-compatible). */
export type DrainClient = {
  readonly context: {
    eventsCursor(
      parameters: { session_id: string },
      options?: { signal?: AbortSignal },
    ): Promise<{
      data?: { watermark: number; cursor: number; floor: number }
      error?: unknown
      response?: Response
    }>
    events(
      parameters: { session_id: string; after: string; limit?: string },
      options?: { signal?: AbortSignal },
    ): Promise<{
      data?: { events: DrainEventRow[]; nextCursor?: number; floor: number }
      error?: unknown
      response?: Response
    }>
  }
}

const POLL_MS = 1000

/** A typed error's C0-03 `code` (stable envelope — never a message). */
const errorCode = (error: unknown): string | undefined => {
  const data = (error as { data?: { code?: unknown } })?.data
  return typeof data?.code === "string" ? data.code : undefined
}

export const subscribeSessionNotifications = (
  client: DrainClient,
  sessionIDs: readonly string[],
  handlers: NotificationHandlers,
  resolver?: {
    readonly after?: (sessionID: string) => string | undefined
    readonly active?: (sessionID: string) => boolean
    readonly subscribeHint?: (hint: (sessionID?: string) => void) => () => void
  },
  pollMs = POLL_MS,
): (() => void) => {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const requests = new Map<string, AbortController>()
  const kicks = new Map<string, () => void>()
  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden"
  let disposed = false

  const startLoop = (sessionID: string, seed: string | undefined) => {
    let lastSeq = seed === undefined ? undefined : Number(seed)
    const owner = { active: false, pending: false, running: false, delay: pollMs, nextAt: 0 }
    const schedule = (delay: number) => {
      clearTimeout(timers.get(sessionID))
      timers.delete(sessionID)
      if (disposed) return
      timers.set(
        sessionID,
        setTimeout(() => void tick(), delay),
      )
    }
    const kick = () => {
      if (disposed) return
      owner.pending = true
      owner.delay = pollMs
      if (!owner.active) schedule(Math.max(0, owner.nextAt - performance.now()))
    }
    kicks.set(sessionID, kick)
    const tick = async () => {
      if (disposed) return
      if (owner.active) {
        owner.pending = true
        return
      }
      owner.active = true
      owner.pending = false
      owner.nextAt = performance.now() + pollMs
      const abort = new AbortController()
      requests.set(sessionID, abort)
      const result = { fresh: false, successful: false }
      try {
        if (lastSeq === undefined) {
          const cursor = await client.context.eventsCursor({ session_id: sessionID }, { signal: abort.signal })
          if (disposed) return
          if (cursor.error) {
            handlers.onErrorEvent?.(cursor.error)
            return
          }
          // Keep the initial anchor even when the first drain has no rows.
          lastSeq = cursor.data?.watermark ?? 0
        }
        const drain = await client.context.events(
          { session_id: sessionID, after: String(lastSeq) },
          { signal: abort.signal },
        )
        if (disposed) return
        if (drain.error) {
          if (errorCode(drain.error) === "cursor_gap_exceeded") {
            lastSeq = undefined
            handlers.onResync?.(sessionID)
          } else handlers.onErrorEvent?.(drain.error)
          return
        }
        result.successful = true
        for (const event of drain.data?.events ?? []) {
          if (disposed) return
          if (lastSeq !== undefined && event.seq <= lastSeq) continue
          result.fresh = true
          lastSeq = event.seq
          const type = eventBaseType(event.type)
          if (type === "session.execution.started") owner.running = true
          if (
            type === "session.execution.succeeded" ||
            type === "session.execution.failed" ||
            type === "session.execution.interrupted"
          )
            owner.running = false
          handlers.onJournalEvent?.(sessionID, event)
          const mapped = toNotificationEvent(event.type, event.data ?? {})
          if (!mapped?.sessionID) continue
          if (mapped.type === "session.idle") handlers.onIdle(mapped.sessionID)
          else if (mapped.error) handlers.onError(mapped.sessionID, mapped.error)
        }
      } catch (error) {
        if (!disposed && !abort.signal.aborted) handlers.onErrorEvent?.(error)
      } finally {
        owner.active = false
        if (requests.get(sessionID) === abort) requests.delete(sessionID)
        if (!disposed) {
          owner.delay =
            result.fresh || owner.running || resolver?.active?.(sessionID) ? pollMs : Math.min(30_000, owner.delay * 2)
          if (!result.successful && !abort.signal.aborted) owner.pending = false
          schedule(owner.pending ? Math.max(0, owner.nextAt - performance.now()) : owner.delay)
        }
      }
    }
    schedule(0)
  }

  for (const sessionID of sessionIDs) startLoop(sessionID, resolver?.after?.(sessionID))
  const visibility = () => {
    // The notification journal must keep its single consumer alive in the background.
    // Returning to the window only requests an earlier drain; it does not replay rows.
    if (!visible()) return
    for (const kick of kicks.values()) kick()
  }
  const unsubscribe = resolver?.subscribeHint?.((sessionID) => {
    if (sessionID !== undefined) {
      kicks.get(sessionID)?.()
      return
    }
    for (const kick of kicks.values()) kick()
  })
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibility)
  return () => {
    if (disposed) return
    disposed = true
    unsubscribe?.()
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visibility)
    for (const abort of requests.values()) abort.abort()
    requests.clear()
    kicks.clear()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }
}
