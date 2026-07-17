import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"

// V3.2.1 P2-G: durable knowledge/state writes must not be corruptible by a crash mid-write. The
// stores here all use read-whole-file -> mutate -> rewrite, so a partial write would truncate the
// entire body (e.g. setApprovalStatus rewriting memories.jsonl). writeFileAtomic writes to a temp
// file in the SAME directory (so rename is atomic on the same filesystem) and renames into place;
// renameSync is atomic on POSIX and Windows. On any failure the temp file is removed and the error
// propagates (never swallow a lost durable write). This mirrors the temp+rename pattern already
// used by workspace.ts createProjectAtomically.
//
// F30-1 (deepagentcore-v4.0.3 storage prereq): the temp file is now fsync'd BEFORE the rename so a
// crash between write and rename can never expose a torn body, and the containing directory is
// fsync'd AFTER the rename (best-effort) so the rename itself is durable across a power loss. This
// makes writeFileAtomic the single crash-safe overwrite primitive the DocumentStore relies on.
export const writeFileAtomic = (file: string, content: string): void => {
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`)
  let fd: number | undefined
  try {
    fd = openSync(tmp, "w")
    writeSync(fd, content, null, "utf-8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, file)
    fsyncDir(dir)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* fd already invalid — nothing to salvage */
      }
    }
    rmSync(tmp, { force: true })
    throw error
  }
}

// F30-1: crash-safe EXCLUSIVE create — the CAS write primitive for append-only version files.
// `openSync(file, "wx")` fails with EEXIST if the target already exists, giving an atomic
// compare-and-swap on the filesystem: two processes racing to write the same `id@vN.json` version
// file, one wins and the other observes EEXIST (the caller turns that into a conflict). The body is
// fsync'd before close so a crash can't leave a half-written version file. Throws the raw Node error
// (code "EEXIST" on collision) — the DocumentStore inspects `.code` to decide idempotent-vs-conflict.
export const writeFileExclusive = (file: string, content: string): void => {
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  let fd: number | undefined
  try {
    fd = openSync(file, "wx")
    writeSync(fd, content, null, "utf-8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    fsyncDir(dir)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* fd already invalid */
      }
    }
    throw error
  }
}

// Best-effort directory fsync so a rename/create is durable. Not all platforms/filesystems permit
// opening a directory for fsync (Windows throws EPERM/EISDIR, some FUSE mounts reject it); a failure
// here does not compromise the file body (already fsync'd) so it is intentionally swallowed.
const fsyncDir = (dir: string): void => {
  let dfd: number | undefined
  try {
    dfd = openSync(dir, "r")
    fsyncSync(dfd)
  } catch {
    /* directory fsync unsupported on this platform — file body is already durable */
  } finally {
    if (dfd !== undefined) {
      try {
        closeSync(dfd)
      } catch {
        /* ignore */
      }
    }
  }
}
