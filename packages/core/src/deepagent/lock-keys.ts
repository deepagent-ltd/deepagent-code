export * as LockKeys from "./lock-keys"

import path from "node:path"

/** The process-local file lock and durable execution claim must identify the same file. */
export const fileLockKey = (directory: string, file: string) => path.resolve(directory, file)

export const claimFileResource = (key: string) => `file:${key}`

/** Code-graph symbols are already qualified by repo-relative file and symbol path. */
export const claimSymbolResource = (workspaceID: string, symbol: string) => `symbol:${workspaceID}#${symbol}`
