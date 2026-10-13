import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"

test("Windows offline publisher uses only the inventoried private host and retains file and current fences", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "dac-windows-publisher-host-")))
  try {
    const child = Bun.spawn([process.execPath, "--eval", `
      import assert from "node:assert/strict"
      import fs from "node:fs/promises"
      import path from "node:path"
      import { createHash } from "node:crypto"
      import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
      import { withWindowsNativePublisherHost } from ${JSON.stringify(path.join(import.meta.dir, "build-windows-native-bootstrap.ts"))}
      const root = ${JSON.stringify(root)}
      const actualPlatform = process.platform
      Object.defineProperty(process, "platform", { value: "win32", configurable: true })
      Object.defineProperty(process, "arch", { value: "x64", configurable: true })
      const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
      const passed = []
      const fixture = async (name = "node.js") => {
        const directory = await fs.mkdtemp(path.join(root, "cohort-"))
        const artifact = path.join(directory, name)
        await fs.writeFile(artifact, "compiled fixture")
        const bytes = Buffer.alloc(512)
        bytes.write("MZ")
        bytes.writeUInt32LE(128, 0x3c)
        bytes.write("PE\\0\\0", 128)
        bytes.writeUInt16LE(0x8664, 132)
        const components = {
          schemaVersion: "dac.native-components.v1", target: "win32-x64",
          sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40),
          components: ["bun-command-runtime.exe", "native-image-factory.node"].map((name) => ({
            path: "packages/work-file-helper/bin/win32-x64/" + name, bytes: bytes.length, sha256: hash(bytes),
          })),
        }
        for (const name of ["bun-command-runtime.exe", "native-image-factory.node"])
          await fs.writeFile(path.join(directory, name), bytes)
        const metadata = artifact + ".native-components.json"
        const save = () => fs.writeFile(metadata, CanonicalJson.stringify(components))
        await save()
        return { artifact, directory, metadata, bytes, components, save }
      }
      const clean = async (value) => assert.equal((await fs.readdir(value.directory)).filter((name) => name.startsWith(".native-publisher-host-")).length, 0)
      const reject = async (label, change, use = async () => { throw new Error("unexpected callback") }) => {
        const value = await fixture()
        await change(value)
        await assert.rejects(withWindowsNativePublisherHost(value.artifact, use), undefined, label)
        await clean(value)
        passed.push(label)
      }
      for (const name of ["node.js", "deepagent-code.exe"]) {
        const value = await fixture(name)
        const result = await withWindowsNativePublisherHost(value.artifact, async (host) => {
          assert.equal(path.basename(host), "bun.exe")
          assert.notEqual(path.dirname(host), value.directory)
          assert.equal((await fs.lstat(host)).nlink, 1)
          assert.equal(hash(await fs.readFile(host)), value.components.components[0].sha256)
          assert.equal(hash(await fs.readFile(path.join(value.directory, "bun-command-runtime.exe"))), value.components.components[0].sha256)
          return name
        })
        assert.equal(result, name)
        await clean(value)
        passed.push("exact-private-copy:" + name)
      }
      await reject("wrong-target", async (v) => { v.components.target = "win32-arm64"; await v.save() })
      await reject("missing-owned-namespace", async (v) => { v.components.components[0].path = "foreign/bun-command-runtime.exe"; await v.save() })
      await reject("duplicate-inventory", async (v) => { v.components.components.push(v.components.components[0]); await v.save() })
      await reject("inventory-hash", async (v) => { v.components.components[0].sha256 = "0".repeat(64); await v.save() })
      await reject("inventory-size", async (v) => { v.components.components[0].bytes++; await v.save() })
      await reject("wrong-pe-abi", async (v) => {
        v.bytes.writeUInt16LE(0xaa64, 132)
        await fs.writeFile(path.join(v.directory, "bun-command-runtime.exe"), v.bytes)
        v.components.components[0].sha256 = hash(v.bytes)
        await v.save()
      })
      await reject("source-hardlink", (v) => fs.link(path.join(v.directory, "bun-command-runtime.exe"), path.join(v.directory, "source-alias")))
      await reject("metadata-hardlink", (v) => fs.link(v.metadata, path.join(v.directory, "metadata-alias")))
      await reject("changed-host", async () => {}, async (host) => { await fs.writeFile(host, "changed"); return true })
      await reject("changed-owned-parent", async () => {}, async (host) => { await fs.writeFile(path.join(path.dirname(host), "foreign"), "changed"); return true })
      const changedMetadata = await fixture()
      await assert.rejects(withWindowsNativePublisherHost(changedMetadata.artifact, async () => {
        await fs.writeFile(changedMetadata.metadata, "changed")
        return true
      }), /fixed file changed/)
      await clean(changedMetadata)
      passed.push("changed-inventory-during-call")
      await reject("callback-failure-cleanup", async () => {}, async () => { throw new Error("callback failure") })
      if (actualPlatform !== "win32") {
        await reject("symlink-source", async (v) => {
          const original = path.join(v.directory, "bun-command-runtime.exe")
          await fs.rename(original, original + ".original")
          await fs.symlink(original + ".original", original)
        })
      }
      console.log(JSON.stringify({ passed, actualFilesystemPlatform: actualPlatform, publisherOperations: 0, nativeFirstLoadQualification: false }))
    `], { cwd: path.resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    const result = JSON.parse(stdout)
    expect(result.passed).toHaveLength(process.platform === "win32" ? 14 : 15)
    expect(result.publisherOperations).toBe(0)
    expect(result.nativeFirstLoadQualification).toBe(false)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
