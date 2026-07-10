import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { auditPackageInputs } from "./audit-package"

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "deepagent-package-audit-"))
  await mkdir(path.join(root, "out", "main", "domain-packs"), { recursive: true })
  await mkdir(path.join(root, "resources"), { recursive: true })
  await writeFile(path.join(root, "out", "main", "index.js"), "export {}")
  return {
    root,
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  }
}

describe("auditPackageInputs", () => {
  test("accepts generated application assets", async () => {
    await using root = await fixture()
    await expect(auditPackageInputs(root.root)).resolves.toBeUndefined()
  })

  test("rejects runtime databases", async () => {
    await using root = await fixture()
    await writeFile(path.join(root.root, "out", "deepagent-code.db"), "history")
    await expect(auditPackageInputs(root.root)).rejects.toThrow("runtime user-data file")
  })

  test("rejects personal paths in bundled domain packs", async () => {
    await using root = await fixture()
    await writeFile(path.join(root.root, "out", "main", "domain-packs", "pack.json"), "/Users/alice/skills")
    await expect(auditPackageInputs(root.root)).rejects.toThrow("absolute user home path")
  })

  test("rejects personal paths in generated JavaScript", async () => {
    await using root = await fixture()
    await writeFile(path.join(root.root, "out", "main", "index.js"), 'const root = "/home/alice/project"')
    await expect(auditPackageInputs(root.root)).rejects.toThrow("absolute user home path")
  })

  test("rejects symlinks in package inputs", async () => {
    await using root = await fixture()
    await symlink(path.join(root.root, "out", "main", "index.js"), path.join(root.root, "resources", "linked.js"))
    await expect(auditPackageInputs(root.root)).rejects.toThrow("symbolic link")
  })
})
