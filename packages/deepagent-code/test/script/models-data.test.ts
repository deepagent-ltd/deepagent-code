import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadModelsData } from "../../script/models-data"

const catalog = {
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    env: ["DEEPSEEK_API_KEY"],
    models: {
      "deepseek-v4-flash": {
        id: "deepseek-v4-flash",
      },
    },
  },
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepagent-models-build-"))
  return {
    root,
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  }
}

describe("models.dev build data", () => {
  test("uses and validates an explicitly configured snapshot", async () => {
    await using directory = await fixture()
    const file = path.join(directory.root, "configured.json")
    await Bun.write(file, JSON.stringify(catalog))

    const result = await loadModelsData({ environment: { MODELS_DEV_API_JSON: file } })

    expect(result.source).toBe(file)
    expect(JSON.parse(result.data)).toEqual(catalog)
    expect(result.sha256).toBe(new Bun.CryptoHasher("sha256").update(JSON.stringify(catalog)).digest("hex"))
  })

  test("fetches a fresh catalog and persists the last good copy", async () => {
    await using directory = await fixture()
    const server = Bun.serve({ port: 0, fetch: () => Response.json(catalog) })
    const cacheFile = path.join(directory.root, "cache", "models.json")
    const result = await loadModelsData({
      environment: { DEEPAGENT_CODE_MODELS_URL: server.url.origin },
      cacheFile,
    }).finally(() => server.stop(true))

    expect(result.source).toBe(`${server.url.origin}/api.json`)
    expect(JSON.parse(result.data)).toEqual(catalog)
    expect(await Bun.file(cacheFile).json()).toEqual(catalog)
  })

  test("rejects an invalid explicitly configured snapshot instead of silently changing sources", async () => {
    await using directory = await fixture()
    const file = path.join(directory.root, "invalid.json")
    await Bun.write(file, "{}")

    await expect(loadModelsData({ environment: { MODELS_DEV_API_JSON: file } })).rejects.toThrow(
      "Configured models.dev snapshot is invalid",
    )
  })

  test("fails over to the next endpoint when the first one is unavailable", async () => {
    const broken = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 500 }) })
    const healthy = Bun.serve({ port: 0, fetch: () => Response.json(catalog) })
    const result = await loadModelsData({
      environment: { DEEPAGENT_CODE_MODELS_URL: `${broken.url.origin}, ${healthy.url.origin}` },
    }).finally(() => {
      broken.stop(true)
      healthy.stop(true)
    })

    expect(result.source).toBe(`${healthy.url.origin}/api.json`)
    expect(JSON.parse(result.data)).toEqual(catalog)
  })

  test("fails closed when models.dev is unavailable", async () => {
    await using directory = await fixture()
    const cacheFile = path.join(directory.root, "models.json")
    const builderOnly = {
      "builder-only": {
        id: "builder-only",
        name: "Builder only",
        models: { leaked: { id: "leaked" } },
      },
    }
    await Bun.write(cacheFile, JSON.stringify(builderOnly))

    await expect(
      loadModelsData({
        environment: { DEEPAGENT_CODE_MODELS_URL: "http://127.0.0.1:1", DEEPAGENT_CODE_CHANNEL: "dev" },
        cacheFile,
        requestTimeoutMs: 200,
      }),
    ).rejects.toThrow("refusing to use a local snapshot")
    expect(await Bun.file(cacheFile).json()).toEqual(builderOnly)
  })

  test("does not allow a snapshot to override a production build", async () => {
    await using directory = await fixture()
    const file = path.join(directory.root, "configured.json")
    await Bun.write(file, JSON.stringify(catalog))

    await expect(
      loadModelsData({
        environment: {
          MODELS_DEV_API_JSON: file,
          DEEPAGENT_CODE_CHANNEL: "prod",
          DEEPAGENT_CODE_MODELS_URL: "http://127.0.0.1:1",
        },
        requestTimeoutMs: 200,
      }),
    ).rejects.toThrow("MODELS_DEV_API_JSON is not allowed for production builds")
  })
})
