import path from "node:path"
import { loadModelsData } from "./models-data"

process.chdir(path.resolve(import.meta.dir, ".."))

const models = await loadModelsData()
export const modelsData = models.data
export const modelsSource = (() => {
  if (/^https?:\/\//.test(models.source)) return models.source
  const relative = path.relative(path.resolve(import.meta.dir, ".."), path.resolve(models.source))
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative.replaceAll("\\", "/")
  return `external:${path.basename(models.source)}`
})()
export const modelsSha256 = models.sha256
console.log(`Loaded models.dev snapshot from ${models.source} (sha256:${models.sha256})`)
