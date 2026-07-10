import { base64Encode } from "@deepagent-code/core/util/encode"

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  return `${base64Encode(directory)}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(directory)}/*`
}

// Directory-scoped read-only state reuses the same directory key space as auto-accept
// (the two are mutually exclusive per directory).
export function isDirectoryReadOnly(readOnly: Record<string, boolean>, directory: string) {
  const key = directoryAcceptKey(directory)
  return readOnly[key] ?? false
}

// Tools that write, execute, or otherwise mutate state — denied in read-only mode.
// Everything else (read/glob/grep/list/lsp/webfetch/websearch/todowrite/…) is left to the
// normal permission flow so the agent can still inspect the workspace.
const MUTATING_PERMISSIONS = new Set(["edit", "write", "patch", "bash", "task", "external_directory"])

export function isMutatingPermission(permission: string) {
  return MUTATING_PERMISSIONS.has(permission)
}

function accepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  const key = acceptKey(sessionID, directory)
  const directoryKey = directory ? directoryAcceptKey(directory) : undefined
  return autoAccept[key] ?? autoAccept[sessionID] ?? (directoryKey ? autoAccept[directoryKey] : undefined)
}

export function isDirectoryAutoAccepting(autoAccept: Record<string, boolean>, directory: string) {
  const key = directoryAcceptKey(directory)
  return autoAccept[key] ?? false
}

function sessionLineage(session: { id: string; parentID?: string }[], sessionID: string) {
  const parent = session.reduce((acc, item) => {
    if (item.parentID) acc.set(item.id, item.parentID)
    return acc
  }, new Map<string, string>())
  const seen = new Set([sessionID])
  const ids = [sessionID]

  for (const id of ids) {
    const parentID = parent.get(id)
    if (!parentID || seen.has(parentID)) continue
    seen.add(parentID)
    ids.push(parentID)
  }

  return ids
}

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory?: string,
) {
  const value = sessionLineage(session, permission.sessionID)
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is boolean => item !== undefined)
  return value ?? false
}
