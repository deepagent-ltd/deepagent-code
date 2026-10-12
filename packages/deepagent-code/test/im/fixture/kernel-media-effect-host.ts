import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { writeSync } from "node:fs"
import path from "node:path"

const root = path.resolve(process.argv[2] ?? "")
assert(root.startsWith("/tmp/dac-im-media-product-"))
assert(process.env.DEEPAGENT_CODE_TEST_HOME === root)
assert(process.env.DEEPAGENT_CODE_DB === path.join(root, "data", "database.sqlite"))
assert(process.env.DEEPAGENT_IM_AGENT_RESPONDER === "off")
assert(process.env.DEEPAGENT_CODE_DISABLE_MODELS_FETCH === "1")
assert(process.env.DEEPAGENT_IM_KERNEL_MEDIA_PROFILE === "mysql-protected-media-v1")
assert(process.env.DEEPAGENT_CODE_V4_FILE_UPLOAD_ENABLED === "true")
assert(new URL(process.env.DEEPAGENT_IM_FACADE_URL ?? "").hostname === "127.0.0.1")
const port = Number(process.env.DAC_IM_HOST_PORT)
assert(port === 58645 || port === 58646)
const { MediaProductTrace } = await import("./kernel-media-product-trace")
const closeNative = await MediaProductTrace.install(root)
const file = await fs.open(path.join(root, "media-effect-safe.jsonl"), "wx", 0o600)
const count = { value: 0 }
const report = (fact: object) => { if (count.value++ < 4096) { try { writeSync(file.fd, JSON.stringify(fact) + "\n") } catch {} } }
const { Effect } = await import("effect")
const { Global } = await import("@deepagent-code/core/global")
const { MediaFileTrace } = await import("./kernel-media-file-trace")
const samples: Record<string, number> = {}
const files = MediaFileTrace.install(await fs.realpath(Global.Path.data), (fact) => {
  const key = `${fact.operation}:${fact.phase}`
  samples[key] = (samples[key] ?? 0) + 1
  // Repeated parent checks must not exhaust the bounded trace before Begin.
  // All original counts remain available in the final summary; same-FD events
  // are retained individually through the first complete four-file batch.
  if (["lstat", "realpath"].includes(fact.operation) && samples[key] > 4 && samples[key] % 100 !== 0) return
  report({ ...fact, stage: "fs", count: samples[key], at: Date.now() })
})
const { MediaEffectTrace } = await import("./kernel-media-effect-trace")
const { MediaEffectListener } = await import("./kernel-media-effect-listener")
try {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const listener = yield* MediaEffectListener.start({ port, buildEngine: MediaEffectTrace.builder(report) })
    yield* Effect.promise(() => Bun.write(path.join(root, "host-ready.json"), JSON.stringify({ pid: process.pid, url: listener.url, directory: path.join(root, "workspace"),
      composition: "QA createRoutes buildEngine; normal bootstrap/auth/runtime; differs from Server.listen control/restore/mDNS" })))
    const deadline = Date.now() + 15 * 60000
    while (!(yield* Effect.promise(() => Bun.file(path.join(root, "stop")).exists()))) {
      assert(Date.now() < deadline, "Private media listener deadline")
      yield* Effect.sleep("200 millis")
    }
  })))
} finally {
  files.restore()
  await fs.writeFile(path.join(root, "media-effect-fs-counts-safe.json"), JSON.stringify({ counts: files.counts, eventCount: Math.min(count.value, 4096) }), { mode: 0o600 })
  await closeNative().finally(() => file.close())
}
