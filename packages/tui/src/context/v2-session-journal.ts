// C6-07 port — the durable REST drain (context.eventsCursor/events) replaces the compat
// SSE journal drive. §16.5 API-APP-PACKAGE P4 semantics are preserved: the caller reads the
// high-water cursor FIRST, hydrates the message snapshot, then opens this drive with
// after=<cursor> — every journaled event at or below the cursor is already reflected in the
// snapshot, so the drain is an exact tail and replayed boundary events converge.

export type JournalEventRow = {
  readonly id: string
  readonly seq: number
  readonly type: string
  readonly data?: Record<string, unknown>
}

export type SessionJournalClient = {
  readonly context: {
    readonly eventsCursor: (parameters: { session_id: string }) => Promise<{
      data?: { watermark: number; cursor: number; floor: number }
      error?: unknown
    }>
    readonly events: (parameters: { session_id: string; after: string }) => Promise<{
      data?: { events: JournalEventRow[]; nextCursor?: number; floor: number }
      error?: unknown
    }>
  }
}

export type SessionJournalHandlers = {
  readonly onEvent: (event: JournalEventRow) => void
  readonly onResync: () => void
  readonly onStreamEnd: () => void
  readonly onError?: (error: unknown) => void
}

const POLL_MS = 1000
let pollMsOverride: number | undefined

const isCursorGap = (error: unknown): boolean =>
  ((error as { data?: { code?: unknown } })?.data)?.code === "cursor_gap_exceeded"

export const openSessionJournal = async (
  client: SessionJournalClient,
  sessionID: string,
  handlers: SessionJournalHandlers & {
    readonly after?: string
    /** Test-only poll interval override (default 1000ms). */
    readonly pollMs?: number
  },
): Promise<{ close: () => void }> => {
  let closed = false
  let lastSeq = handlers.after === undefined ? undefined : Number(handlers.after)
  let resynced = false
  let caughtUp = false
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const drive = async () => {
    while (!closed) {
      try {
        const cursorResult = await client.context.eventsCursor({ session_id: sessionID })
        const watermark = cursorResult.data?.watermark ?? 0
        const page = await client.context.events({ session_id: sessionID, after: lastSeq !== undefined ? String(lastSeq) : String(watermark) })
        if (page.error) throw page.error
        const events = page.data?.events ?? []
        if (events.length === 0) {
          if (!caughtUp) {
            caughtUp = true
            handlers.onStreamEnd()
          }
        } else {
          caughtUp = false
          for (const event of events) {
            if (closed) return
            if (lastSeq !== undefined && event.seq <= lastSeq) continue // duplicate absorption (seq-dedupe)
            lastSeq = event.seq
            handlers.onEvent(event)
          }
        }
        if (closed) return
        await sleep(handlers.pollMs ?? POLL_MS)
      } catch (error) {
        if (isCursorGap(error)) {
          // Bounded resync: one onResync; the caller re-syncs (closes + re-opens), so a
          // replacement drive re-anchors at the fresh cursor — never silently accepts the gap.
          if (!resynced) {
            resynced = true
            handlers.onResync()
            return
          }
          handlers.onError?.(error)
        } else {
          handlers.onError?.(error)
        }
        return
      }
    }
  }
  void drive()
  return {
    close: () => {
      closed = true
    },
  }
}
