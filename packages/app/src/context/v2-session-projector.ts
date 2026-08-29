import { SessionV1 } from "@deepagent-code/core/v1/session"
import { legacyAssistant } from "@deepagent-code/core/session"
import type { SessionMessage } from "@deepagent-code/sdk"

// §16.5 API-APP-PACKAGE P6 — the App main session rendering capability seam. The timeline
// consumes legacy SessionV1.WithParts rows (the same shape serverSync stores); this module
// projects the durable V2 source (snapshot + journal boundaries) into that shape so the
// existing timeline consumers can render journal-driven sessions without a UI rewrite.
//
// Snapshot: v2.session.messages rows -> rows (assistant via the canonical
// SessionV2.legacyAssistant converter, user rows via the local builder). Live: journal
// boundaries -> row updates. The volatile global feed stays the delta notification surface;
// deltas are live-only and never appear in the journal.

export type LegacyRow = SessionV1.WithParts

type BoundaryEvent = {
  readonly type: string
  readonly data?: Record<string, unknown>
}

const stringValue = (value: unknown) => (typeof value === "string" ? value : undefined)
const numberValue = (value: unknown) => (typeof value === "number" ? value : undefined)
const recordValue = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

// The V1 row shape carries branded typed ids at the schema level while the projection layers
// operate over the runtime string ids of the journal; the row builders cast at the row
// boundary (type-level bridge, runtime shape unchanged).
const baseInfo = (input: {
  readonly sessionID: string
  readonly messageID: string
  readonly timeCreated: number
}) =>
  ({
    id: input.messageID,
    sessionID: input.sessionID,
    role: "user",
    time: { created: input.timeCreated },
    parentID: "msg_parent",
    modelID: "",
    providerID: "",
    mode: "",
    agent: "",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }) as unknown as SessionV1.Info

const idTextPart = (input: {
  readonly sessionID: string
  readonly messageID: string
  readonly partID: string
}) => (input.partID as unknown as SessionV1.PartID)

const idMessage = (input: string) => (input as unknown as SessionV1.MessageID)

export function userRow(input: {
  readonly sessionID: string
  readonly messageID: string
  readonly text: string
  readonly timeCreated: number
}): LegacyRow {
  const messageID = idMessage(input.messageID)
  return {
    info: baseInfo({
      sessionID: input.sessionID,
      messageID: input.messageID,
      timeCreated: input.timeCreated,
    }),
    parts: [
      {
        id: idTextPart({ sessionID: input.sessionID, messageID: input.messageID, partID: `prt_${input.messageID}_0` }),
        sessionID: input.sessionID as unknown as SessionV1.Part["sessionID"],
        messageID: idMessage(input.messageID),
        type: "text",
        text: input.text,
        time: { start: input.timeCreated },
      } as SessionV1.Part,
    ],
  }
}

// A compaction.ended boundary projects into the legacy user row carrying a compaction part —
// the shape the timeline renders as its "compaction" turn divider (message-timeline.data).
// The row is keyed by the compaction message id and its part id is derived from it, so a
// crash-replay re-publish of the same boundary upserts deterministically (idempotent).
export function compactionRow(input: {
  readonly sessionID: string
  readonly messageID: string
  readonly reason: string | undefined
  readonly timeCreated: number
}): LegacyRow {
  const messageID = idMessage(input.messageID)
  return {
    info: baseInfo({
      sessionID: input.sessionID,
      messageID: input.messageID,
      timeCreated: input.timeCreated,
    }),
    parts: [
      {
        id: idTextPart({ sessionID: input.sessionID, messageID: input.messageID, partID: `prt_${input.messageID}_0` }),
        sessionID: input.sessionID as unknown as SessionV1.Part["sessionID"],
        messageID,
        type: "compaction",
        auto: input.reason !== "manual",
      } as SessionV1.Part,
    ],
  }
}

export function snapshotRows(input: {
  readonly sessionID: string
  readonly directory: string
  readonly root: string
  readonly messages: readonly SessionMessage[]
}): LegacyRow[] {
  const rows: LegacyRow[] = []
  for (const message of input.messages) {
    if (message.type === "user") {
      rows.push(
        userRow({
          sessionID: input.sessionID,
          messageID: message.id,
          text: message.text,
          timeCreated: message.time.created,
        }),
      )
      continue
    }
    if (message.type === "assistant") {
      rows.push(
        legacyAssistant({
          sessionID: input.sessionID as unknown as Parameters<typeof legacyAssistant>[0]["sessionID"],
          parentMessageID: "msg_parent" as unknown as Parameters<typeof legacyAssistant>[0]["parentMessageID"],
          directory: input.directory,
          root: input.root,
          message: message as unknown as Parameters<typeof legacyAssistant>[0]["message"],
        }),
      )
    }
  }
  return rows
}

const pushOrUpdatePart = (
  rows: LegacyRow[],
  messageID: string,
  part: SessionV1.Part,
) => {
  const row = rows.find((item) => item.info.id === messageID)
  if (!row) return
  const index = row.parts.findIndex((item) => item.id === part.id)
  if (index < 0) {
    row.parts.push(part)
    return
  }
  row.parts[index] = part
}

// Journal boundary events are full-value and replayable; each case is idempotent by part id
// (a snapshot overlap re-applies the same boundary and converges).
export function applyBoundary(rows: LegacyRow[], event: BoundaryEvent): LegacyRow[] {
  const data = event.data ?? {}
  const sessionID = stringValue(data.sessionID)
  if (!sessionID) return rows
  const created = numberValue(data.timestamp) ?? 0

  switch (event.type) {
    case "session.next.prompt.promoted":
    case "session.next.prompted": {
      const messageID = stringValue(data.messageID)
      const text = recordValue(data.prompt).text
      if (!messageID || typeof text !== "string") return rows
      if (rows.some((item) => item.info.id === messageID)) return rows
      rows.push(userRow({ sessionID, messageID, text, timeCreated: created }))
      return rows
    }
    case "session.next.step.started": {
      const messageID = stringValue(data.assistantMessageID)
      if (!messageID) return rows
      if (rows.some((item) => item.info.id === messageID)) return rows
      rows.unshift(
        legacyAssistant({
          sessionID: sessionID as unknown as Parameters<typeof legacyAssistant>[0]["sessionID"],
          parentMessageID: "msg_parent" as unknown as Parameters<typeof legacyAssistant>[0]["parentMessageID"],
          directory: "",
          root: "",
          message: {
            id: messageID,
            type: "assistant",
            agent: stringValue(data.agent) ?? "",
            model: { id: "", providerID: "", variant: undefined },
            content: [],
            time: { created },
          } as unknown as Parameters<typeof legacyAssistant>[0]["message"],
        }),
      )
      return rows
    }
    case "session.next.text.ended": {
      const messageID = stringValue(data.assistantMessageID)
      const partID = stringValue(data.textID)
      const text = stringValue(data.text)
      if (!messageID || !partID || text === undefined) return rows
      pushOrUpdatePart(rows, messageID, {
        id: idTextPart({ sessionID, messageID, partID }),
        sessionID: sessionID as unknown as SessionV1.Part["sessionID"],
        messageID: idMessage(messageID),
        type: "text",
        text,
        time: { start: created, end: created },
      } as SessionV1.Part)
      return rows
    }
    case "session.next.reasoning.ended": {
      const messageID = stringValue(data.assistantMessageID)
      const partID = stringValue(data.reasoningID)
      const text = stringValue(data.text)
      if (!messageID || !partID || text === undefined) return rows
      pushOrUpdatePart(rows, messageID, {
        id: idTextPart({ sessionID, messageID, partID }),
        sessionID: sessionID as unknown as SessionV1.Part["sessionID"],
        messageID: idMessage(messageID),
        type: "reasoning",
        text,
        time: { start: created, end: created },
      } as SessionV1.Part)
      return rows
    }
    case "session.next.tool.success": {
      const callID = stringValue(data.callID)
      const messageID = stringValue(data.assistantMessageID)
      if (!callID || !messageID) return rows
      const content = data.content
      const output = Array.isArray(content)
        ? content.map((item) => (typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : "")).join("\n")
        : ""
      pushOrUpdatePart(rows, messageID, {
        id: idTextPart({ sessionID, messageID, partID: `prt_${messageID}_${callID}` }),
        sessionID: sessionID as unknown as SessionV1.Part["sessionID"],
        messageID: idMessage(messageID),
        type: "tool",
        callID,
        tool: stringValue(data.tool) ?? "tool",
        state: {
          status: "completed",
          input: recordValue(data.input),
          output,
          title: stringValue(data.tool) ?? "tool",
          time: { start: created, end: created },
        } as SessionV1.ToolPart["state"],
      } as SessionV1.Part)
      return rows
    }
    case "session.next.tool.failed": {
      const callID = stringValue(data.callID)
      const messageID = stringValue(data.assistantMessageID)
      if (!callID || !messageID) return rows
      pushOrUpdatePart(rows, messageID, {
        id: idTextPart({ sessionID, messageID, partID: `prt_${messageID}_${callID}` }),
        sessionID: sessionID as unknown as SessionV1.Part["sessionID"],
        messageID: idMessage(messageID),
        type: "tool",
        callID,
        tool: stringValue(data.tool) ?? "tool",
        state: {
          status: "error",
          input: recordValue(data.input),
          error: recordValue(data.error).message ?? "tool failed",
          time: { start: created, end: created },
        } as SessionV1.ToolPart["state"],
      } as SessionV1.Part)
      return rows
    }
    case "session.next.compaction.ended": {
      const messageID = stringValue(data.messageID)
      if (!messageID) return rows
      // Deterministic upsert by message id: the crash-replay window may re-publish the same
      // Compaction.Ended boundary; a second application must converge to the same row set.
      if (rows.some((item) => item.info.id === messageID)) return rows
      rows.push(compactionRow({ sessionID, messageID, reason: stringValue(data.reason), timeCreated: created }))
      return rows
    }
  }
  return rows
}