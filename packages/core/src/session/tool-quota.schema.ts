export * as SessionToolQuota from "./tool-quota.schema"

import { Option, Schema } from "effect"
import { EventV2 } from "../event/define"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { SessionMessageID } from "./message-id"
import { SessionSchema } from "./schema"

export const LIMITS = Object.freeze({ loaded: 4096, newPerTurn: 2, proposals: 10, refBytes: 1024 })
const base = {
  sessionID: SessionSchema.ID,
  assistantMessageID: SessionMessageID.ID,
  toolCallID: Schema.String.check(Schema.makeFilter((value) => Buffer.byteLength(value) <= 1024)),
}
export const Ref = Schema.String.check(
  Schema.isPattern(/^doc:\S+$/),
  Schema.makeFilter((value) => Buffer.byteLength(value) <= LIMITS.refBytes),
)
export const Loaded = EventV2.define({
  type: "session.domain_pack.loaded",
  sync: { aggregate: "sessionID", version: 1 },
  schema: { ...base, ref: Ref },
})
export const Reserved = EventV2.define({
  type: "session.knowledge_propose.reserved",
  sync: { aggregate: "sessionID", version: 1 },
  schema: { ...base, inputHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)) },
})
export const types = [EventV2.durableType(Loaded), EventV2.durableType(Reserved)]
export const SnapshotFact = Schema.Struct({
  id: EventV2.ID,
  aggregate_id: SessionSchema.ID,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  type: Schema.Literals(["session.domain_pack.loaded.1", "session.knowledge_propose.reserved.1"]),
  data: Schema.Record(Schema.String, Schema.Unknown),
  hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
export type SnapshotFact = typeof SnapshotFact.Type
export function digest(row: {
  id: string
  aggregate_id: string
  seq: number
  type: string
  data: Record<string, unknown>
}) {
  return Hash.sha256(CanonicalJson.stringify(row))
}
export function reservationID(data: { sessionID: string; assistantMessageID: string; toolCallID: string }) {
  return EventV2.ID.make(
    `evt_knowledge_quota_${Hash.sha256(
      CanonicalJson.stringify({
        sessionID: data.sessionID,
        assistantMessageID: data.assistantMessageID,
        toolCallID: data.toolCallID,
      }),
    )}`,
  )
}
export function valid(row: SnapshotFact) {
  const definition = row.type === types[0] ? Loaded : Reserved
  const decoded = Schema.decodeUnknownOption(definition.data, { onExcessProperty: "error" })(row.data)
  if (Option.isNone(decoded) || decoded.value.sessionID !== row.aggregate_id) return false
  if (row.type === types[1] && row.id !== reservationID(decoded.value)) return false
  return (
    row.hash === digest({ id: row.id, aggregate_id: row.aggregate_id, seq: row.seq, type: row.type, data: row.data })
  )
}
