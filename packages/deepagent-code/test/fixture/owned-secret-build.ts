import fs from "node:fs/promises"

// Fixed build-time test IO boundary. Service identities and the real store API
// remain in the bundle; authentication/Native tests own no OS credential store.
export const ownedSecretBuild: Bun.BunPlugin = {
  name: "owned-fixture-secret-backends",
  setup(builder) {
    builder.onLoad({ filter: /[\\/]mcp[\\/]secret-store\.ts$/ }, async (input) => {
      const source = await fs.readFile(input.path, "utf8")
      const marker = "export const defaultLayer = layer"
      if (source.split(marker).length !== 2) throw new Error("Secret-store fixture boundary changed")
      return {
        loader: "ts",
        contents: source.replace(
          marker,
          'export const defaultLayer = Layer.suspend(() => testLayer(inMemoryBackend("owned-build-memory")))',
        ),
      }
    })
    builder.onLoad({ filter: /[\\/]im[\\/]device-store\.ts$/ }, async (input) => {
      const source = await fs.readFile(input.path, "utf8")
      const marker = "export const layer = Layer.sync(Service, () => make())"
      if (source.split(marker).length !== 2) throw new Error("Device-store fixture boundary changed")
      return {
        loader: "ts",
        contents: source.replace(
          marker,
          `export const layer = Layer.sync(Service, () => make({
          backend: { id: "owned-build-device-unavailable", available: async () => false,
            get: async () => { throw new Error("Owned fixture has no device custody") },
            put: async () => { throw new Error("Owned fixture has no device custody") },
            remove: async () => { throw new Error("Owned fixture has no device custody") } }
        }))`,
        ),
      }
    })
  },
}
