import { Option, Schema } from "effect"
import { EventValidation } from "@deepagent-code/core/deepagent/event-validation"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { EventInvestigationSchema } from "@deepagent-code/core/deepagent/event-investigation.schema"
import { WorkFileCapability } from "@deepagent-code/core/session/work-file-capability"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"

const unavailable = () =>
  new EventValidationSchema.Error({
    code: "VALIDATION_UNAVAILABLE",
    message: "The original known failure evidence is unavailable or changed",
  })

/** Physical evidence formatting only. This creates no grant, source receipt or Work
 * authority; the production caller must independently verify the current investigation grant. */
export function build(
  rule: EventValidationSchema.RuleRecord,
  run: EventValidationSchema.RunRecord,
  read: readonly string[],
) {
  const checkedRule = Schema.decodeUnknownOption(EventValidationSchema.RuleRecord, { onExcessProperty: "error" })(rule)
  const checkedRun = Schema.decodeUnknownOption(EventValidationSchema.RunRecord, { onExcessProperty: "error" })(run)
  if (Option.isNone(checkedRule) || Option.isNone(checkedRun)) throw unavailable()
  const result = run.result
  if (
    rule.state !== "enabled" ||
    run.state !== "settled" ||
    run.outcome !== "failed" ||
    !run.resultCurrent ||
    run.cancelRequested ||
    !result ||
    result.outcome !== "failed" ||
    !result.stopConfirmed ||
    !result.stdout.complete ||
    !result.stderr.complete ||
    !run.snapshotHash ||
    !run.processIncarnation ||
    run.terminalAt === null ||
    result.endedAt > run.terminalAt ||
    run.instanceID !== rule.instanceID ||
    run.ruleID !== rule.ruleID ||
    rule.currentRunID !== run.runID ||
    run.projectKey !== rule.projectKey ||
    run.ruleRevision !== rule.revision ||
    run.contentRevision !== rule.contentRevision ||
    run.contentHash !== rule.contentHash ||
    run.content.contentHash !== run.contentHash ||
    run.configHash !== rule.configHash ||
    rule.configHash !== EventValidation.hash(rule.configuration) ||
    run.recipeHash !== EventValidation.hash(rule.configuration.recipe) ||
    read.length > 128 ||
    new Set(read).size !== read.length
  )
    throw unavailable()
  const manifest = new Map(run.content.files.map((file) => [file.relative, file]))
  const approvedRead = read.map((relative) => {
    const file = manifest.get(relative)
    if (!file || file.missing || !file.identity || !file.sha256) throw unavailable()
    return file
  })
  const stream = (value: typeof result.stdout) => ({
    sha256: value.sha256,
    bytes: value.bytes,
    capturedBytes: value.capturedBytes,
    truncated: value.truncated,
    complete: true as const,
    excerptTruncated: value.excerptTruncated,
  })
  const evidence = {
    version: 1 as const,
    instanceID: run.instanceID,
    ruleID: run.ruleID,
    runID: run.runID,
    testRunID: run.testRunID,
    previewBuildID: run.previewBuildID,
    ruleRevision: run.ruleRevision,
    contentRevision: run.contentRevision,
    contentHash: run.contentHash,
    recipeHash: run.recipeHash,
    configHash: run.configHash,
    snapshotHash: run.snapshotHash,
    processIncarnation: run.processIncarnation,
    scopeHash: EventValidation.hash(rule.configuration.scope),
    content: structuredClone(run.content),
    resultHash: EventValidation.hash(result),
    result: {
      outcome: "failed" as const,
      exitCode: result.exitCode,
      signal: result.signal,
      stopConfirmed: true as const,
      endedAt: result.endedAt,
      stdout: stream(result.stdout),
      stderr: stream(result.stderr),
    },
  }
  if (
    Option.isNone(
      Schema.decodeUnknownOption(EventInvestigationSchema.Evidence, { onExcessProperty: "error" })(evidence),
    )
  )
    throw unavailable()
  // Encode both excerpts and all framing together before applying the one Work text ceiling.
  const auditedText = CanonicalJson.stringify({
    version: "event-investigation-audited.v1",
    failure: evidence,
    logs: { stdout: result.stdout.excerpt, stderr: result.stderr.excerpt },
    approvedRead,
  })
  const auditedTextBytes = Buffer.byteLength(auditedText, "utf8")
  if (auditedTextBytes > EventInvestigationSchema.MAX_AUDITED_TEXT_BYTES) throw unavailable()
  return { evidence, auditedText, auditedTextHash: Hash.sha256(auditedText), auditedTextBytes }
}

/** Compare the actual helper owner's description before releasing its page text. A
 * self-reported page digest does not prove the full file matches the failed version. */
export function requireManifestRead(
  expected: typeof EventValidationSchema.File.Type,
  actual: WorkFileCapability.Description,
) {
  if (
    expected.missing ||
    !expected.identity ||
    !expected.sha256 ||
    actual.snapshot !== "stream_observation" ||
    actual.relative !== expected.relative ||
    actual.fileBytes !== expected.bytes ||
    actual.scannedBytes !== expected.bytes ||
    actual.observedHash !== expected.sha256 ||
    EventValidation.hash(actual.fileIdentity) !== EventValidation.hash(expected.identity)
  )
    throw new WorkFileCapability.Error({
      code: "WORK_FILE_CHANGED",
      message: "Native read differs from the original failed manifest",
    })
}

export * as EventInvestigationEvidence from "./event-investigation-evidence"
