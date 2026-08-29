import type { ContextSessionEvent } from "@deepagent-code/sdk"
import { isCursorGap } from "./cli/sdk-error"

// §16.5 API-APP-PACKAGE P4 — durable per-session journal drive for the non-interactive run
// loop. The journal is the authority for the active session: the drive reads the durable cursor
// once (the run-start boundary), then drains the bounded page API (`context.events`) in a poll
// loop, re-reading the cursor on a typed 410 (`cursor_gap_exceeded`) so the replay is bounded to
// the retained floor. The generated `context.events`/`context.eventsCursor` surface is the only
// authority; there is no volatile/live SSE fallback.

/** The generated durable-cursor surface the journal drives (a subset of `DeepAgentCodeClient.context`). */
export type RunJournalClient = {
  readonly eventsCursor: (sessionId: string) => Promise<{
    readonly watermark: number
    readonly cursor: number
    readonly floor: number
  }>
  readonly events: (
    sessionId: string,
    input?: { readonly after?: string; readonly limit?: string },
  ) => Promise<{
    readonly events: readonly ContextSessionEvent[]
    readonly nextCursor?: number
    readonly floor: number
  }>
}

const DEFAULT_LIMIT = "500"
const POLL_INTERVAL_MS = 250

export const openRunJournal = async (
  client: RunJournalClient,
  sessionID: string,
  input: {
    readonly after?: string
    readonly onEvent: (event: ContextSessionEvent) => void
    readonly onResync: () => void
    readonly onStreamEnd: () => void
    readonly onError?: (error: unknown) => void
  },
): Promise<{ close: () => void; done: Promise<void> }> => {
  // Hydrate at the durable watermark once, then drain `after=cursor`. The caller may already hold
  // an `after` anchor (a re-open); when absent, read the cursor so the initial replay starts at the
  // snapshot position.
  let after = input.after
  if (after === undefined) {
    const cursor = await client.eventsCursor(sessionID)
    after = String(cursor.cursor)
  }

  let closed = false
  let caughtUp = false
  let resynced = false
  let settled = false
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const settle = () => {
    if (settled) return
    settled = true
    resolveDone()
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const drive = async () => {
    try {
      while (!closed) {
        let page: {
          readonly events: readonly ContextSessionEvent[]
          readonly nextCursor?: number
          readonly floor: number
        }
        try {
          page = await client.events(sessionID, { after, limit: DEFAULT_LIMIT })
        } catch (error) {
          // A cursor that fell behind the retained floor is the durable resync trigger: re-read
          // the cursor and re-drain from the floor (bounded — one resync, then report).
          if (isCursorGap(error)) {
            if (resynced) {
              input.onError?.(error)
              settle()
              return
            }
            resynced = true
            input.onResync()
            const cursor = await client.eventsCursor(sessionID)
            after = String(cursor.floor)
            continue
          }
          // 400 validation_failed and any other typed failure are surfaced as typed errors; never
          // parse a human `message`. The caller owns rendering.
          input.onError?.(error)
          settle()
          return
        }

        for (const event of page.events) {
          if (closed) return
          input.onEvent(event)
        }
        if (page.nextCursor !== undefined) {
          after = String(page.nextCursor)
          continue
        }
        // Caught up to the durable head: the initial replay finished. Keep polling for a live tail.
        if (!caughtUp) {
          caughtUp = true
          input.onStreamEnd()
        }
        await sleep(POLL_INTERVAL_MS)
      }
    } finally {
      settle()
    }
  }
  void drive()
  return {
    close: () => {
      closed = true
    },
    done,
  }
}
