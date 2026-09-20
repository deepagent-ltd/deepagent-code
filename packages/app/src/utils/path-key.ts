export type PathKey = string & { _brand: "PathKey" }

const isDrive = (value: string) => {
  if (value.length !== 2) return false
  const code = value.charCodeAt(0)
  return value[1] === ":" && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))
}

const trimTrailingSlashes = (value: string) => {
  for (let i = value.length - 1; i >= 0; i--) {
    if (value[i] !== "/") return value.slice(0, i + 1)
  }
  return ""
}

const isWindowsPath = (value: string) => value[1] === ":" || value.startsWith("\\\\")

export const pathKey = (path: string) => {
  // Malformed session payloads can arrive without a directory; a crash here takes down the
  // whole layout via the error boundary, so degrade to a neutral key instead.
  if (!path) return "" as PathKey
  const value = isWindowsPath(path) ? path.replaceAll("\\", "/") : path
  const trimmed = trimTrailingSlashes(value)
  if (!trimmed && value.startsWith("/")) return "/" as PathKey
  if (isDrive(trimmed)) return `${trimmed}/` as PathKey
  return trimmed as PathKey
}
