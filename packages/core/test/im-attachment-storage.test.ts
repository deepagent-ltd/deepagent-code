import { describe, it, expect } from "bun:test"
import { createHash } from "node:crypto"
import nodePath from "node:path"
import { AttachmentStorage } from "../src/im/attachment-storage"

// §B3 文件上传 — direct unit tests for the pure upload-policy + storage-path core. This is the
// security-critical surface (mime allow-list, size cap, sha256, server-derived path + traversal
// prevention) and is tested here WITHOUT the multipart HTTP transport (which hangs over the in-memory
// test server). The route handler is a thin wrapper over these functions.
describe("AttachmentStorage — upload policy + storage-path derivation", () => {
  describe("validateUpload", () => {
    it("accepts an allowed mime, returns size + correct sha256 checksum", () => {
      const bytes = new TextEncoder().encode("hello attachment payload")
      const result = AttachmentStorage.validateUpload({ contentType: "text/plain", bytes })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.mime).toBe("text/plain")
        expect(result.sizeBytes).toBe(bytes.byteLength)
        expect(result.checksum).toBe(createHash("sha256").update(bytes).digest("hex"))
      }
    })

    it("normalizes a mime with parameters (charset) to the bare type", () => {
      const bytes = new TextEncoder().encode("x")
      const result = AttachmentStorage.validateUpload({ contentType: "text/plain; charset=utf-8", bytes })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.mime).toBe("text/plain")
    })

    it("rejects a disallowed mime type", () => {
      const result = AttachmentStorage.validateUpload({
        contentType: "application/x-evil",
        bytes: new Uint8Array([1, 2, 3]),
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe("unsupported_media_type")
    })

    it("allows any text/* subtype even if not explicitly listed", () => {
      const result = AttachmentStorage.validateUpload({
        contentType: "text/x-python",
        bytes: new TextEncoder().encode("print('hi')"),
      })
      expect(result.ok).toBe(true)
    })

    it("rejects a file over the size cap", () => {
      const result = AttachmentStorage.validateUpload({
        contentType: "text/plain",
        bytes: new Uint8Array(11),
        maxBytes: 10,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe("file_too_large")
        if (result.error === "file_too_large") expect(result.maxBytes).toBe(10)
      }
    })

    it("honors an explicit extra-allow set", () => {
      const allow = AttachmentStorage.allowedMimeSet()
      allow.add("application/x-custom")
      const result = AttachmentStorage.validateUpload({
        contentType: "application/x-custom",
        bytes: new Uint8Array([1]),
        allow,
      })
      expect(result.ok).toBe(true)
    })
  })

  describe("deriveStoragePath", () => {
    it("derives <dataDir>/im-attachments/<ws>/<id> from server ids only", () => {
      const r = AttachmentStorage.deriveStoragePath({
        dataDir: "/data",
        workspaceID: "ws1",
        attachmentID: "ima_abc",
      })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.baseDir).toBe(nodePath.join("/data", "im-attachments", "ws1"))
        expect(r.storagePath).toBe(nodePath.join("/data", "im-attachments", "ws1", "ima_abc"))
      }
    })

    it("sanitizes a workspace id that contains path separators / traversal", () => {
      const r = AttachmentStorage.deriveStoragePath({
        dataDir: "/data",
        workspaceID: "../../etc",
        attachmentID: "ima_abc",
      })
      expect(r.ok).toBe(true)
      if (r.ok) {
        // The traversal is neutralized: the resolved path stays under <dataDir>/im-attachments.
        const base = nodePath.resolve("/data", "im-attachments")
        expect(nodePath.resolve(r.storagePath).startsWith(base + nodePath.sep)).toBe(true)
        expect(r.storagePath).not.toContain("..")
      }
    })

    it("a malicious 'filename-like' attachment id cannot change the target directory", () => {
      // Even if an id somehow contained separators, sanitizeSegment strips them so the path can't escape.
      const r = AttachmentStorage.deriveStoragePath({
        dataDir: "/data",
        workspaceID: "ws1",
        attachmentID: "../../../../etc/passwd",
      })
      expect(r.ok).toBe(true)
      if (r.ok) {
        const base = nodePath.resolve("/data", "im-attachments", "ws1")
        expect(nodePath.resolve(r.storagePath).startsWith(base + nodePath.sep)).toBe(true)
        expect(r.storagePath).not.toContain("passwd/")
        expect(r.storagePath).not.toContain("..")
      }
    })
  })

  describe("sanitizeSegment", () => {
    it("strips path separators, collapses dot-runs, and never yields empty", () => {
      expect(AttachmentStorage.sanitizeSegment("a/b\\c")).not.toContain("/")
      expect(AttachmentStorage.sanitizeSegment("a/b\\c")).not.toContain("\\")
      expect(AttachmentStorage.sanitizeSegment("..")).not.toBe("..")
      expect(AttachmentStorage.sanitizeSegment("")).toBe("default")
    })
  })
})
