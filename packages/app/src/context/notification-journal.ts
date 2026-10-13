import {
  subscribeSessionNotifications,
  type DrainClient,
  type NotificationHandlers,
} from "./v2-notification-subscription"

// §16.5 API-APP-PACKAGE P5 — durable replacement of the notification feed GlobalBus
// listener. The volatile stream notified idle/error for every session at once; the durable
// surface subscribes each known session V2 journal via the C6-07 drain cursor anchored at
// the session journal watermark (first subscribe) or the last seen seq (rebuild), so no
// rebuild ever re-replays history. The known set is the active directory session list.

type CursorClient = DrainClient

export type NotificationJournalHandlers = {
  readonly onIdle: (directory: string | undefined, sessionID: string, time: number) => void
  readonly onError: (
    directory: string | undefined,
    sessionID: string,
    error: NonNullable<import("./v2-notification-mapping").NotificationEvent["error"]>,
    time: number,
  ) => void
  readonly onErrorEvent?: (error: unknown) => void
}

export const createNotificationJournalSubscription = (
  input: {
    readonly client: CursorClient
    readonly clientFor?: (directory: string) => CursorClient
    readonly currentDirectory: () => string | undefined
    readonly sessionsOf: (directory: string) => readonly string[]
    readonly handlers: NotificationJournalHandlers
    readonly active?: (sessionID: string) => boolean
    readonly subscribeHint?: (hint: (sessionID?: string) => void) => () => void
  },
  pollMs = 1000,
): { readonly dispose: () => void; readonly refresh: (force?: boolean) => void } => {
  let unsubscribe: (() => void) | undefined
  let directory = ""
  let sessionIDs: readonly string[] = []
  const lastSeqs = new Map<string, number>()
  let generation = 0
  let disposed = false
  let abort = new AbortController()

  const rebuild = () => {
    generation++
    abort.abort()
    abort = new AbortController()
    unsubscribe?.()
    unsubscribe = undefined
    if (sessionIDs.length === 0) return
    void subscribe([...sessionIDs], generation, directory, abort.signal).catch((error: unknown) => {
      if (!disposed) input.handlers.onErrorEvent?.(error)
    })
  }

  async function subscribe(ids: readonly string[], ownGeneration: number, ownDirectory: string, signal: AbortSignal) {
    const current = () => !disposed && ownGeneration === generation
    const client = input.clientFor?.(ownDirectory) ?? input.client
    // Anchor every session at its journal watermark (first subscribe) or the last seen seq
    // (rebuild). Watermark-first keeps the drain from replaying journal history; the seq
    // anchors keep a gap-driven resync from re-rendering delivered notifications.
    const after = new Map<string, string | undefined>()
    await Promise.all(
      ids.map(async (sessionID) => {
        const last = lastSeqs.get(sessionID)
        if (last !== undefined) {
          after.set(sessionID, String(last))
          return
        }
        const cursor = await client.context.eventsCursor({ session_id: sessionID }, { signal }).catch(() => undefined)
        after.set(sessionID, cursor?.data?.watermark !== undefined ? String(cursor.data.watermark) : undefined)
      }),
    )
    if (!current()) return
    for (const [sessionID, anchor] of after) if (anchor !== undefined) lastSeqs.set(sessionID, Number(anchor))
    const handlers: NotificationHandlers = {
      onIdle: (sessionID) => {
        if (current()) input.handlers.onIdle(ownDirectory, sessionID, Date.now())
      },
      onError: (sessionID, error) => {
        if (current()) input.handlers.onError(ownDirectory, sessionID, error, Date.now())
      },
      onErrorEvent: (error) => {
        if (current()) input.handlers.onErrorEvent?.(error)
      },
      onJournalEvent: (sessionID, event) => {
        if (current() && event.seq !== undefined) lastSeqs.set(sessionID, event.seq)
      },
      onResync: () => {
        // A seq gap means the cursor dropped journal entries: force a rebuild that re-anchors
        // the session at its last seen seq and re-drains the missed window. The replacement
        // cursor cannot gap on its first event (undefined lastSeq), so no rebuild storm.
        if (current()) rebuild()
      },
    }
    unsubscribe = subscribeSessionNotifications(
      client,
      [...ids],
      handlers,
      {
        after: (sessionID) => after.get(sessionID),
        subscribeHint: input.subscribeHint,
        active: input.active,
      },
      pollMs,
    )
  }

  const refresh = (force = false) => {
    if (disposed) return
    const nextDirectory = input.currentDirectory()
    if (nextDirectory === undefined) {
      generation++
      abort.abort()
      directory = ""
      sessionIDs = []
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = undefined
      }
      return
    }
    const next = input.sessionsOf(nextDirectory)
    const changed =
      force ||
      nextDirectory !== directory ||
      next.length !== sessionIDs.length ||
      !next.every((id) => sessionIDs.includes(id))
    if (!changed) return
    directory = nextDirectory
    sessionIDs = [...next]
    rebuild()
  }

  return {
    refresh,
    dispose: () => {
      disposed = true
      generation++
      abort.abort()
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}
