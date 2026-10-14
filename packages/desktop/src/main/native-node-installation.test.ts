import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash, generateKeyPairSync } from "node:crypto"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../../../deepagent-code/src/installation/native-installation.schema"
import { signNativeNodeArtifact } from "../../../deepagent-code/script/sign-native-node"
import { managedBrowserInputRuntime } from "../../scripts/managed-browser-input-runtime"
import { managedBrowserInputFixtureEnvironment, managedBrowserInputFixtureExecutable } from "./fixture/managed-browser-input-runtime"

test("actual Electron utility interpreter verifies a sealed physical Node entry and adjacent assets", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-native-node-electron-")))
  await fs.chmod(root, 0o700)
  const key = generateKeyPairSync("ed25519")
  const fixture = path.join(import.meta.dir, "../../../deepagent-code/test/installation/fixture/native-node-installation-process.ts")
  const main = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/native-node-installation.ts")],
    outdir: root, target: "node", external: ["electron"], naming: "main.mjs" })
  expect(main.success).toBe(true)
  const run = async (entry: string) => {
    const child = Bun.spawn([managedBrowserInputFixtureExecutable, main.outputs[0]!.path], {
      env: { ...managedBrowserInputFixtureEnvironment, PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root,
        XDG_CACHE_HOME: root, DAC_NATIVE_NODE_ROOT: root, DAC_NATIVE_NODE_ENTRY: entry }, stdout: "pipe", stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 20_000)
    const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timer)
    expect({ code: result[0], stderr: result[2] }).toMatchObject({ code: 0 })
    return await Bun.file(path.join(root, "utility-result.json")).json() as { code: number; stdout: string; stderr: string }
  }
  try {
    const probe = path.join(root, "probe.mjs")
    await fs.writeFile(probe, "process.stdout.write(JSON.stringify({ runtime: process.execPath, electron: process.versions.electron }) + '\\n', () => process.exit(0))\n")
    const first = await run(probe)
    expect(first.code).toBe(0)
    const runtime = JSON.parse(first.stdout) as { runtime: string; electron: string }
    expect(runtime.electron).toBe(managedBrowserInputRuntime.electronVersion)
    const source = await fs.readFile(fixture)
    const components = new NativeInstallationSchema.Components({ schemaVersion: "dac.native-components.v1",
      target: `${process.platform}-${process.arch}`, sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40),
      components: [new NativeInstallationSchema.Component({ path: "packages/deepagent-code/test/installation/fixture/native-node-installation-process.ts",
        bytes: source.length, sha256: createHash("sha256").update(source).digest("hex") })] })
    const metadata = CanonicalJson.stringify(components)
    const module = path.join(root, "node.js")
    const build = await Bun.build({ entrypoints: [fixture], target: "node", format: "esm", outdir: root, naming: "node.js",
      define: { DEEPAGENT_CODE_NATIVE_RUNTIME_PUBLIC_KEY: JSON.stringify(key.publicKey.export({ type: "spki", format: "pem" }).toString()),
        DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: JSON.stringify(metadata), DEEPAGENT_CODE_NATIVE_NODE_ARTIFACT: "true" } })
    expect(build.success).toBe(true)
    await fs.writeFile(`${module}.native-components.json`, metadata)
    await signNativeNodeArtifact({ module, runtime: await fs.realpath(runtime.runtime), releaseID: "private-electron-module", privateKey: key.privateKey })
    const second = await run(module)
    expect(second.code).toBe(0)
    const inspected = JSON.parse(second.stdout) as { ok: boolean; result?: { assets: string; cloneRejected: boolean } }
    expect(inspected.ok).toBe(true)
    expect(inspected.result?.assets).toBe(root)
    expect(inspected.result?.cloneRejected).toBe(true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 45_000)
