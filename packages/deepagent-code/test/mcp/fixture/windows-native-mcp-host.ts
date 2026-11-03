import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Exit, Layer } from "effect"
import { ContextTokenCodec } from "@deepagent-code/core/context-federation/token-codec"
import { Global } from "@deepagent-code/core/global"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { LiveContextTokenCodec } from "../../../src/context-federation/token-service"
import { NativeInstallation } from "../../../src/installation/native-installation"
import { NativeWindowsBootstrap } from "../../../src/installation/windows-native-bootstrap"
import { NativeWindowsWorkFactory } from "../../../src/installation/windows-work-factory"
import { WindowsPrivateStorage } from "../../../src/installation/windows-private-storage"
import { WindowsSettingsStorage } from "../../../src/installation/windows-settings-storage"
import { MediaFiles } from "../../../src/im/media-files"
import { McpWindowsStorage } from "../../../src/mcp/windows-storage"
import { McpAuth } from "../../../src/mcp/auth"
import { McpAuthJournal } from "../../../src/mcp/auth-journal"

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
    const token = yield* Effect.promise(() => tokenProbe())
    const journal = yield* Effect.promise(() => journalProbe(port))
    const context = yield* Layer.build(McpAuth.defaultLayer.pipe(Layer.provide(Layer.succeedContext(storage))))
    const auth = Context.get(context, McpAuth.Service)
    assert.equal(yield* auth.get("owned-native-probe"), undefined)
    yield* auth.set("owned-native-probe", { tokens: { accessToken: "owned-native-probe-token", expiresAt: 60_000 } }, "https://owned.invalid/mcp")
    assert.equal((yield* auth.get("owned-native-probe"))?.tokens?.accessToken, "owned-native-probe-token")
    const file = yield* Effect.promise(() => port.read("mcp_legacy_auth"))
    assert(file && WindowsPrivateStorage.describe(file.witness), "The read must retain its original Native witness")
    yield* NativeInstallation.requireCurrent(installation)
    yield* Effect.promise(() => phase("mcp-original-native-set-get"))
    return { auth, token, journal }
  })))
  assert(Exit.isFailure(await Effect.runPromiseExit(original.auth.get("owned-native-probe"))), "Retired original custody must refuse reads")
  await phase("mcp-original-custody-retired")
  const result = { nativeInstallation: true, originalPreload: true, originalPrivateWitness: true,
    setGet: true, dpapiRoundTrip: true, retiredReadRejected: true, nativeRegisteredInjected: false, nativeCurrentInjected: false,
    codecInjected: false, windowsExecution: process.platform === "win32", processRuntime: process.versions.electron ? "electron-utility" : "unexpected",
    fileExists: (await fs.stat(path.join(Global.Path.config, "mcp-auth.json"))).isFile(),
    token: original.token, journal: original.journal }
  await fs.writeFile(path.join(root, "mcp-probe.json"), JSON.stringify(result))
  console.log("WINDOWS_NATIVE_MCP_PROBE", JSON.stringify(result))
}

async function tokenProbe() {
  const filename = path.join(Global.Path.config, "context-federation", "token-keyring.json")
  const open = () => Effect.runPromise(
    Effect.gen(function* () {
      return yield* ContextTokenCodec.Service
    }).pipe(Effect.provide(LiveContextTokenCodec.layer({ filename })), Effect.scoped),
  )
  const [first, second] = await Promise.all([open(), open()])
  const token = first.sealContextRef({
    graph: "code",
    entityId: "entity",
    binding: { scope: "builtin" },
    revision: "revision",
  }, { issuedAt: 1, expiresAt: 10_000 })
  assert.equal((await Effect.runPromise(second.openContextRef(token, 2))).entityId, "entity")
  for (const entry of [
    { file: Global.Path.config, directory: true },
    { file: filename, directory: false },
  ]) {
    const invocation = MediaFiles.windowsPrivateInvocation(process.env.SystemRoot ?? "", entry.file, entry.directory, false)
    const checked = spawnSync(invocation.cmd[0], invocation.cmd.slice(1), {
      env: invocation.env,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    })
    assert.equal(checked.status, 0, `Native token privacy check failed: ${checked.error?.message ?? "unsafe ACL"}`)
  }
  return { concurrentStartup: true, restartRead: true, privateParentAcl: true, keyringAcl: true }
}

async function journalProbe(port: McpWindowsStorage.Port) {
  const file = path.join(Global.Path.config, "mcp-oauth", "journal.sqlite")
  const tag = "1".repeat(64)
  const slot = "2".repeat(64)
  const binding = {
    version: 1 as const,
    installationID: "native-storage-fixture",
    namespace: "sec_fixture",
    location: "loc_fixture",
    project: "prj_fixture",
    rootTag: tag,
    principal: { kind: "local" as const, selectionRevision: 0 },
    name: "native-journal",
    resource: "http://127.0.0.1:1/mcp",
    sourceTag: tag,
    configurationTag: tag,
    credentialTag: tag,
  }
  const flow = (id: string) => ({
    version: 1 as const,
    id,
    owner: "4".repeat(64),
    state: "5".repeat(64),
    phase: "preparing" as const,
    createdAt: Date.now(),
    expiresAt: Date.now() + 300000,
    redirectUri: "http://127.0.0.1:1/callback",
  })
  assert.equal(await McpAuthJournal.open(file, tag, "read", port), undefined)
  assert.equal(await fs.stat(path.dirname(file)).then(() => true, () => false), false)
  const journal = await McpAuthJournal.open(file, tag, "write", port)
  assert(journal)
  try {
    const handle = journal.begin({ slot, binding, flow: flow("3".repeat(64)), explicit: false })
    journal.updateFlow(handle, {
      discovery: { authorizationServerUrl: "http://127.0.0.1:1" },
      verifier: "v".repeat(43),
      discoveryTag: tag,
      phase: "awaiting_callback",
    })
    const credentials = {
      tokens: { accessToken: "native-access", refreshToken: "native-refresh", issuer: "http://127.0.0.1:1" },
    }
    journal.settle(journal.dispatch(handle, { kind: "exchange", requestTag: tag, endpointTag: tag }), {
      phase: "committed",
      credentials,
      outcome: { code: "committed" },
    })
    journal.updateFlow(handle, { phase: "connected" })
    assert.equal(journal.current(handle).row.credential_revision, 1)
    journal.settle(journal.dispatch(handle, { kind: "refresh", requestTag: tag, endpointTag: tag }), {
      phase: "committed",
      credentials,
      outcome: { code: "committed" },
    })
    assert.equal(journal.current(handle).row.credential_revision, 2)
    const unknown = journal.dispatch(handle, { kind: "refresh", requestTag: tag, endpointTag: tag })
    journal.settle(unknown, { phase: "unknown", outcome: { code: "network" } })
    assert.throws(() => journal.dispatch(handle, { kind: "refresh", requestTag: tag, endpointTag: tag }))
    assert.throws(() => journal.begin({ slot, binding, flow: flow("6".repeat(64)), explicit: false }))
    journal.revoke(handle, false)
    const current = journal.begin({ slot, binding, flow: flow("7".repeat(64)), explicit: true })
    assert.equal(journal.current(current).credentials.tokens, undefined)
    assert.equal(journal.current(current).row.credential_revision, 3)
  } finally {
    journal.close()
  }
  const cold = await McpAuthJournal.open(file, tag, "read", port)
  assert(cold)
  try {
    assert.equal(cold.read(slot)?.row.credential_revision, 3)
  } finally {
    cold.close()
  }
  return {
    canonicalPath: true,
    coldMissingRead: true,
    credentialRevisions: [1, 2],
    unknownRetryRejected: true,
    automaticRetryRejected: true,
    coldReadRevision: 3,
  }
}
