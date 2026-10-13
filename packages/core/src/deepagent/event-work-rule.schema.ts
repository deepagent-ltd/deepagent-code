export * as EventWorkRuleSchema from "./event-work-rule.schema"

import { Schema } from "effect"
import { LocalAuthoritySchema } from "../session/local-authority.schema"
import { WorkAuthoritySchema } from "../session/work-authority.schema"
import { EventWorkDagSchema } from "./event-work-dag.schema"

export const MAX_RECORDS = 10_000
export const MAX_BYTES = 256 * 1024 * 1024
export const CONTROL_RECORDS = 768
// 32 enabled rules can each require a full-record stop receipt (up to 128KiB plus
// physical identity columns); the tail also permits existing binding-phase increments.
export const CONTROL_BYTES = 8 * 1024 * 1024
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Positive = Count.check(Schema.isGreaterThan(0))
// Session activity ordinals start at zero. -1 is the server-owned empty-session
// activation frontier; it is never an activity identity or an execution grant.
export const ActivityCutoff = Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Digest = WorkAuthoritySchema.Digest
export const Origin = Schema.Struct({
  id: Text, targetID: Text, source: Schema.Literal("ordinary_session_activity_terminal_v1"), sourceSessionID: Text,
})
export type Origin = typeof Origin.Type
export const DagOrigin = Schema.Struct({ ...Origin.fields,
  execution: Schema.Struct({ kind: Schema.Literal("dag"), plan: EventWorkDagSchema.Plan }),
})
export const AnyOrigin = Schema.Union([Origin, DagOrigin])
export type AnyOrigin = typeof AnyOrigin.Type
export const Source = Schema.Struct({
  version: Schema.Literal(1), kind: Schema.Literal("ordinary_session_activity_terminal_v1"),
  sessionID: Text, activityID: Text, activityOrdinal: Count, triggerInputID: Text,
  projectID: Text, directory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)), finalMessageID: Text, finalMessageHash: Digest,
  receiptChainHash: Digest, effectChainHash: Digest, settledAt: Positive,
})
export type Source = typeof Source.Type
export const Rule = Schema.Struct({
  version: Schema.Literal(1), ruleID: Text, instanceID: Text, operatorID: Text, origin: AnyOrigin,
  revision: Positive, epoch: Positive, state: Schema.Literals(["disabled", "enabled", "paused", "revoked"]),
  enabledAfterOrdinal: ActivityCutoff, target: LocalAuthoritySchema.ProjectTarget,
  instruction: Schema.String.check(Schema.isMinLength(1), Schema.makeFilter((value) => Buffer.byteLength(value, "utf8") <= 65_536)),
  operatorRevision: Positive, credentialGeneration: Positive, policyRevision: Positive, policyHash: Digest,
  expiresAt: Positive, createdAt: Positive, updatedAt: Positive,
})
export type Rule = typeof Rule.Type
export const Receipt = Schema.Struct({
  version: Schema.Literal(1), receiptID: Text, ruleID: Text, instanceID: Text, epoch: Positive,
  occurrenceKey: Digest, eventID: Text, source: Source, sourceHash: Digest, ruleHash: Digest,
  workID: Text, sessionID: Text, inputID: Text, deadline: Positive, createdAt: Positive,
  auditedText: Schema.String.check(Schema.makeFilter((value) => Buffer.byteLength(value, "utf8") <= 65_536)),
  auditedTextHash: Digest, authorityHash: Digest,
})
export type Receipt = typeof Receipt.Type
export const Command = Schema.Struct({ ruleID: Text, expectedRevision: Count,
  action: Schema.Literals(["create", "enable", "pause", "revoke"]), originID: Schema.optional(Text),
  instruction: Schema.optional(Schema.String.check(Schema.isMinLength(1),
    Schema.makeFilter((value) => Buffer.byteLength(value, "utf8") <= 60_000))), expiresAt: Schema.optional(Positive) })
export class Error extends Schema.TaggedErrorClass<Error>()("EventWorkRule.Error", {
  code: Schema.Literals(["EVENT_WORK_INVALID", "EVENT_WORK_AUTH_REQUIRED", "EVENT_WORK_SOURCE_CHANGED",
    "EVENT_WORK_CONFLICT", "EVENT_WORK_UNAVAILABLE", "EVENT_WORK_QUOTA", "EVENT_WORK_EXPIRED", "EVENT_WORK_LEGACY"]),
  message: Schema.String,
}) {}
