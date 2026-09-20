// EventV2 persists sync events with a versioned type (`EventV2.versionedType` in core/event.ts
// produces `session.execution.started.1` for a definition typed `session.execution.started` with
// `sync.version = 1`). The durable drain surface (`/context/events`) returns `EventTable.type`
// verbatim, so consumers that key on the definition type must strip the trailing version segment
// first. The SSE mirror instead emits the unversioned definition type, so this strip is a no-op
// there — the helper is safe for both wire shapes.

export const eventBaseType = (type: string): string => type.replace(/\.\d+$/, "")
