import { toNotificationEvent, type NotificationEvent } from "./v2-notification-mapping"

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
    eventsCursor(parameters: { session_id: string }): Promise<{
      data?: { watermark: number; cursor: number; floor: number }
      error?: unknown
      response?: Response
    }>
    events(parameters: { session_id: string; after: string; limit?: string }): Promise<{
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
  resolver?: { readonly after?: (sessionID: string) => string | undefined },
  pollMs = POLL_MS,
): (() => void) => {
  const cancelled = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const startLoop = (sessionID: string, seed: string | undefined) => {
    let lastSeq = seed === undefined ? undefined : Number(seed)
    const tick = async () => {
      if (cancelled.has(sessionID)) return
      try {
        const cursor = await client.context.eventsCursor({ session_id: sessionID })
        const watermark = cursor.data?.watermark ?? 0
        const drain = await client.context.events({ session_id: sessionID, after: lastSeq !== undefined ? String(lastSeq) : String(watermark) })
        if (drain.error ?? cursor.error) {
          const error = drain.error ?? cursor.error
          if (error && errorCode(error) === "cursor_gap_exceeded") {
            // Bounded resync: drop the stale anchor, re-anchor at the fresh
            // watermark on the next tick and surface the typed notice (never
            // silent data loss; a replacement cursor cannot gap on first event).
            lastSeq = undefined
            handlers.onResync?.(sessionID)
          } else {
            handlers.onErrorEvent?.(error)
          }
        } else {
          for (const event of drain.data?.events ?? []) {
            if (lastSeq !== undefined && event.seq <= lastSeq) continue // duplicate absorption (seq-dedupe)
            handlers.onJournalEvent?.(sessionID, event)
            lastSeq = event.seq
            const mapped = toNotificationEvent(event.type, event.data ?? {})
            if (!mapped?.sessionID) continue
            if (mapped.type === "session.idle") handlers.onIdle(mapped.sessionID)
            else if (mapped.error) handlers.onError(mapped.sessionID, mapped.error)
          }
        }
      } catch (error) {
        handlers.onErrorEvent?.(error)
      } finally {
        if (!cancelled.has(sessionID)) {
          timers.set(
            sessionID,
            setTimeout(() => void tick(), pollMs),
          )
        }
      }
    }
    timers.set(sessionID, setTimeout(() => void tick(), 0))
  }

  for (const sessionID of sessionIDs) startLoop(sessionID, resolver?.after?.(sessionID))

  return () => {
    for (const sessionID of sessionIDs) cancelled.add(sessionID)
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }
}
