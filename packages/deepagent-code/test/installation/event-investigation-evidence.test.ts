import { expect, test } from "bun:test"
import { Schema } from "effect"
import { EventValidation } from "@deepagent-code/core/deepagent/event-validation"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { EventInvestigationSchema } from "@deepagent-code/core/deepagent/event-investigation.schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { WorkFileCapability } from "@deepagent-code/core/session/work-file-capability"
import { EventInvestigationEvidence } from "../../src/installation/event-investigation-evidence"
import { EventInvestigationEvidenceFixture } from "./fixture/event-investigation-evidence"

test("failure evidence retains original stable identities, exact framing and complete stream digests", () => {
  const input = EventInvestigationEvidenceFixture.failed()
  const built = EventInvestigationEvidence.build(input.rule, input.run, ["source.test.ts"])
  expect(
    Schema.decodeUnknownSync(EventInvestigationSchema.Evidence, { onExcessProperty: "error" })(built.evidence),
  ).toEqual(built.evidence)
  expect(built.auditedTextBytes).toBe(Buffer.byteLength(built.auditedText, "utf8"))
  expect(built.auditedTextHash).toBe(Hash.sha256(built.auditedText))
  expect(built.auditedText).toBe(
    CanonicalJson.stringify({
      version: "event-investigation-audited.v1",
      failure: built.evidence,
      logs: { stdout: "失败\n", stderr: "失败\n" },
      approvedRead: input.run.content.files,
    }),
  )
  expect(built.evidence.resultHash).toBe(EventValidation.hash(input.run.result))
  expect(
    EventInvestigationEvidence.build(input.rule, { ...input.run, revision: 5, releasedAt: 6, retainedBytes: 1 }, [
      "source.test.ts",
    ]),
  ).toEqual(built)
})

test("both multibyte excerpts and JSON escaping share one exact 64KiB text ceiling", () => {
  const input = EventInvestigationEvidenceFixture.failed()
  const result = input.run.result!
  const oversized = { ...result.stdout, excerpt: "中\n".repeat(10000), bytes: 40000, capturedBytes: 40000 }
  expect(() =>
    EventInvestigationEvidence.build(
      input.rule,
      {
        ...input.run,
        result: {
          ...result,
          stdout: oversized,
          stderr: oversized,
        },
      },
      ["source.test.ts"],
    ),
  ).toThrow()
  const escaped = { ...result.stdout, excerpt: '"\\\n'.repeat(12000), bytes: 36000, capturedBytes: 36000 }
  expect(() =>
    EventInvestigationEvidence.build(
      input.rule,
      {
        ...input.run,
        result: {
          ...result,
          stdout: escaped,
        },
      },
      ["source.test.ts"],
    ),
  ).toThrow()
})

test("unconfirmed, incomplete, stale and nonfailure records cannot produce investigation text", () => {
  const input = EventInvestigationEvidenceFixture.failed()
  const result = input.run.result!
  const refused: EventValidationSchema.RunRecord[] = [
    { ...input.run, resultCurrent: false },
    { ...input.run, state: "unknown" },
    { ...input.run, outcome: "passed", result: { ...result, outcome: "passed" } },
    { ...input.run, cancelRequested: true },
    { ...input.run, contentRevision: 2 },
    { ...input.run, result: { ...result, stopConfirmed: false } },
    { ...input.run, result: { ...result, stderr: { ...result.stderr, complete: false } } },
    { ...input.run, result: { ...result, stdout: { ...result.stdout, capturedBytes: 8 } } },
    { ...input.run, snapshotHash: null },
    { ...input.run, testRunID: null },
  ]
  refused.forEach((run) => expect(() => EventInvestigationEvidence.build(input.rule, run, [])).toThrow())
  expect(() => EventInvestigationEvidence.build({ ...input.rule, state: "paused" }, input.run, [])).toThrow()
  expect(() =>
    EventInvestigationEvidence.build({ ...input.rule, currentRunID: "another-run" }, input.run, []),
  ).toThrow()
  expect(() => EventInvestigationEvidence.build(input.rule, input.run, ["outside.ts"])).toThrow()
  expect(() => EventInvestigationEvidence.build(input.rule, input.run, ["source.test.ts", "source.test.ts"])).toThrow()
})

test("a page digest cannot replace exact native full-file bytes, scan, hash and identity", () => {
  const file = EventInvestigationEvidenceFixture.failed().run.content.files[0]!
  const actual: WorkFileCapability.Description = {
    workID: "work",
    bindingHash: "a".repeat(64),
    controlRevision: 1,
    rootIdentity: file.identity!,
    fileIdentity: file.identity!,
    helperHash: "b".repeat(64),
    relative: file.relative,
    offset: 0,
    bytes: 2,
    fileBytes: file.bytes,
    scannedBytes: file.bytes,
    observedHash: file.sha256!,
    pageHash: Hash.sha256("te"),
    observedAt: 4,
    snapshot: "stream_observation",
  }
  expect(() => EventInvestigationEvidence.requireManifestRead(file, actual)).not.toThrow()
  const changed: WorkFileCapability.Description[] = [
    { ...actual, fileBytes: 3 },
    { ...actual, scannedBytes: 2 },
    { ...actual, observedHash: actual.pageHash },
    { ...actual, fileIdentity: { kind: "posix", device: "1", inode: "3" } },
    { ...actual, relative: "outside.ts" },
  ]
  changed.forEach((value) => expect(() => EventInvestigationEvidence.requireManifestRead(file, value)).toThrow())
})
