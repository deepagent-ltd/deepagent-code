// Clean-build policy: ordered list of fresh remote endpoints; fail closed when all fail (never
// fall back to a stale local snapshot). Default chain: models.dev then the Gitee mirror of
// deepagent-ltd/models.dev (hourly-synced, reachable from CN networks).
const modelsURLs = (
  process.env.DEEPAGENT_CODE_MODELS_URL?.trim() ||
  "https://models.dev,https://gitee.com/deepagent-ai/models.dev/raw/main"
)
  .split(",")
  .map((url) => url.trim().replace(/\/$/, ""))
  .filter((url) => url.length > 0)

async function load() {
  if (process.env.MODELS_DEV_API_JSON) return Bun.file(process.env.MODELS_DEV_API_JSON).text()
  for (const modelsUrl of modelsURLs) {
    const response = await fetch(`${modelsUrl}/api.json`).catch(() => undefined)
    if (response?.ok) return response.text()
  }
  throw new Error(`Unable to load models.dev catalog from ${modelsURLs.join(", ")}`)
}

export const modelsData = await load()

console.log("Loaded models.dev snapshot")
