import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { IMReaderProductDescriptor } from "./im-reader-product-descriptor"

function input(authorizationFile = "/private/tmp/reader/auth") {
  const createdAt = Date.now()
  const scope = (key: string) => ({
    directory: `/private/tmp/reader/${key}`,
    workspaceID: `reader-${key}`,
    ordinary: Array.from({ length: 34 }, (_, index) => ({
      id: `${key}-ordinary-${index}`,
      name: `${key} local ${index}`,
    })),
    protected: Array.from({ length: 3 }, (_, index) => ({
      id: `${key}-protected-${index}`,
      name: `${key} remote ${index}`,
    })),
    selectedGroupID: `${key}-protected-2`,
    messages: {
      ids: Array.from({ length: 125 }, (_, index) => `${key}-message-${index}`),
      markers: Array.from({ length: 125 }, (_, index) => `qa-reader-${key}-${String(index).padStart(3, "0")}`),
      oldestMarker: `qa-reader-${key}-000`,
      newestMarker: `qa-reader-${key}-124`,
    },
  })
  return {
    version: 1,
    window: "ordinary-reader-registry-product",
    createdAt,
    deadlineAt: createdAt + 900000,
    root: { url: "http://127.0.0.1:54321/", authorizationFile },
    scopes: { A: scope("A"), B: scope("B") },
    faults: { state: "unavailable", reason: "Original backend held-page and cold-ready signals are not provided" },
  }
}

test("dry descriptor keeps two real placement expectations and explicitly open faults", () => {
  const value = IMReaderProductDescriptor.decode(input())
  expect(IMReaderProductDescriptor.safe(value)).toMatchObject({
    directoryCount: 2,
    ordinaryCounts: [34, 34],
    protectedCounts: [3, 3],
    messagesPerDirectory: 125,
    faultActions: "unavailable",
  })
  expect(IMReaderProductDescriptor.safe(value).faultCoverage).toContain("OPEN")
})

test("dry descriptor rejects directory/group aliases and a first-page target", () => {
  const alias = input()
  alias.scopes.B.directory = alias.scopes.A.directory
  expect(() => IMReaderProductDescriptor.decode(alias)).toThrow()
  const duplicate = input()
  duplicate.scopes.B.protected[0]!.id = duplicate.scopes.A.protected[0]!.id
  expect(() => IMReaderProductDescriptor.decode(duplicate)).toThrow()
  const firstPage = input()
  firstPage.scopes.A.selectedGroupID = firstPage.scopes.A.protected[0]!.id
  expect(() => IMReaderProductDescriptor.decode(firstPage)).toThrow()
})

test("dry descriptor requires all original IDs and rendered markers without duplicates", () => {
  const duplicate = input()
  duplicate.scopes.A.messages.ids[124] = duplicate.scopes.A.messages.ids[0]!
  expect(() => IMReaderProductDescriptor.decode(duplicate)).toThrow()
  const missing = input()
  missing.scopes.B.messages.markers.pop()
  expect(() => IMReaderProductDescriptor.decode(missing)).toThrow()
  const notInBody = input()
  notInBody.scopes.A.messages.oldestMarker = "not-present"
  expect(() => IMReaderProductDescriptor.decode(notInBody)).toThrow()
})

test("dry descriptor rejects embedded credentials and caller authority fields", () => {
  const credential = input()
  credential.root.url = "http://operator:secret@127.0.0.1:54321/"
  expect(() => IMReaderProductDescriptor.decode(credential)).toThrow()
  expect(() => IMReaderProductDescriptor.decode({ ...input(), permit: { valid: true } })).toThrow()
})

// Private credential acceptance below requires POSIX mode enforcement, not Windows chmod emulation.
test.skipIf(process.platform === "win32")(
  "dry preparation reads only an actual private Basic file and does not contact Root",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-im-reader-dry-"))
    try {
      const authorizationFile = path.join(root, "authorization")
      await fs.writeFile(authorizationFile, `Basic ${Buffer.from("reader:synthetic-dry-only").toString("base64")}`, {
        mode: 0o600,
      })
      const descriptor = path.join(root, "descriptor.json")
      await fs.writeFile(descriptor, JSON.stringify(input(authorizationFile)), { mode: 0o600 })
      const value = await IMReaderProductDescriptor.prepare(descriptor)
      expect(value.input.scopes.A.messages.ids.length).toBe(125)
      expect(value.authorization.startsWith("Basic ")).toBe(true)
      await fs.chmod(authorizationFile, 0o644)
      await expect(IMReaderProductDescriptor.prepare(descriptor)).rejects.toThrow()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)
