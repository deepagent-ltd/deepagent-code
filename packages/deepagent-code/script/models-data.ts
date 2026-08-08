import { mkdir, rename, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { resolveDataPath } from "@deepagent-code/core/global-path"

const repositorySnapshotFile = path.resolve(import.meta.dir, "../test/tool/fixtures/models-api.json")

export async function loadModelsData(
  options: {
    environment?: Readonly<Record<string, string | undefined>>
    cacheFile?: string
    fallbackFiles?: readonly string[]
    requestTimeoutMs?: number
  } = {},
) {
  const environment = options.environment ?? process.env
  const configuredFile = environment.MODELS_DEV_API_JSON?.trim()
  if (configuredFile) {
    const configured = await readCatalog(configuredFile)
    if (!configured) throw new Error(`Configured models.dev snapshot is invalid: ${configuredFile}`)
    return { data: JSON.stringify(configured), source: configuredFile }
  }

  const modelsURL = (environment.DEEPAGENT_CODE_MODELS_URL?.trim() || "https://models.dev").replace(/\/$/, "")
  const remote = await fetch(`${modelsURL}/api.json`, {
    signal: AbortSignal.timeout(options.requestTimeoutMs ?? 10_000),
  })
    .then(async (response) => (response.ok ? catalog(await response.json()) : undefined))
    .catch(() => undefined)
  const cacheFile = options.cacheFile ?? path.join(resolveDataPath(), "cache", "models.json")
  if (remote) {
    await persistCatalog(cacheFile, remote).catch((error) =>
      console.warn(
        `Unable to update models.dev build cache: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
    return { data: JSON.stringify(remote), source: `${modelsURL}/api.json` }
  }

  const fallbacks = options.fallbackFiles ?? [
    cacheFile,
    path.join(os.homedir(), ".cache", "opencode", "models.json"),
    repositorySnapshotFile,
  ]
  const cached = (await Promise.all(fallbacks.map(async (file) => ({ file, data: await readCatalog(file) })))).find(
    (item): item is { file: string; data: Record<string, unknown> } => item.data !== undefined,
  )
  if (!cached) throw new Error(`Unable to load a valid models.dev catalog from ${modelsURL} or local snapshots`)
  return { data: JSON.stringify(cached.data), source: cached.file }
}

function catalog(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  const providers = Object.values(value)
  if (providers.length === 0) return
  if (
    providers.some(
      (provider) =>
        typeof provider !== "object" ||
        provider === null ||
        Array.isArray(provider) ||
        typeof (provider as Record<string, unknown>).models !== "object" ||
        (provider as Record<string, unknown>).models === null ||
        Array.isArray((provider as Record<string, unknown>).models),
    )
  )
    return
  return value as Record<string, unknown>
}

async function readCatalog(file: string) {
  return catalog(
    await Bun.file(file)
      .json()
      .catch(() => undefined),
  )
}

async function persistCatalog(file: string, data: Record<string, unknown>) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(temporary, `${JSON.stringify(data)}\n`)
  await rename(temporary, file).catch(async (error) => {
    await rm(temporary, { force: true })
    throw error
  })
}
