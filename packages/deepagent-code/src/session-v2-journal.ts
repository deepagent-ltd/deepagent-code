import { detectSeqGap, type SessionEventPayload } from "@deepagent-code/sdk/v2/client"

// §16.5 API-APP-PACKAGE P4 — durable per-session journal drive for the non-interactive run
// loop. The journal is the authority for the active session: the drive opens a watermark-
// anchored stream once (the run-start boundary), then reopens from the journal head after a
// seq gap or stream end (the caller keeps an applied-id set, so replayed boundaries are
// absorbed and missed boundaries re-print in journal order).

export type RunJournalClient = {
  readonly sessionEventWatermark: (sessionId: string) => Promise<number | undefined>
  readonly sessionEventStream: (
    sessionId: string,
    input: { readonly after?: string; readonly onError?: (error: unknown) => void },
  ) => Promise<{ readonly stream: AsyncGenerator<SessionEventPayload>; readonly close: () => void }>
}

export const openRunJournal = async (
  client: RunJournalClient,
  sessionID: string,
  input: {
    readonly after?: string
    readonly onEvent: (event: SessionEventPayload) => void
    readonly onResync: () => void
    readonly onStreamEnd: () => void
    readonly onError?: (error: unknown) => void
  },
): Promise<{ close: () => void; done: Promise<void> }> => {
  const cursor = await client.sessionEventStream(sessionID, {
    after: input.after,
    onError: input.onError,
  })
  let lastSeq: number | undefined
  let resynced = false
  let closed = false
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const drive = async () => {
    try {
      for await (const event of cursor.stream) {
        if (closed) return
        if (detectSeqGap(lastSeq, event.seq) && !resynced) {
          resynced = true
          cursor.close()
          input.onResync()
          return
        }
        if (event.seq !== undefined) lastSeq = event.seq
        input.onEvent(event)
      }
      if (!closed && !resynced) input.onStreamEnd()
    } catch (error) {
      if (!closed) input.onError?.(error)
    } finally {
      resolveDone()
    }
  }
  void drive()
  return {
    close: () => {
      closed = true
      cursor.close()
    },
    done,
  }
}