import { checksum } from "@deepagent-code/core/util/encode"
import { isSandboxDir, sandboxDir } from "@/utils/sandbox"

export function isFilesystemRootDir(dir: string): boolean {
  const normalized = dir.trim().replaceAll("\\", "/")
  if (!normalized) return false
  const trimmed = normalized.replace(/\/+$/, "")
  if (!trimmed) return true
  if (/^[A-Za-z]:$/.test(trimmed)) return true
  if (!normalized.startsWith("//")) return false
  return trimmed.slice(2).split("/").filter(Boolean).length <= 2
}

type RecoverableSession = {
  id: string
  parentID?: string
  directory: string
}

export async function recoverFilesystemRootRoute(input: {
  dataDir: string
  sessionID?: string
  getSession: (sessionID: string) => Promise<RecoverableSession | undefined>
  mkdir: (directory: string) => Promise<void>
  moveSession: (sessionID: string, directory: string) => Promise<void>
}) {
  const current = input.sessionID ? await input.getSession(input.sessionID) : undefined
  if (current && !isFilesystemRootDir(current.directory)) {
    return { directory: current.directory, sessionID: current.id }
  }

  const visited = new Set<string>()
  let root = current
  let existingSandbox: string | undefined
  while (root?.parentID && !visited.has(root.parentID)) {
    visited.add(root.id)
    const parent = await input.getSession(root.parentID)
    if (!parent) break
    if (!isFilesystemRootDir(parent.directory) && isSandboxDir(input.dataDir, parent.directory)) {
      existingSandbox = parent.directory
      break
    }
    root = parent
  }

  const directory =
    existingSandbox ??
    sandboxDir(
      input.dataDir,
      root ? `recovered-${checksum(root.id) ?? root.id.replace(/[^A-Za-z0-9_-]/g, "-")}` : undefined,
    )
  await input.mkdir(directory)
  if (current) await input.moveSession(current.id, directory)
  return { directory, sessionID: current?.id }
}
