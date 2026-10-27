import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { writeSync } from "node:fs"

const root = path.resolve(process.argv[2] ?? "")
const lane = process.argv[3]
assert(root.startsWith(path.join(os.tmpdir(), "dac-im-media-product-lanes-")))
assert(lane === "original" || lane === "qa")
assert(process.env.DEEPAGENT_CODE_TEST_HOME === root)
assert(process.env.DEEPAGENT_CODE_DB === path.join(root, "data", "database.sqlite"))
assert(process.env.DEEPAGENT_IM_AGENT_RESPONDER === "off")
assert(process.env.DEEPAGENT_CODE_DISABLE_MODELS_FETCH === "1")
assert(process.env.DEEPAGENT_IM_KERNEL_MEDIA_PROFILE === "mysql-protected-media-v1")
assert(process.env.DEEPAGENT_CODE_V4_FILE_UPLOAD_ENABLED === "true")
assert(new URL(process.env.DEEPAGENT_IM_FACADE_URL ?? "").hostname === "127.0.0.1")
const port = Number(process.env.DAC_IM_HOST_PORT)
assert(Number.isInteger(port) && port > 1024 && port < 65536)
const { MediaProductTrace } = await import("./kernel-media-product-trace")
const closeNative = await MediaProductTrace.install(root)
const trace = await fs.open(path.join(root, "lane-effect-safe.jsonl"), "wx", 0o600)
const count = { value: 0 }
const report = (fact: object) => { if (count.value++ < 4096) { try { writeSync(trace.fd, JSON.stringify(fact) + "\n") } catch {} } }
const { Global } = await import("@deepagent-code/core/global")
assert(Global.Path.config.startsWith(root + path.sep))
await Bun.write(path.join(Global.Path.config, "config.jsonc"), JSON.stringify({ $schema: "https://ai.deepagent.ltd/config.schema.json", im: { url: process.env.DEEPAGENT_IM_FACADE_URL } }))
const { Database } = await import("@deepagent-code/core/database/database")
const { Layer } = await import("effect")
const { IMDeviceStore } = await import("../../../src/im/device-store")
const { SecretStore } = await import("../../../src/mcp/secret-store")
const deviceDirectory = process.env.DAC_IM_DEVICE_DIRECTORY
const deviceBackend = process.env.DAC_IM_DEVICE_BACKEND
assert(deviceDirectory && deviceBackend && path.dirname(deviceDirectory) === path.join(path.dirname(path.dirname(root)), lane, "platform"))
assert(deviceBackend === path.join(path.dirname(deviceDirectory), "custody.json"))
const deviceStore = Layer.succeed(IMDeviceStore.Service, IMDeviceStore.make({ directory: deviceDirectory, backend: SecretStore.fileBackend(deviceBackend) }))
const { MediaFileTrace } = await import("./kernel-media-file-trace")
const files = MediaFileTrace.install(await fs.realpath(Global.Path.data), (fact) => report({ ...fact, stage: "fs", at: Date.now() }))
const { builtAppRuntimeRoot, AppRuntime } = await import("../../../src/effect/app-runtime")
const before = builtAppRuntimeRoot()
const ready = async (url: string, originalReady?: boolean) => {
  const after = builtAppRuntimeRoot()
  await fs.writeFile(path.join(root, "lane-ready-safe.json"), JSON.stringify({ pid: process.pid, url, lane, directory: path.join(root, "workspace"),
    databasePathMatches: Database.path() === process.env.DEEPAGENT_CODE_DB,
    rootBefore: { present: before !== undefined, sameDatabase: before?.databasePath === Database.path() },
    rootAfter: { present: after !== undefined, sameDatabase: after?.databasePath === Database.path() },
    scopeKind: lane === "original" ? "Server.listen real private scope/memoMap selection" : "QA Layer.build scope",
    builder: lane === "original" ? "original layerFromConfig" : "original effects plus QA observer",
    normalBootstrap: "default production graph; no InstanceStore/InstanceBootstrap replacement", originalListenerReady: originalReady,
  }), { mode: 0o600 })
}
const wait = async () => {
  const deadline = Date.now() + 45000
  while (!await Bun.file(path.join(root, "stop")).exists()) { assert(Date.now() < deadline, "Controlled lane deadline"); await Bun.sleep(100) }
}
try {
  if (lane === "original") {
    const { Server } = await import("../../../src/server/server")
    const listener = await Server.listen({ hostname: "127.0.0.1", port, cors: ["http://127.0.0.1:64675"], imDeviceStore: deviceStore })
    try { await ready(listener.url.origin, Server.privateLocalWritesAvailable()); await wait() }
    finally { await listener.stop(true) }
  }
  if (lane === "qa") {
    const { Effect } = await import("effect")
    const { MediaEffectTrace } = await import("./kernel-media-effect-trace")
    const { MediaEffectListener } = await import("./kernel-media-effect-listener")
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const listener = yield* MediaEffectListener.start({ port, buildEngine: MediaEffectTrace.builder(report), deviceStore })
      yield* Effect.promise(() => ready(listener.url))
      yield* Effect.promise(wait)
    })))
  }
  await fs.writeFile(path.join(root, "lane-stop-safe.json"), JSON.stringify({ lane, normalStop: true, scopeClosed: true, fileCounts: files.counts, eventCount: count.value }), { mode: 0o600 })
} finally {
  files.restore()
  await AppRuntime.dispose()
  await closeNative().finally(() => trace.close())
}
