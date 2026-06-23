import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"

// V3.2.1 P2-G: durable knowledge/state writes must not be corruptible by a crash mid-write. The
// stores here all use read-whole-file -> mutate -> rewrite, so a partial write would truncate the
// entire body (e.g. setApprovalStatus rewriting memories.jsonl). writeFileAtomic writes to a temp
// file in the SAME directory (so rename is atomic on the same filesystem) and renames into place;
// renameSync is atomic on POSIX and Windows. On any failure the temp file is removed and the error
// propagates (never swallow a lost durable write). This mirrors the temp+rename pattern already
// used by workspace.ts createProjectAtomically.
export const writeFileAtomic = (file: string, content: string): void => {
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`)
  try {
    writeFileSync(tmp, content, "utf-8")
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}
