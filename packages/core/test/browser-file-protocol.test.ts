import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { BrowserProtocol } from "../src/browser/protocol"
import { BrowserFileSchema } from "../src/browser/file-exchange.schema"

test("private browser leaf frames accept one bounded binary chunk and reject encoded oversize", () => {
  const response = Schema.decodeUnknownOption(BrowserProtocol.FileLeafResponse)
  const leaf = Schema.decodeUnknownOption(BrowserProtocol.FileLeaf)
  const fields = { type: "file.leaf", id: "leaf", executeID: "execute", actionID: "action", controlID: "control",
    digest: "a".repeat(64), artifactID: "artifact" }
  const payload = Buffer.alloc(BrowserFileSchema.CHUNK_BYTES, 0xa5).toString("base64")
  expect(Option.isSome(response({ type: "file.leaf.response", id: "leaf", payload }))).toBe(true)
  expect(Option.isSome(leaf({ ...fields, operation: "download.write", offset: 0, payload }))).toBe(true)
  expect(Option.isSome(leaf({ ...fields, operation: "upload.read", offset: 0, length: BrowserFileSchema.CHUNK_BYTES }))).toBe(true)
  expect(Option.isNone(leaf({ ...fields, operation: "upload.read", offset: 0, length: BrowserFileSchema.CHUNK_BYTES + 1 }))).toBe(true)
  for (const bytes of [BrowserFileSchema.CHUNK_BYTES + 1, BrowserFileSchema.CHUNK_BYTES + 2]) {
    const oversized = Buffer.alloc(bytes).toString("base64")
    // These exceed the byte limit while still fitting its rounded base64 length.
    expect(oversized.length).toBe(payload.length)
    expect(Option.isNone(response({ type: "file.leaf.response", id: "leaf", payload: oversized }))).toBe(true)
    expect(Option.isNone(leaf({ ...fields, operation: "download.write", offset: 0, payload: oversized }))).toBe(true)
  }
  expect(Option.isNone(response({ type: "file.leaf.response", id: "leaf", payload: "AAAA=" }))).toBe(true)
  expect(Option.isNone(Schema.decodeUnknownOption(BrowserProtocol.FileLeafResponse, { onExcessProperty: "error" })(
    { type: "file.leaf.response", id: "leaf", payload: "A===", extra: true }))).toBe(true)
})
