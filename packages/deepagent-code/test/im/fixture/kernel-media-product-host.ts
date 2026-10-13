import assert from "node:assert/strict"
import path from "node:path"

// A disposable real listener. The caller supplies a fresh HOME/DB and owns its
// stop file; this fixture never copies a user DB or starts a provider turn.
const root = path.resolve(process.argv[2] ?? "")
assert(root.startsWith("/tmp/dac-im-media-product-"))
assert(process.env.DEEPAGENT_CODE_TEST_HOME === root)
assert(process.env.DEEPAGENT_CODE_DB === path.join(root, "data", "database.sqlite"))
assert(process.env.DEEPAGENT_IM_AGENT_RESPONDER === "off")
assert(process.env.DEEPAGENT_CODE_DISABLE_MODELS_FETCH === "1")
assert(process.env.DEEPAGENT_IM_KERNEL_MEDIA_PROFILE === "mysql-protected-media-v1")
assert(new URL(process.env.DEEPAGENT_IM_FACADE_URL ?? "").hostname === "127.0.0.1")
const { MediaProductTrace } = await import("./kernel-media-product-trace")
const closeTrace = process.env.DAC_IM_MEDIA_OBSERVE === "1" ? await MediaProductTrace.install(root) : undefined
const closeFiles = process.env.DAC_IM_MEDIA_FILE_OBSERVE === "1" ? await (async () => {
  const { OriginalMediaFileTrace } = await import("./kernel-media-original-file-trace")
  return OriginalMediaFileTrace.install(root)
})() : undefined
const { Server } = await import("../../../src/server/server")
const port = Number(process.env.DAC_IM_HOST_PORT)
assert([58645, 58646, 59135, 59136].includes(port))
const listener = await Server.listen({ hostname: "127.0.0.1", port, cors: ["http://127.0.0.1:64675"] })
try {
  await Bun.write(path.join(root, "host-ready.json"), JSON.stringify({ pid: process.pid, url: listener.url.origin, directory: path.join(root, "workspace") }))
  const deadline = Date.now() + 15 * 60_000
  while (!await Bun.file(path.join(root, "stop")).exists()) {
    assert(Date.now() < deadline, "private integration fixture deadline")
    await Bun.sleep(200)
  }
} finally {
  await listener.stop(true).finally(async () => { await closeFiles?.(); await closeTrace?.() })
}
