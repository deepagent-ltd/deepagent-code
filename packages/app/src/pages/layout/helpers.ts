import { getFilename } from "@deepagent-code/core/util/path"
import { type Session } from "@deepagent-code/sdk/v2/client"
import { pathKey } from "@/utils/path-key"
import type { ServerConnection } from "@/context/server"

type SessionStore = {
  session?: Session[]
  path: { directory: string }
}

function sortSessions(now: number) {
  const oneMinuteAgo = now - 60 * 1000
  return (a: Session, b: Session) => {
    const aUpdated = a.time.updated ?? a.time.created
    const bUpdated = b.time.updated ?? b.time.created
    const aRecent = aUpdated > oneMinuteAgo
    const bRecent = bUpdated > oneMinuteAgo
    if (aRecent && bRecent) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    if (aRecent && !bRecent) return -1
    if (!aRecent && bRecent) return 1
    return bUpdated - aUpdated
  }
}

// A root row has no origin link of EITHER kind — neither a subagent `parentID` nor a fork
// `metadata.forkedFrom`. Excluding fork origins here is what stops a fork from appearing both as a
// top-level row AND nested under its parent (forks carry no parentID, so the old `!parentID` check
// alone would double-list them).
const isRootVisibleSession = (session: Session, directory: string) =>
  pathKey(session.directory) === pathKey(directory) && !sessionOriginID(session) && !session.time?.archived

export const roots = (store: SessionStore) =>
  (store.session ?? []).filter((session) => isRootVisibleSession(session, store.path.directory))

export const sortedRootSessions = (store: SessionStore, now: number) => roots(store).sort(sortSessions(now))

export const latestRootSession = (stores: SessionStore[], now: number) =>
  stores.flatMap(roots).sort(sortSessions(now))[0]

export function hasProjectPermissions<T>(
  request: Record<string, T[] | undefined> | undefined,
  include: (item: T) => boolean = () => true,
) {
  return Object.values(request ?? {}).some((list) => list?.some(include))
}

export const childSessionOnPath = (sessions: Session[] | undefined, rootID: string, activeID?: string) => {
  if (!activeID || activeID === rootID) return
  const map = new Map((sessions ?? []).map((session) => [session.id, session]))
  let id = activeID

  while (id) {
    const session = map.get(id)
    if (!session?.parentID) return
    if (session.parentID === rootID) return session
    id = session.parentID
  }
}

// The id of the session a child hangs off in the sidebar tree. Two lineage kinds are unified:
//   • subagents — `parentID` (background workers spawned by the task tool)
//   • forks — `metadata.forkedFrom.parentSessionID` (foreground "derived from" sessions; forks
//     deliberately do NOT set parentID, which would give them subagent semantics)
// Roots (`roots()` above) are sessions with neither link, so a fork/subagent never also shows as a
// top-level row.
export const sessionOriginID = (session: Session): string | undefined => {
  if (session.parentID) return session.parentID
  const forkedFrom = (session.metadata as { forkedFrom?: { parentSessionID?: string } } | undefined)?.forkedFrom
  return forkedFrom?.parentSessionID
}

// Direct children (subagents + forks) of a session, newest first. Used to nest sessions folder-style
// under their origin in the sidebar.
export const directChildSessions = (sessions: Session[] | undefined, originID: string): Session[] =>
  (sessions ?? [])
    .filter((s) => !s.time?.archived && sessionOriginID(s) === originID)
    .sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0))

// Max nesting depth mirrored from the backend fork cap (root → fork → fork-of-fork = 3 levels, i.e.
// level indices 0..2). Deeper descendants stop nesting so a corrupted chain can't recurse forever.
export const MAX_SESSION_TREE_LEVEL = 2

export const displayName = (project: { name?: string; worktree: string }) =>
  project.name || getFilename(project.worktree) || project.worktree

export type HomeProjectSelection = { server: ServerConnection.Key; directory?: string }

export function toggleHomeProjectSelection(
  current: HomeProjectSelection | undefined,
  server: ServerConnection.Key,
  directory: string,
): HomeProjectSelection {
  if (current?.server === server && current.directory === directory) return { server }
  return { server, directory }
}

export function closeHomeProject(
  selected: HomeProjectSelection | undefined,
  server: ServerConnection.Key,
  projects: { close: (directory: string) => void },
  directory: string,
) {
  projects.close(directory)
  if (selected?.server === server && selected.directory === directory) return { server }
  return selected
}

export function homeProjectNavigation(active: ServerConnection.Key, server: ServerConnection.Key, href: string) {
  if (active === server) return { href }
  return { server, href }
}

export function homeProjectDirectories(result: string | string[] | null) {
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}

export function homeSessionServerStatus(active: boolean, status: () => { working: boolean; tint?: string }) {
  if (!active) return { working: false, tint: undefined }
  return status()
}

const DEEPAGENT_CODE_PROJECT_ID = "4b0ea68d7af9a6031a7ffda7ad66e0cb83315750"

export function getProjectAvatarSource(id?: string, icon?: { color?: string; url?: string; override?: string }) {
  if (id === DEEPAGENT_CODE_PROJECT_ID) return "https://deepagent-code.ai/favicon.svg"
  if (icon?.override) return icon.override
  if (icon?.color) return undefined
  return icon?.url
}

export function projectForSession<T extends { id?: string; worktree: string; sandboxes?: string[] }>(
  session: Session,
  projects: T[],
  byID: Map<string, T> = new Map(projects.flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
) {
  const direct = byID.get(session.projectID)
  if (direct) return direct
  const directory = pathKey(session.directory)
  return projects.find(
    (project) =>
      pathKey(project.worktree) === directory || project.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
  )
}

export const errorMessage = (err: unknown, fallback: string) => {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (err instanceof Error) return err.message
  return fallback
}

export const effectiveWorkspaceOrder = (local: string, dirs: string[], persisted?: string[]) => {
  const root = pathKey(local)
  const live = new Map<string, string>()

  for (const dir of dirs) {
    const key = pathKey(dir)
    if (key === root) continue
    if (!live.has(key)) live.set(key, dir)
  }

  if (!persisted?.length) return [local, ...live.values()]

  const result = [local]
  for (const dir of persisted) {
    const key = pathKey(dir)
    if (key === root) continue
    const match = live.get(key)
    if (!match) continue
    result.push(match)
    live.delete(key)
  }

  return [...result, ...live.values()]
}
