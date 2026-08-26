import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

export interface DirEntry {
  path: string
  isDirectory: boolean
  isFile: boolean
}

/** Non-recursive directory listing with stat info (one level deep). */
export function readdirSyncStat(dir: string): DirEntry[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: DirEntry[] = []
  for (const name of names) {
    const p = join(dir, name)
    try {
      const s = statSync(p)
      out.push({ path: p, isDirectory: s.isDirectory(), isFile: s.isFile() })
    } catch {
      /* ignore entries we can't stat */
    }
  }
  return out
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
