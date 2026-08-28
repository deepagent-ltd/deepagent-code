import type { SessionEventCursor } from "@deepagent-code/sdk/v2/client"
import { toNotificationEvent, type NotificationEvent } from "./v2-notification-mapping"

// §16.5 API-APP-PACKAGE P3 — per-session durable notification subscription. The notification
// feed listens to the volatile GlobalBus once for ALL sessions; the durable replacement
// subscribes each known session's V2 event journal via the P2 cursor primitive and maps
// journal events through toNotificationEvent. Resync (seq gap) triggers a fresh subscribe.
//
// P5: each cursor is anchored at the caller-supplied after-cursor (the session journal
// watermark on first subscribe, the last seen seq on rebuild) so a rebuild never re-replays
// the full journal; onJournalEvent feeds seq tracking to the caller.

export type NotificationHandlers = {
  readonly onIdle: (sessionID: string) => void
  readonly onError: (sessionID: string, error: NonNullable<NotificationEvent["error"]>) => void
  readonly onResync?: (sessionID: string) => void
  readonly onErrorEvent?: (error: unknown) => void
  readonly onJournalEvent?: (
    sessionID: string,
    event: { readonly type?: string; readonly seq?: number; readonly data?: Record<string, unknown> },
  ) => void
}

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
  }
}

export const subscribeSessionNotifications = (
  client: CursorClient,
  sessionIDs: readonly string[],
  handlers: NotificationHandlers,
  resolver?: { readonly after?: (sessionID: string) => string | undefined },
): (() => void) => {
  const cursors: SessionEventCursor[] = []
  for (const sessionID of sessionIDs) {
    cursors.push(
      client.session.sessionEventCursor(sessionID, {
        after: resolver?.after?.(sessionID),
        onEvent: (event) => {
          handlers.onJournalEvent?.(sessionID, event)
          const mapped = toNotificationEvent(event.type ?? "", event.data ?? {})
          if (!mapped?.sessionID) return
          if (mapped.type === "session.idle") handlers.onIdle(mapped.sessionID)
          else if (mapped.error) handlers.onError(mapped.sessionID, mapped.error)
        },
        onResync: () => handlers.onResync?.(sessionID),
        onError: (error) => handlers.onErrorEvent?.(error),
      }),
    )
  }
  return () => {
    for (const cursor of cursors) cursor.close()
    cursors.length = 0
  }
}