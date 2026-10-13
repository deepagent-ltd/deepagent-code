export * as EventInvestigationPolicy from "./event-investigation-policy"

import { Option, Schema } from "effect"
import { WorkAuthorityPolicy } from "../session/work-authority-policy"
import { WorkAuthoritySchema } from "../session/work-authority.schema"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { EventInvestigationSchema } from "./event-investigation.schema"
import { EventValidationSchema } from "./event-validation.schema"

export const hash = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))

export function failureKey(evidence: Pick<EventInvestigationSchema.Evidence,
  "instanceID" | "ruleID" | "contentRevision" | "contentHash" | "recipeHash">) {
  return hash(["event-investigation-failure.v1", evidence.instanceID, evidence.ruleID,
    evidence.contentRevision, evidence.contentHash, evidence.recipeHash])
}

export function identities(key: string) {
  return { receiptID: `evinv_${key}`, workID: `work_evinv_${key.slice(0, 40)}`,
    sessionID: `ses_v4_${key.slice(0, 40)}`, inputID: `msg_evinv_${key.slice(0, 40)}`,
    attemptKey: `attempt_evinv_${key.slice(0, 40)}` }
}

/** No bindingHash in this snapshot: the binding itself references this authority hash. */
export function authorityHash(receipt: Omit<EventInvestigationSchema.Receipt, "authorityHash" | "bindingHash">) {
  return hash({ version: "event-investigation-source.v1", receiptID: receipt.receiptID,
    instanceID: receipt.instanceID, ruleID: receipt.ruleID, projectKey: receipt.projectKey,
    securityNamespaceID: receipt.securityNamespaceID, failureKey: receipt.failureKey,
    runID: receipt.runID, grantEpoch: receipt.grantEpoch,
    workID: receipt.workID, rootWorkID: receipt.rootWorkID, sessionID: receipt.sessionID, inputID: receipt.inputID,
    sourceRequestID: receipt.sourceRequestID, deadline: receipt.deadline, createdAt: receipt.createdAt,
    grantHash: receipt.grantHash, evidenceHash: receipt.evidenceHash,
    auditedTextHash: receipt.auditedTextHash, auditedTextBytes: receipt.auditedTextBytes })
}

/** Only immutable source data is lowered. This function provides no execution permission. */
export function bindingFor(receipt: Omit<EventInvestigationSchema.Receipt, "bindingHash">): WorkAuthoritySchema.ProjectBinding {
  const target = receipt.grant.target
  return { schemaVersion: "work-execution.v2", workID: receipt.workID, rootWorkID: receipt.rootWorkID,
    attemptKey: identities(receipt.failureKey).attemptKey,
    source: { kind: "server_rule", authorityID: receipt.receiptID, authorityRevision: receipt.grantEpoch,
      sourceID: receipt.runID, requestID: receipt.sourceRequestID, requestHash: receipt.authorityHash },
    envelopeHash: hash({ version: "event-investigation-envelope.v1", authorityHash: receipt.authorityHash }),
    scope: target.scope, location: target.location, agentID: target.agentID,
    sessionID: receipt.sessionID, inputID: receipt.inputID, profile: target.profile,
    auditedText: { hash: receipt.auditedTextHash, utf8Bytes: receipt.auditedTextBytes,
      snapshotRef: `event-investigation:${receipt.receiptID}` },
    projectScope: target.projectScope, contextPolicy: target.contextPolicy, toolPolicy: target.toolPolicy,
    childPolicy: target.childPolicy, provider: target.provider, budget: target.budget, deadline: receipt.deadline }
}

export function expectedFile(receipt: Pick<EventInvestigationSchema.Receipt, "evidence">, relative: string) {
  return receipt.evidence.content.files.find((file) => file.relative === relative && !file.missing)
}

export function validReceipt(input: unknown): input is EventInvestigationSchema.Receipt {
  const value = Schema.decodeUnknownOption(EventInvestigationSchema.Receipt, { onExcessProperty: "error" })(input)
  if (Option.isNone(value)) return false
  const receipt = value.value
  const ids = identities(receipt.failureKey)
  const binding = WorkAuthorityPolicy.validateBinding(bindingFor(receipt))
  return receipt.failureKey === failureKey(receipt.evidence) && receipt.receiptID === ids.receiptID &&
    receipt.workID === ids.workID && receipt.sessionID === ids.sessionID && receipt.inputID === ids.inputID &&
    receipt.grantHash === hash(receipt.grant) && receipt.evidenceHash === hash(receipt.evidence) &&
    receipt.auditedTextHash === Hash.sha256(receipt.auditedText) && receipt.authorityHash === authorityHash(receipt) &&
    binding.ok && receipt.bindingHash === WorkAuthorityPolicy.fingerprint(binding.value)
}

/** Stable known failure checks, independently repeated against durable current rows. */
export function evidenceFor(rule: EventValidationSchema.RuleRecord, run: EventValidationSchema.RunRecord): EventInvestigationSchema.Evidence | undefined {
  if (run.state !== "settled" || run.outcome !== "failed" || !run.resultCurrent || !run.result ||
    run.result.outcome !== "failed" || !run.result.stopConfirmed || !run.result.stdout.complete || !run.result.stderr.complete ||
    !run.snapshotHash || !run.processIncarnation || rule.state !== "enabled" || rule.currentRunID !== run.runID ||
    rule.revision !== run.ruleRevision || rule.contentRevision !== run.contentRevision || rule.contentHash !== run.contentHash ||
    rule.configHash !== run.configHash || hash(rule.configuration.recipe) !== run.recipeHash) return undefined
  const descriptor = (stream: EventValidationSchema.Result["stdout"]) => ({ sha256: stream.sha256,
    bytes: stream.bytes, capturedBytes: stream.capturedBytes, truncated: stream.truncated,
    complete: true as const, excerptTruncated: stream.excerptTruncated })
  return { version: 1, instanceID: run.instanceID, ruleID: run.ruleID, runID: run.runID,
    testRunID: run.testRunID, previewBuildID: run.previewBuildID, ruleRevision: run.ruleRevision,
    contentRevision: run.contentRevision, contentHash: run.contentHash, recipeHash: run.recipeHash, configHash: run.configHash,
    snapshotHash: run.snapshotHash, processIncarnation: run.processIncarnation, scopeHash: hash(rule.configuration.scope),
    content: run.content, resultHash: hash(run.result), result: { outcome: "failed", exitCode: run.result.exitCode,
      signal: run.result.signal, stopConfirmed: true, endedAt: run.result.endedAt,
      stdout: descriptor(run.result.stdout), stderr: descriptor(run.result.stderr) } }
}

export function currentFailure(rule: EventValidationSchema.RuleRecord, run: EventValidationSchema.RunRecord,
  evidence: EventInvestigationSchema.Evidence) {
  const expected = evidenceFor(rule, run)
  return expected !== undefined && hash(evidence) === hash(expected)
}
