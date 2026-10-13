import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { EventInvestigationAuthoritySchema } from "../src/deepagent/event-investigation-authority.schema"
import { EventInvestigationPolicy } from "../src/deepagent/event-investigation-policy"
import { EventInvestigationSchema } from "../src/deepagent/event-investigation.schema"
import { WorkAuthorityPolicy } from "../src/session/work-authority-policy"
import { CanonicalJson } from "../src/util/canonical-json"
import { EventInvestigationFixture } from "./fixture/event-investigation"

test("immutable receipt lowers one independent server_rule binding and verifies every hash", () => {
  const receipt = EventInvestigationFixture.receipt()
  expect(EventInvestigationPolicy.validReceipt(receipt)).toBe(true)
  const binding = EventInvestigationPolicy.bindingFor(receipt)
  expect(binding.source).toEqual({ kind: "server_rule", authorityID: receipt.receiptID, authorityRevision: 1,
    sourceID: receipt.runID, requestID: receipt.failureKey, requestHash: receipt.authorityHash })
  expect(WorkAuthorityPolicy.validateBinding(binding).ok).toBe(true)
  expect(EventInvestigationPolicy.expectedFile(receipt, "input.ts")).toEqual(receipt.evidence.content.files[0])
  expect(EventInvestigationPolicy.expectedFile(receipt, "../input.ts")).toBeUndefined()
  for (const patch of [
    { authorized: true }, { currentWorkState: "active" }, { receiptID: "changed" }, { grantEpoch: 2 },
    { auditedTextHash: "a".repeat(64) }, { auditedTextBytes: receipt.auditedTextBytes + 1 },
    { bindingHash: "b".repeat(64) }, { authorityHash: "c".repeat(64) }, { failureKey: "d".repeat(64) },
    { grantHash: "e".repeat(64) }, { evidenceHash: "f".repeat(64) },
    { auditedText: `${receipt.auditedText} ` }, { deadline: receipt.createdAt },
  ]) expect(EventInvestigationPolicy.validReceipt({ ...receipt, ...patch })).toBe(false)
})

test("grant epoch and request cannot change one failure identity or revive it by ABA", () => {
  const receipt = EventInvestigationFixture.receipt()
  const key = EventInvestigationPolicy.failureKey(receipt.evidence)
  const anotherRun = { ...receipt.evidence, runID: "another-run", ruleRevision: 2 }
  expect(EventInvestigationPolicy.failureKey(anotherRun)).toBe(key)
  expect(EventInvestigationPolicy.failureKey({ ...receipt.evidence, contentRevision: 2 })).not.toBe(key)
  expect(EventInvestigationPolicy.authorityHash({ ...receipt, grantEpoch: 3 })).not.toBe(receipt.authorityHash)
  const decode = Schema.decodeUnknownOption(EventInvestigationAuthoritySchema.Authority, { onExcessProperty: "error" })
  expect(Option.isSome(decode({ version: 1, epoch: 1, state: "enabled", grant: receipt.grant, updatedAt: 1_000 }))).toBe(true)
  expect(Option.isSome(decode({ version: 1, epoch: 2, state: "disabled", grant: null, updatedAt: 2_000 }))).toBe(true)
  expect(Option.isNone(decode({ version: 1, epoch: 2, state: "enabled", grant: receipt.grant, updatedAt: 2_000 }))).toBe(true)
  expect(Option.isNone(decode({ version: 1, epoch: 0, state: "disabled", grant: null, updatedAt: 2_000 }))).toBe(true)
})

test("UTF8 and encoded grant/evidence/receipt ceilings reject excess data before persistence", () => {
  const receipt = EventInvestigationFixture.receipt()
  expect(Buffer.byteLength(CanonicalJson.stringify(receipt))).toBeLessThan(EventInvestigationSchema.MAX_RECEIPT_BYTES)
  const decode = Schema.decodeUnknownOption(EventInvestigationSchema.Receipt, { onExcessProperty: "error" })
  const text = "中".repeat(21_846)
  expect(Option.isNone(decode({ ...receipt, auditedText: text, auditedTextBytes: Buffer.byteLength(text) }))).toBe(true)
  const grant = Schema.decodeUnknownOption(EventInvestigationAuthoritySchema.Grant, { onExcessProperty: "error" })
  expect(Option.isNone(grant({ ...receipt.grant, target: { ...receipt.grant.target,
    toolPolicy: { ...receipt.grant.target.toolPolicy, fileScope: { ...receipt.grant.target.toolPolicy.fileScope,
      read: Array.from({ length: 128 }, (_, index) => ({ kind: "file", path: `${index}${"a".repeat(256)}` })) } } } }))).toBe(true)
  const evidence = Schema.decodeUnknownOption(EventInvestigationSchema.Evidence, { onExcessProperty: "error" })
  for (const patch of [
    { snapshotHash: null }, { processIncarnation: null }, { testRunID: null, previewBuildID: null },
    { result: { ...receipt.evidence.result, stopConfirmed: false } },
    { result: { ...receipt.evidence.result, stdout: { ...receipt.evidence.result.stdout, complete: false } } },
  ]) expect(Option.isNone(evidence({ ...receipt.evidence, ...patch }))).toBe(true)
})
