import { SessionV1 } from "@deepagent-code/core/v1/session"
import { legacyAssistant } from "@deepagent-code/core/session/legacy-wire"
import type { SessionMessage } from "@deepagent-code/sdk"

// 6b-4 — the TUI mirror of the app's v2-session-projector (§16.5 API-APP-PACKAGE P6): project a
// durable V2 message snapshot into the legacy SessionV1.WithParts rows the sync store (and every
// timeline consumer) reads. The server-side wire egress covers live sessions; this fills the
// hydration gap when the wire page lags the journal.

export type LegacyRow = SessionV1.WithParts

// The V1 row shape carries branded typed ids at the schema level while the projection layers
// operate over the runtime string ids of the V2 snapshot; the row builders cast at the row
// boundary (type-level bridge, runtime shape unchanged).
const baseInfo = (input: { readonly sessionID: string; readonly messageID: string; readonly timeCreated: number }) =>
  ({
    id: input.messageID,
    sessionID: input.sessionID,
    role: "user",
    time: { created: input.timeCreated },
    agent: "",
    model: { providerID: "", modelID: "" },
  }) as unknown as SessionV1.Info

export function userRow(input: {
  readonly sessionID: string
  readonly messageID: string
  readonly text: string
  readonly timeCreated: number
}): LegacyRow {
  return {
    info: baseInfo(input),
    parts: [
      {
        id: `prt_${input.messageID.slice("msg_".length)}_0` as unknown as SessionV1.PartID,
        sessionID: input.sessionID as never,
        messageID: input.messageID as never,
        type: "text",
        text: input.text,
        time: { start: input.timeCreated, end: input.timeCreated },
      },
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
          sessionID: input.sessionID as never,
          parentMessageID: "msg_parent" as never,
          directory: input.directory,
          root: input.root,
          message: message as never,
        }),
      )
    }
  }
  return rows
}
