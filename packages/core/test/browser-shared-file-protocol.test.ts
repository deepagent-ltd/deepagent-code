import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { BrowserFileSchema } from "../src/browser/file-exchange.schema"
import { BrowserProtocol } from "../src/browser/protocol"
import { SharedBrowserFileSchema } from "../src/browser/shared-file-schema"
import { SharedBrowserProtocol } from "../src/browser/shared-protocol"

// Wire qualification only. A decoded binding cannot create a native file capability.
test("shared file private wire preserves original chunk limits and requires its complete distinct owner", () => {
  const binding: SharedBrowserFileSchema.Binding = { kind: "shared-v2", resourceID: "resource", rootSessionID: "session", mainIncarnation: "main",
    sidecarIncarnation: "sidecar", leaseID: "lease", leaseEpoch: 1, manualEpoch: 2, policyHash: "a".repeat(64), scopeHash: "b".repeat(64) }
  const owner = { type: "shared.file.leaf", id: "leaf", executeID: "execute", actionID: "action", binding,
    executionHash: "c".repeat(64), commandHash: "d".repeat(64), artifactID: "artifact" }
  const decode = Schema.decodeUnknownOption(SharedBrowserProtocol.FileLeaf, { onExcessProperty: "error" })
  const operations = [{ operation: "upload.read", offset: 0, length: BrowserFileSchema.CHUNK_BYTES },
    { operation: "download.write", offset: 0, payload: "/w==" },
    ...["upload.seal", "upload.observe", "download.publish"].map((operation) => ({ operation, bytes: 1, sha256: "e".repeat(64) }))]
  for (const operation of operations) expect(Option.isSome(decode({ ...owner, ...operation }))).toBe(true)
  const upload = { ...owner, operation: "upload.read", offset: 0, length: 1 }
  expect(Option.isNone(decode({ ...upload, controlID: "a-legacy-control-cannot-supply-this-owner" }))).toBe(true)
  expect(Option.isNone(decode({ ...upload, binding: { ...binding, kind: "browser-v1" } }))).toBe(true)
  expect(Option.isNone(decode({ ...upload, executionHash: undefined }))).toBe(true)
  expect(Option.isNone(decode({ ...upload, length: BrowserFileSchema.CHUNK_BYTES + 1 }))).toBe(true)
  expect(Option.isNone(Schema.decodeUnknownOption(BrowserProtocol.FileLeaf, { onExcessProperty: "error" })(upload))).toBe(true)
  const response = { type: "shared.file.leaf.response", id: "leaf", payload: Buffer.alloc(BrowserFileSchema.CHUNK_BYTES, 0xff).toString("base64") }
  expect(Option.isSome(Schema.decodeUnknownOption(SharedBrowserProtocol.FileLeafResponse, { onExcessProperty: "error" })(response))).toBe(true)
  expect(Option.isNone(Schema.decodeUnknownOption(SharedBrowserProtocol.FileLeafResponse, { onExcessProperty: "error" })({ ...response,
    payload: Buffer.alloc(BrowserFileSchema.CHUNK_BYTES + 1, 0xff).toString("base64") }))).toBe(true)
})
