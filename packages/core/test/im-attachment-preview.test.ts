import { expect, test } from "bun:test"
import { AttachmentPreview } from "../src/im/attachment-preview"

const png = () =>
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8MsAAAAASUVORK5CYII=", "base64")

test("real PNG dimensions are inspected before any decoder; oversized and animated inputs are download-only", () => {
  expect(AttachmentPreview.inspect(png())).toEqual({ mime: "image/png", width: 1, height: 1 })
  const giant = png()
  giant.writeUInt32BE(8000, 16)
  giant.writeUInt32BE(8000, 20)
  expect(AttachmentPreview.inspect(giant)).toBeUndefined()
  const chunk = Buffer.alloc(20)
  chunk.writeUInt32BE(8)
  chunk.write("acTL", 4)
  expect(AttachmentPreview.inspect(Buffer.concat([png().subarray(0, 33), chunk, png().subarray(33)]))).toBeUndefined()
  expect(AttachmentPreview.inspect(png().subarray(0, 34))).toBeUndefined()
  expect(AttachmentPreview.inspect(Buffer.concat([png(), Buffer.from("junk")]))).toBeUndefined()
  expect(AttachmentPreview.inspect(Buffer.from('<svg onload="alert(1)">'))).toBeUndefined()
  expect(AttachmentPreview.inspect(Buffer.from("GIF89a........"))).toBeUndefined()
})

test("malformed lengths and marker floods cannot produce a preview or escape the byte budget", () => {
  const damaged = png()
  damaged.writeUInt32BE(0xffffffff, 33)
  expect(AttachmentPreview.inspect(damaged)).toBeUndefined()
  expect(AttachmentPreview.inspect(new Uint8Array(AttachmentPreview.previewBytes + 1))).toBeUndefined()
  expect(AttachmentPreview.inspect(Buffer.from([255, 216, 255, 192, 255, 255]))).toBeUndefined()
  expect(AttachmentPreview.displayName("name\x1b]8;;file:///secret\x07\u202e.txt")).not.toMatch(/[\x00-\x1f\u202e]/)
})
