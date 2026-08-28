// §16.5 API-APP-PACKAGE P3 — V2 durable event → app notification mapping. The notification
// feed currently listens to the volatile GlobalBus (serverSDK.event.listen, session.idle /
// session.error). The durable replacement replays a session's V2 event journal via the P2
// cursor primitive; this module is the single mapping source from V2 journal events to the app
// notification semantics so the wiring layer never re-derives the vocabulary.
//
// V2 has no session.idle: a settled execution (succeeded / interrupted) is the durable idle
// signal; session.execution.failed carries the structured error payload.

export type NotificationEvent = {
  readonly type: "session.idle" | "session.error"
  readonly sessionID?: string
  readonly error?: { readonly type: "unknown"; readonly message: string }
}

export const toNotificationEvent = (type: string, data: Record<string, unknown>): NotificationEvent | undefined => {
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
  if (type === "session.execution.succeeded" || type === "session.execution.interrupted")
    return { type: "session.idle", sessionID }
  if (type === "session.execution.failed") {
    const error = data.error as { readonly message?: unknown } | undefined
    const message =
      typeof error?.message === "string" && error.message.length > 0 ? error.message : "Session execution failed"
    return { type: "session.error", sessionID, error: { type: "unknown", message } }
  }
  return undefined
}
