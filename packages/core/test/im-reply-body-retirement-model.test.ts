import { expect, test } from "bun:test"
import { ReplyBodyRetirementModel } from "../src/im/reply-body-retirement.model"
import { ReplyDeliveryID } from "../src/im/reply-delivery-id"

const hash = ReplyBodyRetirementModel.hash
const original = {
  outboxID: "imo-model",
  deliveryMessageID: ReplyDeliveryID.fromOutbox("imo-model"),
  sessionID: "original-session",
  groupID: "original-group",
  agentID: "original-agent",
  triggerMessageID: null,
  replyMessageID: "original-final",
  createdAt: 10,
  replyHash: ReplyBodyRetirementModel.bodyHash("中文🙂"),
  replyBytes: 10,
  kind: "mention" as const,
  basisHash: hash("original actual closure"),
}
const record = () =>
  ReplyBodyRetirementModel.validate({
    version: 1,
    custodyID: "c94cc1c5-038f-4d9f-87c3-8f43d2b761c0",
    origin: original,
    originHash: ReplyBodyRetirementModel.originHash(original),
    message: null,
    transport: null,
    custody: "unbound",
    bodyState: "live",
    retiredAt: null,
  })

test("strict body-free codec rejects duplicate/noncanonical/unknown fields or changed immutable origin", () => {
  const encoded = ReplyBodyRetirementModel.encode(record())
  expect(encoded.record.includes("中文")).toBe(false)
  expect(ReplyBodyRetirementModel.decode(encoded.record, encoded.recordHash)).toEqual(record())
  expect(() => ReplyBodyRetirementModel.decode(encoded.record + " ", encoded.recordHash)).toThrow()
  expect(() =>
    ReplyBodyRetirementModel.decode(
      encoded.record.replace('"version":1', '"version":1,"version":1'),
      encoded.recordHash,
    ),
  ).toThrow()
  expect(() => ReplyBodyRetirementModel.validate({ ...record(), unexpected: "body" })).toThrow()
  expect(() =>
    ReplyBodyRetirementModel.validate({ ...record(), origin: { ...original, groupID: "replacement" } }),
  ).toThrow()
})

test("immutable Message header excludes ACK/retirement fields while complete raw mutable facts seal them", () => {
  const message = {
    id: original.deliveryMessageID,
    group_id: original.groupID,
    sender_id: original.agentID,
    sender_type: "agent",
    type: "text",
    content: "中文🙂",
    mentions: [],
    metadata: { type: "agent_run", sessionID: original.sessionID, status: "success" },
    reply_to_id: null,
    client_request_id: null,
    created_at: 10,
    kernel_msg_id: null as string | null,
    updated_at: 10,
    deleted_at: null as number | null,
    delivery_status: "pending",
  }
  const retired = { ...message, content: "", kernel_msg_id: "ack", updated_at: 20, deleted_at: 30 }
  expect(ReplyBodyRetirementModel.messageHeaderHash(retired)).toBe(ReplyBodyRetirementModel.messageHeaderHash(message))
  expect(ReplyBodyRetirementModel.messageHash({ ...message, content: "" })).not.toBe(
    ReplyBodyRetirementModel.messageHash(message),
  )
  const raw = { ...message, mentions: "[]", metadata: JSON.stringify(message.metadata) }
  for (const changed of [
    { kernel_msg_id: "ack" },
    { updated_at: 11 },
    { deleted_at: 12 },
    { delivery_status: "failed" },
    { metadata: '{ "type": "agent_run" }' },
    { content: "" },
  ])
    expect(ReplyBodyRetirementModel.factsHash({ id: original.outboxID }, { ...raw, ...changed }, null)).not.toBe(
      ReplyBodyRetirementModel.factsHash({ id: original.outboxID }, raw, null),
    )
})

test("SQL accounting uses full actual UTF8 strings, raw JSON whitespace, nullable integers and no fake copies", () => {
  expect(ReplyBodyRetirementModel.accounting([{ text: "中文🙂", json: '[ "中" ]', n: 1, absent: null }])).toBe(
    10 + 9 + 8,
  )
  expect(() => ReplyBodyRetirementModel.accounting([{ n: 0.5 }])).toThrow()
  expect(() =>
    ReplyBodyRetirementModel.validate({
      ...record(),
      origin: { ...original, sessionID: "x".repeat(65536) },
      originHash: hash("wrong"),
    }),
  ).toThrow()
})

test("no receipt, unresolved scheduling and sealed legacy origin cannot manufacture expiry retirement", () => {
  expect(ReplyBodyRetirementModel.retire(record(), "delivered", "acknowledged", 300000000)).toBeUndefined()
  const legacy = { ...original, kind: "legacy_unbound" as const }
  const unknown = ReplyBodyRetirementModel.validate({
    ...record(),
    origin: legacy,
    originHash: ReplyBodyRetirementModel.originHash(legacy),
    custody: "legacy_unbound",
  })
  expect(ReplyBodyRetirementModel.retire(unknown, "delivered", "acknowledged", 300000000)).toBeUndefined()
  expect(() =>
    ReplyBodyRetirementModel.bind(
      unknown,
      {
        messageID: original.deliveryMessageID,
        headerHash: hash("h"),
        messageHash: hash("m"),
        requestHash: hash("r"),
        createdAt: 10,
      },
      null,
    ),
  ).toThrow()
})

test("original kernel text wire limit is enforced separately from the larger pending custody budget", () => {
  const source = {realm:"realm",appkey:"appkey",orgID:1,senderID:"sender",credentialFingerprint:hash("credential")}
  const binding = {version:1 as const,messageID:original.deliveryMessageID,groupID:original.groupID,workspaceID:"workspace",source,
    conversationType:1 as const,conversationID:"peer",messageHash:hash("original-message"),textHash:hash("original-text"),
    wireID:`dac_${hash(["im-kernel-wire-v1",source,original.deliveryMessageID])}`,createdAt:10,expiresAt:259200010}
  const local = {messageID:original.deliveryMessageID,headerHash:hash("header"),messageHash:binding.messageHash,requestHash:hash("request"),createdAt:10}
  expect(() => ReplyBodyRetirementModel.bind(record(),local,{binding,bindingHash:hash(binding),wireHash:hash("wire"),wireBytes:65537})).toThrow()
  expect(ReplyBodyRetirementModel.accounting([{pending_body:"x".repeat(65537)}])).toBe(65537)
})
