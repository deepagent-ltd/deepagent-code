export * as EventInvestigationSchema from "./event-investigation.schema"

import { Schema } from "effect"
import { CanonicalJson } from "../util/canonical-json"
import { WorkAuthoritySchema } from "../session/work-authority.schema"
import { EventValidationSchema } from "./event-validation.schema"
import { EventInvestigationAuthoritySchema } from "./event-investigation-authority.schema"

export const MAX_EVIDENCE_BYTES = 65_536
export const MAX_AUDITED_TEXT_BYTES = 65_536
export const MAX_RECEIPT_BYTES = 262_144
export const MAX_RECEIPTS = 10_000
export const MAX_INSTANCE_BYTES = 268_435_456
const ID = EventValidationSchema.ID
const Digest = EventValidationSchema.Digest
const Positive = EventValidationSchema.Positive
export const GrantCommand = Schema.Struct({
  ruleID: ID, requestID: ID, operation: Schema.Literals(["enable", "disable"]),
  expectedEpoch: EventValidationSchema.Count, expectedOperatorRevision: Positive,
  targetID: Schema.NullOr(ID), expiresAt: Schema.NullOr(Positive),
}).check(Schema.makeFilter((value) => value.operation === "enable"
  ? value.targetID !== null && value.expiresAt !== null : value.targetID === null && value.expiresAt === null))
export type GrantCommand = typeof GrantCommand.Type
export const Candidates = Schema.Struct({
  ruleID: ID, ruleRevision: Positive, operatorRevision: Positive, epoch: EventValidationSchema.Count, maxExpiresAt: Positive,
  targets: Schema.Array(Schema.Struct({ targetID: ID,
    profile: Schema.Struct({ id: Schema.Literal("event_investigate_v1"), version: Schema.Literal(1), hash: Digest }),
    provider: Schema.Struct({ providerID: ID, modelID: ID, routeID: ID }),
    read: Schema.Array(EventValidationSchema.File.fields.relative).check(Schema.isMaxLength(128)),
    budget: WorkAuthoritySchema.Budget, durationMs: Positive,
  })).check(Schema.isMaxLength(32)),
})
export type Candidates = typeof Candidates.Type
export const Reports = Schema.Array(Schema.Struct({
  receiptID: ID, failureKey: Digest, runID: ID, contentRevision: Positive, contentHash: Digest,
  sessionID: ID, grantEpoch: Positive, createdAt: Positive, deadline: Positive,
  work: Schema.Struct({ admissionState: WorkAuthoritySchema.AdmissionState, controlState: WorkAuthoritySchema.ControlState,
    controlRevision: Positive, outcome: WorkAuthoritySchema.Outcome }),
})).check(Schema.isMaxLength(32))
export type Reports = typeof Reports.Type
const Stream = Schema.Struct({
  sha256: Digest, bytes: EventValidationSchema.Count,
  capturedBytes: EventValidationSchema.Stream.fields.capturedBytes,
  truncated: Schema.Boolean, complete: Schema.Literal(true), excerptTruncated: Schema.Boolean,
}).check(Schema.makeFilter((value) => value.capturedBytes <= value.bytes))

/** Stable failed projection. Workspace custody, cleanup and mutable Run revision are excluded. */
export const Evidence = Schema.Struct({
  version: Schema.Literal(1), instanceID: ID, ruleID: ID, runID: ID,
  testRunID: Schema.NullOr(ID), previewBuildID: Schema.NullOr(ID),
  ruleRevision: Positive, contentRevision: Positive, contentHash: Digest, recipeHash: Digest, configHash: Digest,
  snapshotHash: Digest, processIncarnation: ID, scopeHash: Digest,
  content: EventValidationSchema.Content, resultHash: Digest,
  result: Schema.Struct({ outcome: Schema.Literal("failed"), exitCode: EventValidationSchema.Result.fields.exitCode,
    signal: EventValidationSchema.Result.fields.signal, stopConfirmed: Schema.Literal(true), endedAt: Positive,
    stdout: Stream, stderr: Stream }),
}).check(Schema.makeFilter((value) => Buffer.byteLength(CanonicalJson.stringify(value)) <= MAX_EVIDENCE_BYTES &&
  value.content.contentHash === value.contentHash && (value.testRunID === null) !== (value.previewBuildID === null)))
export type Evidence = typeof Evidence.Type

export const Receipt = Schema.Struct({
  version: Schema.Literal(1), receiptID: ID, instanceID: ID, ruleID: ID, projectKey: Digest, securityNamespaceID: ID,
  contentRevision: Positive, contentHash: Digest, recipeHash: Digest, failureKey: Digest,
  runID: ID, grantEpoch: Positive, authorityHash: Digest,
  workID: ID, rootWorkID: ID, sessionID: ID, inputID: ID, sourceRequestID: ID, bindingHash: Digest,
  deadline: Positive, createdAt: Positive,
  grant: EventInvestigationAuthoritySchema.Grant, grantHash: Digest,
  evidence: Evidence, evidenceHash: Digest,
  auditedText: Schema.String.check(Schema.makeFilter((value: string) => Buffer.byteLength(value) <= MAX_AUDITED_TEXT_BYTES)),
  auditedTextHash: Digest, auditedTextBytes: EventValidationSchema.Count,
}).check(Schema.makeFilter((value) => Buffer.byteLength(CanonicalJson.stringify(value)) <= MAX_RECEIPT_BYTES &&
  value.deadline > value.createdAt && value.rootWorkID === value.workID && value.sourceRequestID === value.failureKey &&
  value.grant.epoch === value.grantEpoch && value.grant.ruleID === value.ruleID &&
  value.grant.principal.instanceID === value.instanceID && value.grant.target.scope.securityNamespaceID === value.securityNamespaceID &&
  value.evidence.instanceID === value.instanceID && value.evidence.ruleID === value.ruleID && value.evidence.runID === value.runID &&
  value.evidence.contentRevision === value.contentRevision && value.evidence.contentHash === value.contentHash &&
  value.evidence.recipeHash === value.recipeHash && value.auditedTextBytes === Buffer.byteLength(value.auditedText)))
export type Receipt = typeof Receipt.Type

export class Error extends Schema.TaggedErrorClass<Error>()("EventInvestigation.Error", {
  code: Schema.Literals(["INVESTIGATION_INVALID", "INVESTIGATION_UNAVAILABLE", "INVESTIGATION_AUTH_REQUIRED",
    "INVESTIGATION_CONFLICT", "INVESTIGATION_SOURCE_CHANGED", "INVESTIGATION_EXPIRED", "INVESTIGATION_CAPACITY",
    "INVESTIGATION_RECOVERY_REQUIRED"]),
  message: Schema.String,
}) {}
