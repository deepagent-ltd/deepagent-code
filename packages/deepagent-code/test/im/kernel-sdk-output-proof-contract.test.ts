import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"

const source = new URL("../../../im-kernel-sdk/upstream/src/", import.meta.url)
const codec = await import(new URL("delivery/codec.js", source).href)
const contract = await import(new URL("delivery/contract.js", source).href)
const proto = (await import(new URL("socket/proto.js", source).href)).default
await import("@/im/kernel/shims")
// Execute the distributed bytes unchanged; only expose pure private functions
// in this test module so source-only checks cannot conceal a bundling defect.
const installed = await Bun.file(new URL("../../../im-kernel-sdk/lib/index.js", import.meta.url)).text()
const temporary = await fs.mkdtemp(path.join(tmpdir(), "dac-output-proof-distributed-sdk-"))
const module = path.join(temporary, "generated-sdk.mjs")
await Bun.write(module, installed + "\nexport { encodeQuery, decodeQuery, readerRequest, validateResult };")
afterAll(() => fs.rm(temporary, { recursive: true, force: true }))
const generated = await import(module)

test("ordered output proof preserves canonical protobuf, exact rows and independent bounds", () => {
  const scopeKey = "a".repeat(64)
  const projectionKey = "b".repeat(64)
  const revision = "9223372036854775807"
  const rows = [
    { kind: "visible", projectionKey, projectionRevision: revision },
    { kind: "pending", conversationType: 2, conversationID: "g" + "c".repeat(24) },
  ]
  const request = { version: 2, scopeKey, rows }
  const topic = "qry_delivery_output_proof"
  const encoded = codec.encodeQuery(topic, request)
  const wire = proto.lookup("codec.DeliveryReadQuery").decode(encoded)
  expect(encoded.length).toBeLessThanOrEqual(4096)
  expect(wire.outputRows[0].visible.projectionRevision).toBe(revision)
  expect(wire.outputRows[1].pending.targetId).toBe(rows[1]!.conversationID)
  expect(wire.outputRows[0].selector).toBe("visible")
  expect(wire.outputRows[1].selector).toBe("pending")
  const cut = { version: 2, scopeKey, projectionKey, projectionRevision: revision, throughOrdinal: "5",
    targetAdmittedOrdinal: "5", readOrdinal: "0", liveUnread: "1", storedUnread: "1", serverNow: 1000 }
  const result = { version: 2, scopeKey, serverNow: 1000,
    rows: [{ visible: cut }, { pending: { conversationType: 2, targetId: rows[1]!.conversationID } }] }
  const response = (input: unknown) => proto.lookup("codec.DeliveryOutputProofResult").encode(input).finish()
  const valid = contract.validateResult(topic, contract.readerRequest(topic, request), codec.decodeQuery(topic, response(result)))
  expect(valid.rows).toEqual([{ kind: "visible", cut: { ...cut, complete: false } }, rows[1]])
  expect(valid.serverNow).toBe(1000)
  expect(codec.decodeQuery(topic, response(result)).rows[0].pending).toBeUndefined()
  const rejects = (run: () => unknown) => {
    try { run(); return false } catch { return true }
  }
  const badRequest = (input: unknown) => rejects(() => codec.encodeQuery(topic, input))
  const badResult = (input: unknown) => rejects(() => contract.validateResult(topic,
    contract.readerRequest(topic, request), codec.decodeQuery(topic, response(input))))
  expect(badRequest({ ...request, version: 1 })).toBe(true)
  expect(badRequest({ ...request, rows: [rows[0]] })).toBe(true)
  expect(badRequest({ ...request, rows: [...rows, rows[0]] })).toBe(true)
  expect(badRequest({ ...request, rows: Array.from({ length: 33 }, (_, index) =>
    ({ kind: "pending", conversationType: 1, conversationID: `peer-${index}` })) })).toBe(true)
  expect(badRequest({ ...request, index: 1 })).toBe(true)
  expect(badRequest({ ...request, rows: [rows[0], { ...rows[1], membershipCurrent: true }] })).toBe(true)
  expect(badRequest({ ...request, rows: [rows[0], { ...rows[1], conversationID: "\0" }] })).toBe(true)
  expect(badRequest({ ...request, rows: [rows[0], { ...rows[1], conversationID: "界".repeat(171) }] })).toBe(true)
  expect(badRequest({ ...request, rows: Array.from({ length: 9 }, (_, index) =>
    ({ kind: "pending", conversationType: 1, conversationID: `${index}${"p".repeat(510)}` })) })).toBe(true)
  const sparse = Array(2)
  sparse[0] = rows[0]
  expect(badRequest({ ...request, rows: sparse })).toBe(true)
  const observed = { reads: 0 }
  const accessor = [rows[0], rows[1]]
  Object.defineProperty(accessor, "1", { get() { observed.reads++; return rows[1] } })
  expect(badRequest({ ...request, rows: accessor })).toBe(true)
  expect(observed.reads).toBe(0)
  expect(badResult({ ...result, rows: result.rows.toReversed() })).toBe(true)
  expect(badResult({ ...result, rows: [result.rows[0]] })).toBe(true)
  expect(badResult({ ...result, rows: [{ visible: { ...cut, serverNow: 1001 } }, result.rows[1]] })).toBe(true)
  expect(badResult({ ...result, rows: [{ visible: { ...cut, projectionRevision: "1" } }, result.rows[1]] })).toBe(true)
  expect(badResult({ ...result, rows: [{ visible: { ...cut, complete: true } }, result.rows[1]] })).toBe(true)
  expect(badResult({ ...result, rows: [{ visible: { ...cut, liveUnread: "2" } }, result.rows[1]] })).toBe(true)
  expect(badResult({ ...result, rows: [{ visible: { ...cut, readOrdinal: "6" } }, result.rows[1]] })).toBe(true)
  expect(badResult({ ...result, rows: [{ visible: { ...cut, throughOrdinal: "6" } }, result.rows[1]] })).toBe(true)
  expect(badResult({ ...result, rows: [{ ...result.rows[0], pending: result.rows[1]!.pending }, result.rows[1]] })).toBe(true)
  expect(badResult({ ...result, rows: [{}, result.rows[1]] })).toBe(true)
  expect(rejects(() => codec.decodeQuery(topic, new Uint8Array(16385)))).toBe(true)
  expect(rejects(() => codec.decodeQuery(topic, Uint8Array.from([...response(result), 40, 1])))).toBe(true)
  expect(rejects(() => codec.decodeQuery(topic, Uint8Array.from([8, 2, ...response(result)])))).toBe(true)
  expect(rejects(() => codec.encodeQuery("qry_delivery_read_cut", { version: 2, scopeKey,
    projectionKey, projectionRevision: revision, outputRows: wire.outputRows }))).toBe(true)
  const header = { version: 2, scopeKey, currentCursor: "0", serverNow: 1000,
    maxPageItems: 32, maxChangeBytes: 65536, maxMessageBytes: 4194304, maxWindowPages: 100000 }
  expect(contract.validateResult("qry_delivery_reader", { version: 2 }, header).outputProofAvailable).toBeUndefined()
  expect(contract.validateResult("qry_delivery_reader", { version: 2 }, { ...header, outputProofAvailable: true }).outputProofAvailable).toBe(true)
  expect(rejects(() => contract.validateResult("qry_delivery_reader", { version: 1 },
    { ...header, version: 1, outputProofAvailable: true }))).toBe(true)
})

test("distributed SDK accepts unread and complete ordered proofs with exact wire semantics", () => {
  const scopeKey = "a".repeat(64)
  const projectionKey = "b".repeat(64)
  const topic = "qry_delivery_output_proof"
  const request = { version: 2, scopeKey, rows: [
    { kind: "visible", projectionKey, projectionRevision: "1" },
    { kind: "pending", conversationType: 2, conversationID: "g" + "c".repeat(24) },
  ] }
  expect(generated.encodeQuery(topic, request)).toEqual(codec.encodeQuery(topic, request))
  const cut = { version: 2, scopeKey, projectionKey, projectionRevision: "1", throughOrdinal: "1",
    targetAdmittedOrdinal: "1", readOrdinal: "0", liveUnread: "1", storedUnread: "1", serverNow: 1000 }
  for (const state of [cut, { ...cut, readOrdinal: "1", liveUnread: "0", storedUnread: "0", complete: true }]) {
    const wire = proto.lookup("codec.DeliveryOutputProofResult").encode({ version: 2, scopeKey, serverNow: 1000,
      rows: [{ visible: state }, { pending: { conversationType: 2, targetId: request.rows[1]!.conversationID } }] }).finish()
    const decoded = generated.decodeQuery(topic, wire)
    expect(decoded).toEqual(codec.decodeQuery(topic, wire))
    expect(generated.validateResult(topic, generated.readerRequest(topic, request), decoded))
      .toEqual(contract.validateResult(topic, contract.readerRequest(topic, request), codec.decodeQuery(topic, wire)))
  }
})
