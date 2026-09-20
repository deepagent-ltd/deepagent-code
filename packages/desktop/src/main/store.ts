import Store from "electron-store"
import electron from "electron"

import { SETTINGS_STORE } from "./store-keys"

const cache = new Map<string, Store>()
export const STORE_CACHE_LIMIT = 64

function requireStoreName(name: string) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/.test(name)) {
    throw new Error("Invalid desktop store name")
  }
  return name
}

// We cannot instantiate the electron-store at module load time because
// module import hoisting causes this to run before app.setPath("userData", ...)
// in index.ts has executed, which would result in files being written outside the canonical root.
export function getStore(name = SETTINGS_STORE) {
  const safeName = requireStoreName(name)
  const cached = cache.get(safeName)
  if (cached) {
    cache.delete(safeName)
    cache.set(safeName, cached)
    return cached
  }
  const next = new Store({
    name: safeName,
    cwd: electron.app.getPath("userData"),
    fileExtension: "",
    accessPropertiesByDotNotation: false,
  })
  cache.set(safeName, next)
  while (cache.size > STORE_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return next
}
