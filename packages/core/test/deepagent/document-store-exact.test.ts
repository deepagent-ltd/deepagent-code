import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DocumentStore, DocumentInspectionError } from "../../src/deepagent/document-store"

function fixture(body: (root: string, store: DocumentStore, id: string) => void) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dac-c1-exact-doc-")))
  try {
    const store = new DocumentStore(root)
    const doc = store.create({
      type: "plan",
      scope: "run:fixture",
      body: "first",
      description: "precise plan",
      provenance: { source: "runner" },
    })
    body(root, store, doc.id)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function file(root: string, id: string, version = 1) {
  return path.join(root, "docs", "plan", `${id.replaceAll(":", "__")}@v${version}.json`)
}

test("exact handle uses real append-only CAS, reads matching successor and rejects another writer", () =>
  fixture((root, ordinary, id) => {
    const first = DocumentStore.openExact(root, [id])
    const loser = DocumentStore.openExact(root, [id])
    const next = first.update(id, "exact successor")
    expect(next.version).toBe(2)
    expect(loser.update(id, "exact successor").hash).toBe(next.hash)
    expect(() => loser.update(id, "conflicting next")).not.toThrow()
    expect(() => first.update(id, "other v3")).toThrow()
    expect(DocumentStore.openExact(root, [id]).get(id)?.body).toBe("conflicting next")
    // The ordinary constructor/shared semantics have not been replaced by the exact view.
    expect(ordinary.get(id)?.version).toBe(1)
    expect(new DocumentStore(root).get(id)?.version).toBe(3)
  }))

for (const kind of [
  "symlink",
  "oversize",
  "invalid-utf8",
  "invalid-json",
  "wrong-identity",
  "too-many-versions",
  "too-many-entries",
  "type-symlink",
] as const) {
  test(`exact IO refuses ${kind} without exposing raw path or content`, () =>
    fixture((root, store, id) => {
      const selected = file(root, id)
      if (kind === "symlink") {
        fs.renameSync(selected, selected + ".private")
        fs.symlinkSync(selected + ".private", selected)
      }
      if (kind === "oversize") fs.truncateSync(selected, 1048577)
      if (kind === "invalid-utf8") fs.writeFileSync(selected, Buffer.from([0xff, 0xfe, 0xfd]))
      if (kind === "invalid-json") fs.writeFileSync(selected, '{"private":"secret-value"')
      if (kind === "wrong-identity")
        fs.writeFileSync(selected, JSON.stringify({ ...store.get(id), id: "doc:plan:other" }))
      if (kind === "too-many-versions") {
        for (let version = 2; version <= 257; version++) store.update(id, `version ${version}`)
      }
      if (kind === "too-many-entries") {
        for (let index = 0; index < 4096; index++)
          fs.writeFileSync(path.join(root, "docs/plan", `unrelated-${index}`), "")
      }
      if (kind === "type-symlink") {
        fs.renameSync(path.join(root, "docs/plan"), path.join(root, "docs/private"))
        fs.symlinkSync(path.join(root, "docs/private"), path.join(root, "docs/plan"))
      }
      const error = (() => {
        try {
          DocumentStore.openExact(root, [id])
        } catch (error) {
          return error
        }
      })()
      expect(error).toBeInstanceOf(DocumentInspectionError)
      expect(String(error)).not.toContain(root)
      expect(JSON.stringify(error)).not.toContain("secret-value")
    }))
}

test("exact IO totals UTF8 encoded bytes and rejects aggregate overflow before unbounded load", () =>
  fixture((root, store, id) => {
    for (let index = 0; index < 18; index++) store.update(id, `${index}:` + "界".repeat(320000))
    expect(() => DocumentStore.openExact(root, [id])).toThrow(DocumentInspectionError)
  }))

test("exact IO visits only target type directories and rejects ambiguous requested IDs", () =>
  fixture((root, store, id) => {
    fs.mkdirSync(path.join(root, "docs/private"))
    fs.writeFileSync(path.join(root, "docs/private/secret.json"), "unreadable other type")
    expect(DocumentStore.openExact(root, [id]).get(id)?.hash).toBe(store.get(id)?.hash)
    expect(() => DocumentStore.openExact(root, [id, id])).toThrow(DocumentInspectionError)
    expect(() => DocumentStore.openExact(root, ["doc:../../private:escape"])).toThrow(DocumentInspectionError)
  }))

for (const kind of ["oversize", "symlink"] as const) {
  test(`exact CAS collision keeps bounded IO after another writer creates ${kind} successor`, () =>
    fixture((root, store, id) => {
      const captured = DocumentStore.openExact(root, [id])
      const target = file(root, id, 2)
      if (kind === "oversize") {
        fs.writeFileSync(target, "")
        fs.truncateSync(target, 1048577)
      }
      if (kind === "symlink") {
        fs.writeFileSync(target + ".private", "private-marker")
        fs.symlinkSync(target + ".private", target)
      }
      expect(() => captured.update(id, "expected next")).toThrow(DocumentInspectionError)
      expect(store.get(id)?.version).toBe(1)
    }))
}
