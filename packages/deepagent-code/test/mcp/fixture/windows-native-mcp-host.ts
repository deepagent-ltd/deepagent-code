import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Exit, Layer } from "effect"
import { Global } from "@deepagent-code/core/global"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { NativeInstallation } from "../../../src/installation/native-installation"
import { NativeWindowsBootstrap } from "../../../src/installation/windows-native-bootstrap"
import { NativeWindowsWorkFactory } from "../../../src/installation/windows-work-factory"
import { WindowsPrivateStorage } from "../../../src/installation/windows-private-storage"
import { WindowsSettingsStorage } from "../../../src/installation/windows-settings-storage"
import { McpWindowsStorage } from "../../../src/mcp/windows-storage"
import { McpAuth } from "../../../src/mcp/auth"

export async function main() {
  const root = process.env.DAC_NATIVE_NODE_COHORT_ROOT!
  const phase = (name: string) => fs.appendFile(path.join(root, "phases.jsonl"), `${JSON.stringify({ phase: name, at: Date.now() })}\n`)
  await NativeWindowsBootstrap.installFixedEntry()
  await phase("fixed-node-entry-installed")
  const original = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const installation = yield* NativeInstallation.current()
    const description = yield* NativeInstallation.describe(installation)
    assert.equal(description.target, `win32-${process.arch}`)
    const bootstrap = yield* NativeWindowsBootstrap.make(installation)
    assert.equal(bootstrap.description.preloaded, true)
    assert(NativeWindowsBootstrap.describe(bootstrap.capture))
    const native = Layer.succeed(NativeWindowsBootstrap.Service, bootstrap)
    yield* Layer.build(WindowsSettingsStorage.layer.pipe(Layer.provide(native)))
    yield* WindowsPrivateStorage.make("mcp_secret_envelopes", true).pipe(
      Effect.asVoid, Effect.scoped, Effect.provideService(NativeWindowsBootstrap.Service, bootstrap),
      Effect.catchTag("WindowsPrivateStorageError", () => Effect.void),
    )
    yield* Effect.promise(() => phase("original-private-roots-prepared"))
    const work = yield* Layer.build(NativeWindowsWorkFactory.layer.pipe(Layer.provide(native)))
    const storage = yield* Layer.build(McpWindowsStorage.layer.pipe(
      Layer.provide(native), Layer.provide(Layer.succeedContext(work)), Layer.provide(EffectFlock.defaultLayer),
    ))
    const port = Context.get(storage, McpWindowsStorage.Current)
    assert(port)
    assert(port.codec, "The original Node DPAPI helper must be available")
    yield* Effect.promise(async () => {
      const input = Uint8Array.from([7, 11, 19, 23, 31, 43, 47, 59, 61, 71, 83, 97, 101, 113, 127, 131])
      const buffers: Uint8Array[] = [input]
      try {
        const encrypted = await port.codec!.protect(input)
        buffers.push(encrypted)
        assert(encrypted.length > 0 && (encrypted.length !== input.length ||
          encrypted.some((value, index) => value !== input[index])), "Original DPAPI must produce ciphertext")
        const decrypted = await port.codec!.unprotect(encrypted)
        buffers.push(decrypted)
        assert(decrypted.length === input.length && decrypted.every((value, index) => value === input[index]),
          "Original DPAPI must round-trip the owned vector")
      } finally {
        buffers.forEach((bytes) => bytes.fill(0))
      }
      await phase("original-dpapi-round-trip")
    })
    const context = yield* Layer.build(McpAuth.defaultLayer.pipe(Layer.provide(Layer.succeedContext(storage))))
    const auth = Context.get(context, McpAuth.Service)
    assert.equal(yield* auth.get("owned-native-probe"), undefined)
    yield* auth.set("owned-native-probe", { tokens: { accessToken: "owned-native-probe-token", expiresAt: 60_000 } }, "https://owned.invalid/mcp")
    assert.equal((yield* auth.get("owned-native-probe"))?.tokens?.accessToken, "owned-native-probe-token")
    const file = yield* Effect.promise(() => port.read("mcp_legacy_auth"))
    assert(file && WindowsPrivateStorage.describe(file.witness), "The read must retain its original Native witness")
    yield* NativeInstallation.requireCurrent(installation)
    yield* Effect.promise(() => phase("mcp-original-native-set-get"))
    return auth
  })))
  assert(Exit.isFailure(await Effect.runPromiseExit(original.get("owned-native-probe"))), "Retired original custody must refuse reads")
  await phase("mcp-original-custody-retired")
  const result = { nativeInstallation: true, originalPreload: true, originalPrivateWitness: true,
    setGet: true, dpapiRoundTrip: true, retiredReadRejected: true, nativeRegisteredInjected: false, nativeCurrentInjected: false,
    codecInjected: false, windowsExecution: process.platform === "win32", processRuntime: process.versions.electron ? "electron-utility" : "unexpected",
    fileExists: (await fs.stat(path.join(Global.Path.config, "mcp-auth.json"))).isFile() }
  await fs.writeFile(path.join(root, "mcp-probe.json"), JSON.stringify(result))
  console.log("WINDOWS_NATIVE_MCP_PROBE", JSON.stringify(result))
}
