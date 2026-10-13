export * as WorkChildAuthoritySchema from "./work-child-authority.schema"

import { Schema } from "effect"
import { WorkAuthoritySchema } from "./work-authority.schema"

const ID = Schema.String.check(Schema.isMinLength(1), Schema.makeFilter((value: string) => Buffer.byteLength(value) <= 512))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const Record = Schema.Struct({
  version: Schema.Literal(1), childWorkID: ID, rootWorkID: ID, parentWorkID: ID, taskRunID: ID,
  childSessionID: ID, childInputID: ID, childBindingHash: WorkAuthoritySchema.Digest,
  parentBinding: WorkAuthoritySchema.ProjectBinding, rootBinding: WorkAuthoritySchema.ProjectBinding,
  parentBindingHash: WorkAuthoritySchema.Digest, rootBindingHash: WorkAuthoritySchema.Digest,
  parentRevision: Count, rootRevision: Count,
  parentSessionID: ID, parentMessageID: ID, toolCallID: ID, admissionID: ID,
  receiptID: ID, attemptID: ID, ownerToken: ID, sessionClaimToken: Count,
  activityID: ID, activityOrdinal: Count, triggerInputID: ID, expectedInputSeq: Count,
  toolInputHash: WorkAuthoritySchema.Digest, definitionHash: WorkAuthoritySchema.Digest,
  registrationGeneration: ID, expiresAt: Count, createdAt: Count,
})
export type Record = typeof Record.Type
