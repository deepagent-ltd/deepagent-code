export * as LockKeys from "./lock-keys"

import path from "node:path"

/** The process-local file lock and durable execution claim must identify the same file. */
export const fileLockKey = (directory: string, file: string) => path.resolve(directory, file)

export const claimFileResource = (key: string) => `file:${key}`

/** A directory-wide claim overlaps its descendants; two sibling file paths remain independent. */
export const filePathsOverlap = (left: string, right: string): boolean => {
  if (left === right) return true
  if (!path.isAbsolute(left) || !path.isAbsolute(right)) return false
  const relative = path.relative(left, right)
  if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return true
  // Windows root-only and UNC paths can resolve asymmetrically through the current drive.
  if (path.sep !== "\\" || (left[1] === ":" && right[1] === ":" && left[0].toLowerCase() === right[0].toLowerCase()))
    return relative.split(path.sep).every((part) => part === "..")
  const reverse = path.relative(right, left)
  return reverse !== "" && reverse !== ".." && !reverse.startsWith(`..${path.sep}`) && !path.isAbsolute(reverse)
}

/** Code-graph symbols are already qualified by repo-relative file and symbol path. */
export const claimSymbolResource = (workspaceID: string, symbol: string) => `symbol:${workspaceID}#${symbol}`
