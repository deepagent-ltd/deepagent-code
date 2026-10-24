import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { SecretStore } from "../../../src/mcp/secret-store"
import { dpapiCodec } from "../../../src/mcp/dpapi.node"
import { IMDeviceStore } from "../../../src/im/device-store"

// Run on the actual target OS. Every account, service and file is owned by this
// probe; it neither reads an existing installation nor exports private custody.
const directory = await mkdtemp(path.join(os.tmpdir(), "dac-im-native-custody-"))
const service = `dac-im-owned-probe-${crypto.randomUUID()}`
const file = path.join(directory, "owned.dpapi.json")
const backend = await SecretStore.selectNativeBackend(service, file).catch(() => undefined)
if (!backend) {
  await rm(directory, { recursive: true, force: true })
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, available: false, failClosed: true, purchased: 0 }))
  process.exit(2)
}
try {
  const secret = `owned-${crypto.randomUUID()}\n中文𐐀\n`
  await backend.put("roundtrip", secret)
  if (await backend.get("roundtrip") !== secret) throw new Error("Native custody changed UTF-8 bytes")
  const store = IMDeviceStore.make({ backend, directory })
  const identity = await Effect.runPromise(store.preflight)
  if ((await Effect.runPromise(IMDeviceStore.make({ backend, directory }).preflight)).deviceJkt !== identity.deviceJkt)
    throw new Error("Native custody lost the installation identity")
  const lease = await Effect.runPromise(store.acquireOwner("https://owned-probe.invalid"))
  try {
    const duplicate = await Effect.runPromise(store.acquireOwner("https://owned-probe.invalid").pipe(Effect.result))
    if (duplicate._tag !== "Failure" || duplicate.failure.code !== "im_owner_busy") throw new Error("Duplicate IM owner admitted")
  } finally { await lease.release() }
  const retired = await Effect.runPromise(store.acquireOwner("https://owned-probe.invalid"))
  await retired.release()
  if (process.platform === "win32") {
    // The actual Desktop .NET codec must read Bun's actual crypt32 output and vice versa.
    const node = SecretStore.dpapiBackend(file, dpapiCodec)
    if (!await node.available() || await node.get("roundtrip") !== secret) throw new Error("Desktop DPAPI cannot read CLI custody")
    await node.put("desktop-roundtrip", secret)
    if (await backend.get("desktop-roundtrip") !== secret) throw new Error("CLI DPAPI cannot read Desktop custody")
    await node.remove("desktop-roundtrip")
    if ((await Bun.file(file).text()).includes(secret)) throw new Error("DPAPI leaked plaintext")
  }
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, backend: backend.id, available: true,
    byteExact: true, restartIdentity: true, singleOwner: true, desktopCodecInterop: process.platform === "win32", purchased: 0 }))
} finally {
  await backend.remove("roundtrip")
  await backend.remove("installation-p256-v1")
  await rm(directory, { recursive: true, force: true })
}
