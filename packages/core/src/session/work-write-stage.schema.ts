export * as WorkWriteStageSchema from "./work-write-stage.schema"

import { Schema } from "effect"
import { WorkAuthoritySchema } from "./work-authority.schema"

export const MAX_RECORD_BYTES = 16_384
export const MAX_CUSTODY = 32
export const MAX_RETAINED_BYTES = 268_435_456
export const MAX_RECORDS = 10_000
export const METADATA_RESERVATION = 32_768
export const MAX_CONTENT_BYTES = 51_200
export const MAX_PREVIOUS_BYTES = 16_777_216
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const Revision = Count.check(Schema.isGreaterThanOrEqualTo(1))
export const ID = Schema.String.check(Schema.isMinLength(1),
  Schema.makeFilter((value: string) => Buffer.byteLength(value) <= 512 && !/[\u0000-\u001f\u007f]/.test(value)))
export const Digest = WorkAuthoritySchema.Digest
export const Identity = WorkAuthoritySchema.ProjectBinding.fields.projectScope.fields.rootIdentity
export const Relative = Schema.String.check(Schema.isMinLength(1), Schema.makeFilter((value: string) =>
  Buffer.byteLength(value) <= 2048 && !/[\\:\u0000-\u001f\u007f]/.test(value) && value.split("/").length <= 32 &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..")))
export const Expected = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("missing") }),
  Schema.Struct({ kind: Schema.Literal("observed"), effectID: ID, outcomeHash: Digest,
    identity: Identity, sha256: Digest, bytes: Count.check(Schema.isLessThanOrEqualTo(MAX_PREVIOUS_BYTES)) }),
])
export type Expected = typeof Expected.Type
export const State = Schema.Literals(["reserved", "prepared", "publication_unknown", "published", "refused"])
export type State = typeof State.Type

/** Capacity/custody facts only. This record neither dispatches a tool nor authorizes retry.
 * Identity fields never change. Native identities are filled once after durable reservation.
 * Retained bytes describe observed objects, not immutable snapshots or physical disk limits. */
export const Record = Schema.Struct({
  version: Schema.Literal(1), stageID: ID, instanceID: ID,
  workID: ID, rootWorkID: ID, sessionID: ID, inputID: ID, activityID: ID,
  providerReceiptID: ID, providerAttemptID: ID, admissionID: ID, toolCallID: ID,
  ownerToken: ID, sessionClaimToken: Revision, bindingHash: Digest, controlRevision: Revision,
  requestHash: Digest, definitionHash: Digest, helperHash: Digest,
  relative: Relative,
  basename: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  rootIdentity: Identity, parentIdentity: Schema.NullOr(Identity), stageIdentity: Schema.NullOr(Identity),
  expected: Expected, nextHash: Digest,
  nextBytes: Count.check(Schema.isLessThanOrEqualTo(MAX_CONTENT_BYTES)),
  state: State, revision: Revision, reservedBytes: Count, observedRetainedBytes: Count,
  createdAt: Revision, updatedAt: Revision, releasedAt: Schema.NullOr(Revision),
})
export type Record = typeof Record.Type
export const ErrorCode = Schema.Literals([
  "WRITE_STAGE_UNAVAILABLE", "WRITE_STAGE_INVALID_RECORD", "WRITE_STAGE_CONFLICT",
  "WRITE_STAGE_CAPACITY", "WRITE_STAGE_UNKNOWN",
])
export class Error extends Schema.TaggedErrorClass<Error>()("WorkWriteStage.Error", {
  code: ErrorCode, message: Schema.String,
}) {}
