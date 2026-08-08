import path from "node:path"
import { loadModelsData } from "./models-data"

process.chdir(path.resolve(import.meta.dir, ".."))

const models = await loadModelsData()
export const modelsData = models.data
console.log(`Loaded models.dev snapshot from ${models.source}`)
