import { join } from "node:path"

export function desktopStoragePaths(dataRoot: string, appID: string) {
  const root = join(dataRoot, "desktop", appID)
  return {
    root,
    session: join(root, "session"),
    cache: join(root, "cache"),
    updater: join(root, "updater"),
    logs: join(root, "logs"),
    tmp: join(root, "tmp"),
    crashDumps: join(root, "Crashpad"),
  }
}
