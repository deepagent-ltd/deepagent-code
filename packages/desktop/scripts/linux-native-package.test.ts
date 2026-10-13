import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Arch, type Configuration } from "electron-builder"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { LinuxNativeDevManifest } from "../../deepagent-code/script/build-linux-native-assets"

test("original Linux package hooks reject missing unpacked bytes and a replaced valid cohort", async () => {
  const cache = path.resolve("node_modules/.cache")
  await fs.mkdir(cache, { recursive: true })
  const root = await fs.realpath(await fs.mkdtemp(path.join(await fs.realpath(cache), "dac-linux-package-hooks-")))
  try {
    // Bundle the real configuration so import.meta.url owns this private stage.
    // The tests call its actual hooks; no Electron or ELF payload is executed.
    const build = await Bun.build({
      entrypoints: [path.resolve("electron-builder.config.ts")], outdir: root,
      target: "bun", format: "esm", external: ["electron-builder"],
    })
    expect(build.success).toBe(true)
    const config = (await import(build.outputs[0]!.path)).default as Configuration
    await fs.cp(path.resolve("resources/linux-work-provisioning"), path.join(root, "resources/linux-work-provisioning"), { recursive: true })
    const before = config.beforePack
    const after = config.afterPack
    if (typeof before !== "function" || typeof after !== "function") throw new Error("Missing actual package hooks")
    const source = path.join(root, "out/main/chunks")
    const installed = path.join(root, "candidate/resources/app.asar.unpacked/out/main/chunks")
    await fs.mkdir(source, { recursive: true })
    const elf = Buffer.alloc(128)
    elf.writeUInt32LE(0x464c457f, 0); elf[4] = 2; elf[5] = 1; elf[6] = 1
    elf.writeUInt16LE(3, 16); elf.writeUInt16LE(62, 18); elf.writeUInt32LE(1, 20)
    const names = ["deepagent-work-file-helper", "deepagent-work-storage-cleanup", "deepagent-work-process-supervisor",
      "bun-command-runtime", "runtime-closure/lib64/ld-linux-x86-64.so.2"]
    await Promise.all(names.map(async (name) => {
      await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true })
      await fs.writeFile(path.join(source, name), elf, { mode: 0o755 })
    }))
    const licenses = ["NOTICE", "work-file-helper.LICENSE", "work-file-helper.NOTICE", "work-file-helper.UPSTREAM.json"]
    await fs.mkdir(path.join(source, "linux-native-licenses"))
    await Promise.all(licenses.map((name) => fs.writeFile(path.join(source, "linux-native-licenses", name), "fixture provenance\n", { mode: 0o644 })))
    const sha256 = (body: Buffer | string) => createHash("sha256").update(body).digest("hex")
    const manifest: LinuxNativeDevManifest = {
      schemaVersion: "dac.linux-native-dev-assets.v1", target: "linux-x64", sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40),
      source: [{ path: "packages/work-file-helper/Cargo.lock", bytes: 1, sha256: sha256("source") }],
      tools: ["cargo", "rustc", "readelf", "ldconfig", "dpkg-query", "git"].map((name) => ({ name, bytes: 1, sha256: sha256(name), version: "fixture; not executed" })),
      runtimeVersion: "fixture-only",
      assets: names.map((name) => ({ path: `packages/work-file-helper/bin/linux-x64/${name}`, bytes: elf.length, sha256: sha256(elf) })),
      licenses: licenses.map((name) => ({ path: `linux-native-licenses/${name}`, bytes: Buffer.byteLength("fixture provenance\n"), sha256: sha256("fixture provenance\n") })),
    }
    await fs.writeFile(path.join(source, "linux-native-dev-assets.json"), CanonicalJson.stringify(manifest), { mode: 0o644 })
    await fs.cp(source, installed, { recursive: true })
    const context = { outDir: root, targets: [], appOutDir: path.join(root, "candidate"), electronPlatformName: "linux", arch: Arch.x64,
      packager: { executableName: "deepagent-code-dev", appInfo: { productFilename: "DeepAgent Code Dev",
        sanitizedProductName: "DeepAgent Code Dev" } } } as unknown as Parameters<typeof before>[0]
    await before(context)
    await after(context)
    await before(context)
    await fs.rm(path.join(installed, names[4]!))
    await expect(after(context)).rejects.toThrow()
    await fs.cp(source, installed, { recursive: true })
    await before(context)
    const replaced = CanonicalJson.stringify({ ...manifest, sourceCommit: "c".repeat(40) })
    await fs.writeFile(path.join(source, "linux-native-dev-assets.json"), replaced)
    await fs.writeFile(path.join(installed, "linux-native-dev-assets.json"), replaced)
    // Both copies are valid. The original pre-pack hash must still win.
    await expect(after(context)).rejects.toThrow("cohort")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
