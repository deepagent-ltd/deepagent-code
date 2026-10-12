// V2 durable event → app notification mapping. The notification feed drains each
// session's journal through the cursor subscription; this is the single mapping
// source so the wiring layer does not re-derive terminal notification semantics.
//
// Only a succeeded execution may enter the completion-notification path. Interrupted
// executions (user stop, shutdown, superseded) still advance the journal cursor, but do
// not announce a ready response or fabricate an error for a deliberate cancellation.
// session.execution.failed carries the structured error payload.
//
// Journal row types are VERSIONED (`EventTable.type` = `session.execution.succeeded.1`): the
// suffix is stripped here (`eventBaseType`) so the same vocabulary matches both the SSE mirror
// (unversioned definition type) and the durable drain surface.

import { eventBaseType } from "@/utils/event-type"

export type NotificationEvent = {
  readonly type: "session.idle" | "session.error"
  readonly sessionID?: string
  readonly error?: { readonly type: "unknown"; readonly message: string }
}

export const toNotificationEvent = (type: string, data: Record<string, unknown>): NotificationEvent | undefined => {
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
  const baseType = eventBaseType(type)
  if (baseType === "session.execution.succeeded") return { type: "session.idle", sessionID }
  if (baseType === "session.execution.failed") {
    const error = data.error as { readonly message?: unknown } | undefined
    const message =
      typeof error?.message === "string" && error.message.length > 0 ? error.message : "Session execution failed"
    return { type: "session.error", sessionID, error: { type: "unknown", message } }
  }
  return undefined
}
