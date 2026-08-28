import { detectSeqGap, type SessionEventPayload } from "@deepagent-code/sdk/v2/client"

// §16.5 API-APP-PACKAGE P4 — per-session durable journal subscription. The volatile global
// stream is a notification surface; the journal is the authority. This drive implements the
// snapshot-at-watermark consumer half: the caller reads the high-water cursor FIRST, fetches
// the message snapshot, and then opens this drive with after=<cursor> — every journaled event
// at or below the cursor is already reflected in the snapshot (projection commits with the
// journal), so the drain is an exact tail and replayed boundary events converge.

export type SessionJournalClient = {
  readonly sessionEventStream: (
    sessionId: string,
    input: { readonly after?: string; readonly onError?: (error: unknown) => void },
  ) => Promise<{ readonly stream: AsyncGenerator<SessionEventPayload>; readonly close: () => void }>
}

export type SessionJournalHandlers = {
  readonly onEvent: (event: SessionEventPayload) => void
  readonly onResync: () => void
  readonly onStreamEnd: () => void
  readonly onError?: (error: unknown) => void
}

export const openSessionJournal = async (
  client: SessionJournalClient,
  sessionID: string,
  handlers: SessionJournalHandlers & {
    readonly after?: string
  },
): Promise<{ close: () => void }> => {
  const cursor = await client.sessionEventStream(sessionID, {
    after: handlers.after,
    onError: handlers.onError,
  })
  let lastSeq: number | undefined
  let resynced = false
  let closed = false
  const drive = async () => {
    try {
      for await (const event of cursor.stream) {
        if (closed) return
        const gap = detectSeqGap(lastSeq, event.seq)
        if (event.seq !== undefined) lastSeq = event.seq
        if (gap && !resynced) {
          resynced = true
          cursor.close()
          handlers.onResync()
          return
        }
        handlers.onEvent(event)
      }
      if (!closed && !resynced) handlers.onStreamEnd()
    } catch (error) {
      if (!closed) handlers.onError?.(error)
    }
  }
  void drive()
  return {
    close: () => {
      closed = true
      cursor.close()
    },
  }
}