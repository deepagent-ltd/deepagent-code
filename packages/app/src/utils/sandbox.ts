import { uuid } from "@/utils/uuid"

// Appendix C / 形态二 (form 2): folder-less new chat.
//
// A folder-less chat still needs a real, concrete working directory: the server
// boots an instance for a path, and every cwd tool (bash/read/edit/pty/file tree)
// depends on it. Instead of exposing the user's home — or, worse, the filesystem
// root "/" — we bind the chat to a dedicated *sandbox* directory under the server's
// app-data dir. That directory becomes the instance `directory`, so the permission
// boundary (containsPath in the server's instance-context.ts) confines file tools
// to the sandbox. See the module doc in sandbox.test.ts and Appendix C §权限边界.
//
// IMPORTANT: never root a folder-less chat at "/". A non-git dir resolves to the
// "global" project whose worktree is the "/" sentinel; the server intentionally
// skips the worktree boundary for that sentinel and falls back to the instance
// `directory`. Rooting the instance `directory` at "/" would therefore make the
// whole filesystem readable/writable. Rooting it at the sandbox keeps the boundary.

/** Directory name that holds all folder-less-chat sandboxes, under the data dir. */
export const SANDBOX_SUBDIR = "workspaces"

const isWindowsPath = (value: string) => value[1] === ":" || value.startsWith("\\\\")

/** Join server-side path segments using the separator implied by `base`. */
function joinServerPath(base: string, ...segments: string[]) {
  const windows = isWindowsPath(base)
  const sep = windows ? "\\" : "/"
  const trimmed = base.replace(/[\\/]+$/, "")
  return [trimmed, ...segments].join(sep)
}

/**
 * Resolve the sandbox directory for a folder-less chat.
 *
 * @param dataDir the server's app-data directory (`sync.data.path.data`).
 * @param id      an opaque per-sandbox id; defaults to a fresh uuid.
 *
 * Returns `<dataDir>/workspaces/<id>`. Throws if `dataDir` is empty (path data
 * not loaded yet) so callers never accidentally compose a root-level "/workspaces".
 */
export function sandboxDir(dataDir: string, id: string = uuid()): string {
  const base = dataDir.trim()
  if (!base) throw new Error("cannot resolve a folder-less sandbox: server data dir is unavailable")
  return joinServerPath(base, SANDBOX_SUBDIR, id)
}

/** True when a directory is a folder-less sandbox under the given data dir. */
export function isSandboxDir(dataDir: string, dir: string): boolean {
  if (!dataDir.trim()) return false
  const prefix = joinServerPath(dataDir, SANDBOX_SUBDIR)
  const norm = (p: string) => (isWindowsPath(p) ? p.replaceAll("\\", "/") : p).replace(/\/+$/, "").toLowerCase()
  const target = norm(dir)
  const root = norm(prefix)
  return target.startsWith(`${root}/`)
}
