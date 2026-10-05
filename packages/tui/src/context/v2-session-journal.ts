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
  let caughtUp = false
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve
      timer = setTimeout(() => {
        timer = undefined
        wake = undefined
        resolve()
      }, ms)
    })

  const drive = async () => {
    while (!closed) {
      try {
        if (lastSeq === undefined) {
          const cursorResult = await client.context.eventsCursor({ session_id: sessionID })
          if (cursorResult.error) throw cursorResult.error
          if (!cursorResult.data) throw new Error("Session journal returned no cursor")
          lastSeq = cursorResult.data.watermark
        }
        if (closed) return
        const page = await client.context.events({ session_id: sessionID, after: String(lastSeq) })
        if (page.error) throw page.error
        if (!page.data) throw new Error("Session journal returned no page")
        if (closed) return
        const events = page.data.events
        failures = 0
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
            handlers.onEvent(event)
            lastSeq = event.seq
          }
        }
        if (closed) return
        await sleep(handlers.pollMs ?? POLL_MS)
      } catch (error) {
        if (closed) return
        if (isCursorGap(error)) {
          // The owner replaces this drive after a fresh snapshot-at-watermark cycle.
          handlers.onResync()
          return
        }
        handlers.onError?.(error)
        failures += 1
        // A transient transport failure keeps the exact durable cursor. An expired cursor
        // follows the explicit snapshot path above instead of silently skipping its tail.
        await sleep(Math.min(30_000, (handlers.pollMs ?? POLL_MS) * 2 ** Math.min(failures - 1, 5)))
      }
    }
  }
  void drive()
  return {
    close: () => {
      closed = true
      if (timer) clearTimeout(timer)
      wake?.()
    },
  }
}
