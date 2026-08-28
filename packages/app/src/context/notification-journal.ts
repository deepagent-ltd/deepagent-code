import type { SessionEventCursor } from "@deepagent-code/sdk/v2/client"
import { subscribeSessionNotifications, type NotificationHandlers } from "./v2-notification-subscription"

// §16.5 API-APP-PACKAGE P5 — durable replacement of the notification feed GlobalBus
// listener. The volatile stream notified idle/error for every session at once; the durable
// surface subscribes each known session V2 journal via the P2/P3 cursor primitive anchored at
// the session journal watermark (first subscribe) or the last seen seq (rebuild), so no
// rebuild ever re-replays history. The known set is the active directory session list.

type CursorClient = {
  readonly session: {
    readonly sessionEventCursor: (
      sessionId: string,
      input: {
        readonly after?: string
        readonly onEvent: (event: {
          readonly type?: string
          readonly seq?: number
          readonly data?: Record<string, unknown>
        }) => void
        readonly onResync?: () => void
        readonly onError?: (error: unknown) => void
      },
    ) => SessionEventCursor
    readonly sessionEventWatermark: (sessionId: string) => Promise<number | undefined>
  }
}

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

export const createNotificationJournalSubscription = (input: {
  readonly client: CursorClient
  readonly currentDirectory: () => string | undefined
  readonly sessionsOf: (directory: string) => readonly string[]
  readonly handlers: NotificationJournalHandlers
}): { readonly dispose: () => void; readonly refresh: (force?: boolean) => void } => {
  let unsubscribe: (() => void) | undefined
  let directory = ""
  let sessionIDs: readonly string[] = []
  const lastSeqs = new Map<string, number>()

  const rebuild = (force: boolean) => {
    unsubscribe?.()
    unsubscribe = undefined
    if (sessionIDs.length === 0) return
    void subscribe(sessionIDs, force).catch((error: unknown) => input.handlers.onErrorEvent?.(error))
  }

  async function subscribe(ids: readonly string[], force: boolean) {
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
        const watermark = await input.client.session.sessionEventWatermark(sessionID).catch(() => undefined)
        after.set(sessionID, watermark === undefined ? undefined : String(watermark))
      }),
    )
    const handlers: NotificationHandlers = {
      onIdle: (sessionID) => input.handlers.onIdle(directory, sessionID, Date.now()),
      onError: (sessionID, error) => input.handlers.onError(directory, sessionID, error, Date.now()),
      onErrorEvent: input.handlers.onErrorEvent,
      onJournalEvent: (sessionID, event) => {
        if (event.seq !== undefined) lastSeqs.set(sessionID, event.seq)
      },
      onResync: () => {
        // A seq gap means the cursor dropped journal entries: force a rebuild that re-anchors
        // the session at its last seen seq and re-drains the missed window. The replacement
        // cursor cannot gap on its first event (undefined lastSeq), so no rebuild storm.
        rebuild(true)
      },
    }
    unsubscribe = subscribeSessionNotifications(input.client, [...ids], handlers, {
      after: (sessionID) => after.get(sessionID),
    })
  }

  const refresh = (force = false) => {
    const nextDirectory = input.currentDirectory()
    if (nextDirectory === undefined) {
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
    sessionIDs = next
    rebuild(false)
  }

  return {
    refresh,
    dispose: () => {
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}