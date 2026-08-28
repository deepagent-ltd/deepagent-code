import path from "path"
import { LocalContext } from "@/util/local-context"
import { FSUtil } from "@deepagent-code/core/fs-util"
import type * as Project from "./project"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
}

export const context = LocalContext.create<InstanceContext>("instance")

/**
 * Check if a path is within the project boundary.
 * Returns true if path is inside ctx.directory OR ctx.worktree.
 * Paths within the worktree but outside the working directory should not trigger external_directory permission.
 *
 * SECURITY INVARIANT: `ctx.directory` must never be the filesystem root ("/" or a
 * drive root). If it were, the first check below — FSUtil.contains(ctx.directory,
 * filepath) — would match EVERY absolute path, collapsing the permission boundary
 * and making the whole filesystem readable/writable by file tools. That invariant
 * is enforced fail-closed at instance boot via `assertSafeInstanceRoot` (see
 * instance-store.ts); this function assumes it holds.
 *
 * The `worktree === "/"` short-circuit below is NOT a hole: it is deliberate and
 * *tightens* the boundary. Non-git ("global") projects store the worktree sentinel
 * "/". Since FSUtil.contains("/", filepath) matches everything, we must skip the
 * worktree check for that sentinel — otherwise every path would count as "inside
 * the project" and external_directory permission prompts would never fire. Returning
 * false here means "not inside the worktree boundary", which routes the path through
 * the stricter external_directory check. Do NOT change it to return true.
 */
export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  if (FSUtil.contains(ctx.directory, filepath)) return true
  // Non-git projects set worktree to "/" which would match ANY absolute path.
  // Skip worktree check in this case to preserve external_directory permissions.
  if (ctx.worktree === "/") return false
  return FSUtil.contains(ctx.worktree, filepath)
}

/**
 * True when `dir` resolves to a filesystem root (posix "/" or a Windows drive/UNC
 * root like "C:\\"). Rooting an instance's `directory` here would make containsPath
 * match every absolute path — see the SECURITY INVARIANT on containsPath.
 */
export function isFilesystemRoot(dir: string): boolean {
  const trimmed = dir.trim()
  if (!trimmed) return false
  const resolved = FSUtil.resolve(trimmed)
  return path.dirname(resolved) === resolved
}

/**
 * Fail-closed guard for the security invariant that an instance is never rooted at
 * "/". Throws (denying the boot) when `directory` is empty/whitespace or resolves to
 * a filesystem root, rather than silently booting an instance whose boundary is the
 * entire filesystem. This is the hard enforcement point for folder-less-chat
 * sandboxes and every other instance: the caller-supplied route directory is
 * untrusted, so this runs on the server boot path (instance-store.ts).
 */
export function assertSafeInstanceRoot(directory: string): void {
  const trimmed = directory.trim()
  if (!trimmed) {
    throw new Error("refusing to boot an instance: directory is empty")
  }
  if (isFilesystemRoot(directory)) {
    throw new Error(`refusing to boot an instance rooted at the filesystem root: ${JSON.stringify(directory)}`)
  }
}
