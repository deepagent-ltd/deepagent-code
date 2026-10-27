import { mock } from "bun:test"
import { Layer } from "effect"
import { fileURLToPath } from "node:url"
import { SecretStore } from "../../src/mcp/secret-store"

if (!process.env.DEEPAGENT_CODE_TEST_HOME) throw new Error("CLI secret-store fixture requires an isolated test home")

// HOME does not isolate the OS Keychain. Keep the real store API and service identity,
// replacing only backend selection before the actual CLI builds its application layer.
const original = SecretStore
const modulePath = fileURLToPath(import.meta.resolve("../../src/mcp/secret-store"))
const ownedLayer = original.testLayer(original.inMemoryBackend("cli-owned-memory"))
mock.module(modulePath, () => ({
  SecretStore: { ...original, defaultLayer: ownedLayer },
}))
const loaded = await import(modulePath)
if (loaded.SecretStore.defaultLayer !== ownedLayer)
  throw new Error("CLI secret-store backend isolation was not installed")

const deviceModule = await import("../../src/im/device-store")
const devicePath = fileURLToPath(import.meta.resolve("../../src/im/device-store"))
const deviceLayer = Layer.succeed(
  deviceModule.IMDeviceStore.Service,
  deviceModule.IMDeviceStore.make({
    backend: {
      id: "cli-custody-unavailable",
      available: async () => false,
      get: async () => {
        throw new Error("CLI fixture must not read device custody")
      },
      put: async () => {
        throw new Error("CLI fixture must not write device custody")
      },
      remove: async () => {
        throw new Error("CLI fixture must not remove device custody")
      },
    },
  }),
)
mock.module(devicePath, () => ({
  ...deviceModule,
  layer: deviceLayer,
  IMDeviceStore: { ...deviceModule.IMDeviceStore, layer: deviceLayer },
}))
const deviceLoaded = await import(devicePath)
if (deviceLoaded.IMDeviceStore.layer !== deviceLayer) throw new Error("CLI device custody isolation was not installed")
