import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../../src/installation/native-installation.schema"
import { signNativeNodeArtifact } from "../../script/sign-native-node"

test("sealed Node entry verifies its actual runtime, immutable handles and adjacent assets", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-native-node-module-"))
  const key = generateKeyPairSync("ed25519")
  const runtimeProbe = Bun.spawn(["node", "-p", "process.execPath"], { stdout: "pipe", stderr: "pipe" })
  const runtime = (await new Response(runtimeProbe.stdout).text()).trim()
  expect(await runtimeProbe.exited).toBe(0)
  const fixture = path.join(import.meta.dir, "fixture/native-node-installation-process.ts")
  const source = await fs.readFile(fixture)
  const components = new NativeInstallationSchema.Components({ schemaVersion: "dac.native-components.v1",
    target: `${process.platform}-${process.arch}`, sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40),
    components: [new NativeInstallationSchema.Component({ path: "packages/deepagent-code/test/installation/fixture/native-node-installation-process.ts",
      bytes: source.length, sha256: createHash("sha256").update(source).digest("hex") })] })
  const metadata = CanonicalJson.stringify(components)
  const make = async (name: string, sealed = true) => {
    const directory = path.join(root, name)
    await fs.mkdir(directory, { mode: 0o700 })
    const module = path.join(directory, "node.js")
    const build = await Bun.build({ entrypoints: [fixture], target: "node", format: "esm", outdir: directory,
      naming: "node.js", define: { DEEPAGENT_CODE_NATIVE_RUNTIME_PUBLIC_KEY: JSON.stringify(key.publicKey.export({ type: "spki", format: "pem" }).toString()),
        DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: JSON.stringify(metadata), DEEPAGENT_CODE_NATIVE_NODE_ARTIFACT: String(sealed) } })
    expect(build.success).toBe(true)
    await fs.writeFile(`${module}.native-components.json`, metadata)
    const signed = await signNativeNodeArtifact({ module, runtime, releaseID: "private-node-module", privateKey: key.privateKey })
    return { module, signed }
  }
  const run = async (module: string, mode = "inspect") => {
    const child = Bun.spawn([runtime, module, mode], { env: { HOME: root, TMPDIR: root, XDG_DATA_HOME: root }, stdout: "pipe", stderr: "pipe" })
    const stdout = await new Response(child.stdout).text()
    const stderr = await new Response(child.stderr).text()
    return { code: await child.exited, value: JSON.parse(stdout) as { ok: boolean; result?: { cloneRejected: boolean; assets?: string; changed?: boolean; invalidated?: boolean }; error?: { code: string } }, stderr }
  }
  try {
    const good = await make("good")
    const inspected = await run(good.module)
    expect(inspected.code).toBe(0)
    expect(inspected.value.result?.assets).toBe(path.dirname(good.module))
    expect(inspected.value.result?.cloneRejected).toBe(true)
    const unsealed = await make("unsealed", false)
    expect((await run(unsealed.module)).value.error?.code).toBe("NATIVE_INSTALLATION_UNAVAILABLE")
    const wrongRuntime = await make("wrong-runtime")
    const payload = new NativeInstallationSchema.NodePayload({ ...wrongRuntime.signed.payload,
      runtime: new NativeInstallationSchema.Executable({ bytes: wrongRuntime.signed.payload.runtime.bytes, sha256: "0".repeat(64) }) })
    await fs.writeFile(`${wrongRuntime.module}${NativeInstallationSchema.SIDECAR_SUFFIX}`, CanonicalJson.stringify(new NativeInstallationSchema.NodeManifest({ payload,
      signature: sign(null, Buffer.from(CanonicalJson.stringify(payload)), key.privateKey).toString("hex") })))
    expect((await run(wrongRuntime.module)).value.error?.code).toBe("NATIVE_BYTES_MISMATCH")
    const changed = await make("changed")
    await fs.appendFile(changed.module, "\n// changed before admission\n")
    expect((await run(changed.module)).value.error?.code).toBe("NATIVE_BYTES_MISMATCH")
    const late = await make("late")
    const mutated = await run(late.module, "mutate")
    expect(mutated.code).toBe(0)
    expect(mutated.value.result).toEqual({ changed: true, invalidated: true, cloneRejected: true })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)
