import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { CanonicalJson } from "../src/util/canonical-json"
import { KernelDelivery } from "../src/im/kernel-delivery"
import { KernelDeliverySchema } from "../src/im/kernel-delivery.schema"
import { KernelMediaRetirementModel } from "../src/im/kernel-media-retirement.model"

const hash = KernelDelivery.hash
const caption = "媒体正文隐私canary-仅原正文存在"
const filename = "附件文件名canary.txt"
const reason = "原未知错误canary不能复制"
const custodyID = "c94cc1c5-038f-4d9f-87c3-8f43d2b761c0"

/** This is a pure legacy-format specimen. It makes no current DB/Host/SDK
 * authority claim and performs no model, network, attachment or SQL work. */
function specimen(state: KernelDeliverySchema.State = "acknowledged") {
  const source = { realm: "realm", appkey: "appkey", orgID: 1, senderID: "alice", credentialFingerprint: hash("original credential") }
  const attachments = [0, 1].map((index) => ({
    attachmentID: hash(["attachment", index]), contentRef: hash(["attachment", index]),
    filename: `${index}-${filename}`, mime: "text/plain", sizeBytes: index + 3, sha256: hash(["content", index]),
    createdAt: 10_000 + index * 500, expiresAt: 86_410_000 + index * 500,
  }))
  const binding: KernelDeliverySchema.MediaBinding = {
    version: 2, messageID: "imsg-original", groupID: "img-original", workspaceID: "workspace-original", source,
    conversationType: 1, conversationID: "bob", messageHash: hash(["actual-message-original-identity"]),
    wireID: `dac_${hash(["im-kernel-wire-media-v2", source, "imsg-original"])}`,
    textHash: hash(caption), createdAt: 1_000, expiresAt: 86_410_000, messageType: "dac:media.v1",
    wireContent: JSON.stringify({ v: 1, content: caption, attachments }),
    wireHash: createHash("sha256").update(JSON.stringify({ v: 1, content: caption, attachments }), "utf8").digest("hex"),
    attachments, localAttachments: attachments.map((item, index) => ({
      localAttachmentID: `ima-local-${index}`, attachmentID: item.attachmentID, identityHash: hash(["actual local identity", index]),
    })),
  }
  const transport: KernelMediaRetirementModel.Transport = {
    state, dispatchOwner: state === "prepared" ? null : "original-owner", kernelMessageID: state === "acknowledged" ? "kernel-original" : null,
    reason: state === "unknown" ? reason : null, createdAt: 1_000,
    dispatchedAt: state === "prepared" ? null : 1_001, acknowledgedAt: state === "acknowledged" ? 1_002 : null, updatedAt: 1_003,
  }
  const request = { groupID: binding.groupID, senderID: "alice", senderType: "user", type: "file", content: caption,
    mentions: ["agent-a", "agent-b"], metadata: binding.localAttachments.map((item) => ({ type: "attachment_ref", batch: true, attachmentID: item.localAttachmentID })), replyToID: "imsg-parent" }
  const capture = { custodyID, binding, bindingHash: hash(binding), bindingBytes: new TextEncoder().encode(JSON.stringify(binding)).byteLength,
    messageHash: binding.messageHash, messageHeaderHash: hash("original header identity"), requestHash: KernelMediaRetirementModel.requestHash(request),
    clientRequestIDHash: KernelMediaRetirementModel.clientRequestIDHash("original-request"),
    captionBytes: new TextEncoder().encode(caption).byteLength, transport }
  return { binding, transport, request, capture, record: KernelMediaRetirementModel.capture(capture) }
}

function stored(record: KernelMediaRetirementModel.Record, transport: KernelMediaRetirementModel.Transport) {
  return { ...KernelMediaRetirementModel.encode(record), identityHash: record.identityHash, custodyID: record.identity.custodyID,
    messageID: record.identity.messageID, bindingHash: record.identity.bindingHash, wireID: record.identity.wireID,
    bodyState: record.bodyState, bindingPresent: record.bodyState === "live", retiredAt: record.retiredAt, transport }
}

describe("media body retirement pure codec boundaries", () => {
  test("body-free capture keeps every original digest, original order and original clocks", () => {
    const value = specimen()
    const encoded = KernelMediaRetirementModel.encode(value.record)
    expect(encoded.record).not.toContain(caption)
    expect(encoded.record).not.toContain(filename)
    expect(encoded.record).not.toContain("text/plain")
    expect(encoded.record).not.toContain("wireContent")
    expect(encoded.record).not.toContain("contentRef")
    expect(encoded.record).not.toContain("filename")
    expect(encoded.record).not.toContain("mime")
    expect(value.record.identity).toMatchObject({ bindingHash: value.capture.bindingHash, messageHash: value.binding.messageHash,
      textHash: value.binding.textHash, wireHash: value.binding.wireHash, createdAt: value.binding.createdAt, expiresAt: value.binding.expiresAt,
      remoteManifestHash: hash(value.binding.attachments), localManifestHash: hash(value.binding.localAttachments), source: value.binding.source })
    expect(value.record.identity.manifest.map((item) => item.attachmentID)).toEqual(value.binding.attachments.map((item) => item.attachmentID))
    expect(value.record.identity.manifest.map((item) => item.descriptorHash)).toEqual(value.binding.attachments.map(hash))
    expect(KernelMediaRetirementModel.decode(stored(value.record, value.transport))).toEqual(value.record)
    expect(value.record.identity.originalCaptionBytes).toBe(new TextEncoder().encode(caption).byteLength)
    expect(value.record.identity.originalWireBytes).toBe(new TextEncoder().encode(value.binding.wireContent).byteLength)
  })

  test("caption digest uses canonical string SHA and wire digest uses raw UTF8 SHA", () => {
    const value = specimen()
    expect(value.binding.textHash).toBe(hash(caption))
    expect(value.binding.textHash).not.toBe(createHash("sha256").update(caption, "utf8").digest("hex"))
    expect(value.binding.wireHash).toBe(createHash("sha256").update(value.binding.wireContent, "utf8").digest("hex"))
    expect(() => KernelMediaRetirementModel.capture({ ...value.capture, binding: { ...value.binding, wireHash: hash(value.binding.wireContent) } })).toThrow()
  })

  test("strict storage rejects extra, missing, duplicate and noncanonical JSON without changing the original", () => {
    const value = specimen()
    const input = stored(value.record, value.transport)
    const original = structuredClone(input)
    expect(() => KernelMediaRetirementModel.decode({ ...input, record: input.record.replace('"version":1', '"version":1,"caption":"must reject"') })).toThrow()
    expect(() => KernelMediaRetirementModel.decode({ ...input, record: input.record.replace('"version":1', '"version":1,"version":1') })).toThrow()
    expect(() => KernelMediaRetirementModel.decode({ ...input, record: JSON.stringify(value.record, null, 2) })).toThrow()
    expect(() => KernelMediaRetirementModel.decode({ ...input, record: CanonicalJson.stringify(Object.fromEntries(Object.entries(value.record).filter(([key]) => key !== "version"))) })).toThrow()
    expect(() => KernelMediaRetirementModel.decode({ ...input, record: " ".repeat(KernelMediaRetirementModel.SUMMARY_BYTES + 1) })).toThrow()
    expect(input).toEqual(original)
  })

  test("the actual raw receipt, ledger state and DB custody must agree", () => {
    const value = specimen()
    const input = stored(value.record, value.transport)
    const changes = [
      { custodyID: "ee7bcd87-1f35-40a1-a85e-bf9af42b851c" }, { messageID: "imsg-other" },
      { wireID: "dac-other" }, { bindingHash: hash("other original binding") }, { identityHash: hash("other original identity") },
      { recordHash: hash("other original record") }, { bindingPresent: false }, { retiredAt: value.binding.expiresAt },
      { bodyState: "retired" as const }, { transport: { ...value.transport, dispatchOwner: "later-owner" } },
      { transport: { ...value.transport, reason } }, { transport: { ...value.transport, updatedAt: 1_004 } },
      { transport: { ...value.transport, kernelMessageID: "later-kernel" } },
    ]
    changes.forEach((change) => expect(() => KernelMediaRetirementModel.decode({ ...input, ...change })).toThrow())
    expect(KernelMediaRetirementModel.decode(input)).toEqual(value.record)
  })

  test("ordered manifest, dates, source and schema version cannot drift", () => {
    const value = specimen()
    const input = stored(value.record, value.transport)
    const changes = [
      { ...value.record, version: 2 },
      { ...value.record, identity: { ...value.record.identity, manifest: [...value.record.identity.manifest].reverse() } },
      { ...value.record, identity: { ...value.record.identity, expiresAt: value.binding.expiresAt + 1 } },
      { ...value.record, identity: { ...value.record.identity, source: { ...value.binding.source, credentialFingerprint: hash("new credential") } } },
      { ...value.record, identity: { ...value.record.identity, manifest: value.record.identity.manifest.map((item) => ({ ...item, expiresAt: item.expiresAt + 1 })) } },
      { ...value.record, identity: { ...value.record.identity, originalBindingVersion: 1 } },
    ]
    changes.forEach((record) => expect(() => KernelMediaRetirementModel.decode({ ...input, record: CanonicalJson.stringify(record) })).toThrow())
  })

  test("only original acknowledged plus original minimum expiry retires; exact repeat keeps bytes and time", () => {
    const value = specimen()
    const original = structuredClone(value.record)
    expect(KernelMediaRetirementModel.eligibility(value.record, value.transport, value.binding.expiresAt - 1)).toBe("not_expired")
    expect(KernelMediaRetirementModel.retire(value.record, value.transport, value.binding.expiresAt - 1)).toBeUndefined()
    const retired = KernelMediaRetirementModel.retire(value.record, value.transport, value.binding.expiresAt)!
    expect(retired.identity).toEqual(original.identity)
    expect(retired.identityHash).toBe(original.identityHash)
    expect(retired.transportHash).toBe(original.transportHash)
    expect(retired.bodyState).toBe("retired")
    expect(retired.retiredAt).toBe(value.binding.expiresAt)
    const encoded = KernelMediaRetirementModel.encode(retired)
    expect(KernelMediaRetirementModel.retire(retired, value.transport, value.binding.expiresAt + 999)).toBe(retired)
    expect(KernelMediaRetirementModel.encode(retired)).toEqual(encoded)
    expect(KernelMediaRetirementModel.decode(stored(retired, value.transport))).toEqual(retired)
    expect(value.record).toEqual(original)
    expect(() => KernelMediaRetirementModel.requireLive(retired)).toThrow()
    expect(() => KernelMediaRetirementModel.refreshTransport(retired, value.transport)).toThrow()
  })

  test("prepared, dispatched and unknown preserve unresolved facts and defer at expiry", () => {
    for (const state of ["prepared", "dispatched", "unknown"] as const) {
      const value = specimen(state)
      const encoded = KernelMediaRetirementModel.encode(value.record)
      expect(KernelMediaRetirementModel.eligibility(value.record, value.transport, value.binding.expiresAt + 100)).toBe("deferred")
      expect(KernelMediaRetirementModel.retire(value.record, value.transport, value.binding.expiresAt + 100)).toBeUndefined()
      expect(KernelMediaRetirementModel.encode(value.record)).toEqual(encoded)
      expect(encoded.record).not.toContain(reason)
      expect(() => KernelMediaRetirementModel.decode({ ...stored(value.record, value.transport), bodyState: "retired", bindingPresent: false })).toThrow()
    }
  })

  test("same-TX transport refresh preserves immutable identity and late ACK then allows expiry", () => {
    const prepared = specimen("prepared")
    const dispatched = specimen("dispatched")
    const ack = specimen("acknowledged")
    const refreshed = KernelMediaRetirementModel.refreshTransport(prepared.record, dispatched.transport)
    expect(refreshed.identity).toEqual(prepared.record.identity)
    expect(refreshed.identityHash).toBe(prepared.record.identityHash)
    expect(refreshed.transportHash).toBe(dispatched.record.transportHash)
    expect(() => KernelMediaRetirementModel.decode(stored(refreshed, prepared.transport))).toThrow()
    const settled = KernelMediaRetirementModel.refreshTransport(refreshed, ack.transport)
    expect(settled.identity).toEqual(prepared.record.identity)
    expect(KernelMediaRetirementModel.retire(settled, ack.transport, ack.binding.expiresAt)?.bodyState).toBe("retired")
    expect(() => KernelMediaRetirementModel.refreshTransport(settled, { ...ack.transport, createdAt: 1_001 })).toThrow()
    expect(() => KernelMediaRetirementModel.transportHash({ ...ack.transport, acknowledgedAt: 1_000 })).toThrow()
  })

  test("historical exact no-op comparison keeps original request identity without exposing Binding", () => {
    const value = specimen()
    const retired = KernelMediaRetirementModel.retire(value.record, value.transport, value.binding.expiresAt)!
    const input = { custodyID, messageID: value.binding.messageID, groupID: value.binding.groupID, workspaceID: value.binding.workspaceID,
      sourceHash: hash(value.binding.source), requestHash: value.capture.requestHash, clientRequestIDHash: value.capture.clientRequestIDHash }
    expect(KernelMediaRetirementModel.exactHistorical(value.record, input)).toBe(false)
    expect(KernelMediaRetirementModel.exactHistorical(retired, input)).toBe(true)
    const changes = [
      { custodyID: "new-custody" }, { messageID: "new-message" }, { groupID: "new-group" }, { workspaceID: "new-workspace" },
      { sourceHash: hash({ ...value.binding.source, credentialFingerprint: hash("new credential") }) },
      { clientRequestIDHash: KernelMediaRetirementModel.clientRequestIDHash("new-request") },
      { requestHash: KernelMediaRetirementModel.requestHash({ ...value.request, mentions: [...value.request.mentions].reverse() }) },
      { requestHash: KernelMediaRetirementModel.requestHash({ ...value.request, metadata: [...value.request.metadata].reverse() }) },
      { requestHash: KernelMediaRetirementModel.requestHash({ ...value.request, replyToID: "other parent" }) },
      { requestHash: KernelMediaRetirementModel.requestHash({ ...value.request, content: "new caption" }) },
    ]
    changes.forEach((change) => expect(KernelMediaRetirementModel.exactHistorical(retired, { ...input, ...change })).toBe(false))
    expect(retired).not.toHaveProperty("binding")
    expect(retired).not.toHaveProperty("text")
    expect(retired).not.toHaveProperty("wireContent")
  })

  test("UTF8 all-copy accounting counts actual JSON strings and nullable integers, then releases exactly once", () => {
    expect(KernelMediaRetirementModel.accounting([{ text: "界a", integer: 1, absent: null }, { metadata: '{"名":"字"}', time: 2 }])).toBe(4 + 8 + 13 + 8)
    expect(() => KernelMediaRetirementModel.accounting([{ integer: 1.5 }])).toThrow()
    const value = specimen()
    const retired = KernelMediaRetirementModel.retire(value.record, value.transport, value.binding.expiresAt)!
    const originalBytes = KernelMediaRetirementModel.accounting([
      { binding: JSON.stringify(value.binding), binding_hash: value.capture.bindingHash },
      { content: caption, created_at: 1_000, deleted_at: null },
      { record: KernelMediaRetirementModel.encode(value.record).record, accounted_records: 3 },
    ])
    const retiredBytes = KernelMediaRetirementModel.accounting([
      { binding: null, binding_hash: value.capture.bindingHash },
      { content: "", created_at: 1_000, deleted_at: value.binding.expiresAt },
      { record: KernelMediaRetirementModel.encode(retired).record, accounted_records: 3 },
    ])
    const meter = KernelMediaRetirementModel.meter({ usedRecords: 3, usedBytes: originalBytes, deltaRecords: 0, deltaBytes: retiredBytes - originalBytes })
    expect(meter).toEqual({ usedRecords: 3, usedBytes: retiredBytes })
    expect(meter.usedBytes).toBeLessThan(originalBytes)
    expect(KernelMediaRetirementModel.meter({ ...meter, deltaRecords: 0, deltaBytes: 0 })).toEqual(meter)
  })

  test("independent global meter has exact record/byte hard boundaries and permits legitimate large deltas", () => {
    expect(KernelMediaRetirementModel.OWNED_RECORDS).toBe(3)
    expect(KernelMediaRetirementModel.meter({ usedRecords: 99_997, usedBytes: KernelMediaRetirementModel.BYTE_LIMIT - 1, deltaRecords: 3, deltaBytes: 1 }))
      .toEqual({ usedRecords: 100_000, usedBytes: KernelMediaRetirementModel.BYTE_LIMIT })
    expect(() => KernelMediaRetirementModel.meter({ usedRecords: 99_998, usedBytes: 0, deltaRecords: 3, deltaBytes: 0 })).toThrow()
    expect(() => KernelMediaRetirementModel.meter({ usedRecords: 3, usedBytes: KernelMediaRetirementModel.BYTE_LIMIT, deltaRecords: 0, deltaBytes: 1 })).toThrow()
    expect(() => KernelMediaRetirementModel.meter({ usedRecords: 3, usedBytes: 1, deltaRecords: -3, deltaBytes: -2 })).toThrow()
    expect(() => KernelMediaRetirementModel.meter({ usedRecords: 0, usedBytes: 0, deltaRecords: 1, deltaBytes: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
    expect(KernelMediaRetirementModel.meter({ usedRecords: 3, usedBytes: 9 << 20, deltaRecords: 0, deltaBytes: -(9 << 20) })).toEqual({ usedRecords: 3, usedBytes: 0 })
  })
})
