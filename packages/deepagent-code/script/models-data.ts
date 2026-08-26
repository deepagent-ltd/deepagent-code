import { mkdir, rename, rm } from "node:fs/promises"
import path from "node:path"

export async function loadModelsData(
  options: {
    environment?: Readonly<Record<string, string | undefined>>
    cacheFile?: string
    requestTimeoutMs?: number
  } = {},
) {
  const environment = options.environment ?? process.env
  const channel = environment.DEEPAGENT_CODE_CHANNEL?.trim()
  const buildMarker =
    (channel !== undefined && channel !== "" && channel !== "dev") ||
    Boolean(environment.DEEPAGENT_CODE_VERSION?.trim()) ||
    Boolean(environment.DEEPAGENT_CODE_RELEASE?.trim())
  const configuredFile = environment.MODELS_DEV_API_JSON?.trim()
  if (configuredFile) {
    if (buildMarker) {
      throw new Error("MODELS_DEV_API_JSON is not allowed for production builds; unset it to fetch models.dev")
    }
    const configured = await readCatalog(configuredFile)
    if (!configured) throw new Error(`Configured models.dev snapshot is invalid: ${configuredFile}`)
    return result(configured, configuredFile)
  }

  // Clean-build policy: DEEPAGENT_CODE_MODELS_URL accepts a comma-separated ordered list of fresh
  // remote endpoints. Default chain: models.dev (primary) then the Gitee mirror of
  // deepagent-ltd/models.dev (hourly-synced, reachable from CN networks). Every source must serve
  // the live catalog; we never fall back to a stale local snapshot — if all endpoints fail, the
  // build fails closed.
  const modelsURLs = (
    environment.DEEPAGENT_CODE_MODELS_URL?.trim() ||
    "https://models.dev,https://gitee.com/deepagent-ai/models.dev/raw/main"
  )
    .split(",")
    .map((url) => url.trim().replace(/\/$/, ""))
    .filter((url) => url.length > 0)
  for (const modelsURL of modelsURLs) {
    const remote = await fetch(`${modelsURL}/api.json`, {
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? 10_000),
    })
      .then(async (response) => (response.ok ? catalog(await response.json()) : undefined))
      .catch(() => undefined)
    if (!remote) continue
    if (options.cacheFile) {
      await persistCatalog(options.cacheFile, remote).catch((error) =>
        console.warn(
          `Unable to update models.dev build cache: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
    }
    return result(remote, `${modelsURL}/api.json`)
  }

  throw new Error(
    `Unable to load models.dev catalog from ${modelsURLs.join(", ")}; refusing to use a local snapshot`,
  )
}

function result(data: Record<string, unknown>, source: string) {
  const serialized = JSON.stringify(data)
  return {
    data: serialized,
    source,
    sha256: new Bun.CryptoHasher("sha256").update(serialized).digest("hex"),
  }
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
