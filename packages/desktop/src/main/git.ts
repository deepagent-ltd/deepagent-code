import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type GitLogEntry = {
  hash: string
  author: string
  date: string
  subject: string
}

export type GitLogResult = { ok: true; entries: GitLogEntry[] } | { ok: false; error: string }

export type GitTrackedResult = { ok: true; tracked: boolean } | { ok: false; error: string }

/** Whether a file is tracked by git in the given working directory. */
export async function isTracked(workDir: string, relPath: string): Promise<GitTrackedResult> {
  try {
    await execFileAsync("git", ["-C", workDir, "ls-files", "--error-unmatch", "--", relPath])
    return { ok: true, tracked: true }
  } catch (error) {
    // Non-zero exit means either not a repo or not tracked. Distinguish from unexpected errors.
    const message = error instanceof Error ? error.message : String(error)
    if (isGitMissingOrNotTracked(message)) return { ok: true, tracked: false }
    return { ok: false, error: message }
  }
}

/** Fetch the commit history for a single file (follows renames). */
export async function fileLog(workDir: string, relPath: string): Promise<GitLogResult> {
  try {
    // \x1f separates fields, \x1e separates records. %ad keeps an ISO-ish date with timezone.
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        workDir,
        "log",
        "--follow",
        "--no-patch",
        "--pretty=format:%H%x1f%an%x1f%ad%x1f%s%x1e",
        "--date=iso",
        "--",
        relPath,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    )

    const entries: GitLogEntry[] = []
    const trimmed = stdout.replace(/\x1e$/, "")
    if (trimmed) {
      for (const record of trimmed.split("\x1e")) {
        const [hash, author, date, subject] = record.split("\x1f")
        if (!hash) continue
        entries.push({ hash, author: author ?? "", date: date ?? "", subject: subject ?? "" })
      }
    }
    return { ok: true, entries }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isGitMissingOrNotTracked(message)) return { ok: true, entries: [] }
    return { ok: false, error: message }
  }
}

function isGitMissingOrNotTracked(message: string): boolean {
  return (
    // `git` binary not installed or not on PATH (e.g. a minimal Windows install). Treat as
    // "not a git repo" so the UI degrades to an empty timeline instead of a hard error.
    message.includes("spawn git ENOENT") ||
    message.includes("not a git repository") ||
    message.includes("did not match any file") ||
    message.includes("fatal: not a git") ||
    message.includes("unknown revision") ||
    message.includes("Not a git repository")
  )
}
