import { mkdtempSync, readdirSync, rmSync, statSync } from "fs"
import { afterAll } from "bun:test"
import fs from "fs/promises"
import { tmpdir as osTmpdir } from "os"
import path from "path"

// Reclaim scratch roots left by earlier runs as soon as a worker starts. The window protects a run
// that is still going: an active root is written continuously (its mtime tracks the run), while a
// finished run's newest root is already thirty minutes old.
sweepStaleRoots("deepagent-code-core-test-")

export const tmpdir = async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(osTmpdir(), "deepagent-code-core-test-")))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await remove(dir)
    },
  }
}

/**
 * Scratch directories for suites that need a path before they can `await`.
 *
 * Tests here mostly build fixtures with `mkdtempSync(path.join(tmpdir(), "..."))`, which has no
 * disposal hook. `mkdtemp` gives every one of those a distinct name, so nothing ever reused or
 * reclaimed them: this machine accumulated 17k stale scratch directories (35 GB), and the debris is
 * itself load. Call these in place of the `tmpdir()` + `mkdtempSync` pair — the old
 * `mkdtempSync(path.join(tmpdir(), "plan-gate-"))` becomes `mkdtempSync(tmpRoot())`.
 *
 * Which one to use depends on WHEN the directory is created, because one scratch root serves the
 * whole file and `afterAll` runs at the end of each file:
 *
 *   * inside a test          -> `tmpRoot()` / `tmpRootAsync()`: this file's `afterAll` deletes it.
 *   * `beforeAll`/module top -> `tmpRootShared()` / `tmpRootSharedAsync()`: the directory is still in
 *     use when the last test ends, so deleting it there removes a live fixture — measured as
 *     knowledge-retriever-v3 failing four tests against its own missing directory. A shared root
 *     lives until process exit and is reclaimed by the next run's startup sweep.
 */
let sessionRoot: string | undefined
let sessionRootShared = false
let ownedRoot = false

/** Scratch directory under a root the file's `afterAll` may delete; for directories made in a test. */
export function tmpRoot(): string {
  return mkdtempSync(path.join(scratchRoot(false), "t-"))
}

/** Async twin of {@link tmpRoot} for call sites that already `await`. */
export async function tmpRootAsync(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(scratchRoot(false), "t-")))
}

/** Scratch directory under a root that survives to process exit; for `beforeAll`/module-scope fixtures. */
export function tmpRootShared(): string {
  return mkdtempSync(path.join(scratchRoot(true), "t-"))
}

/** Async twin of {@link tmpRootShared}. */
export async function tmpRootSharedAsync(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(scratchRoot(true), "t-")))
}

function scratchRoot(shared: boolean): string {
  if (!sessionRoot || (shared && !sessionRootShared)) {
    // A file whose fixture moved from a test into `beforeAll` needs a second root; the first one is
    // still owned by an `afterAll` that must not delete the new one, so hand deletion to the sweep.
    if (sessionRoot) ownedRoot = true
    sessionRoot = mkdtempSync(path.join(osTmpdir(), "deepagent-code-core-test-"))
    sessionRootShared = shared
    if (shared) sweepAbandonedRoots()
    if (!shared)
      afterAll(() => {
        if (ownedRoot) return
        const dir = sessionRoot
        sessionRoot = undefined
        if (dir) rmSync(dir, { recursive: true, force: true })
      })
  }
  return sessionRoot
}

/**
 * Remove scratch roots that no live run owns: those whose owner died before its `afterAll` (a killed
 * or timed-out suite) and the shared roots, which by design live until process exit. `staleMs` must
 * exceed the longest a live root can go unwritten; the default is used at worker startup, and
 * `tmpRootShared` sweeps with a much wider window so it cannot touch a concurrent run at all.
 */
function sweepStaleRoots(prefix: string, staleMs = 30 * 60 * 1000): void {
  const cutoff = Date.now() - staleMs
  for (const entry of readdirSync(osTmpdir())) {
    if (!entry.startsWith(prefix)) continue
    const dir = path.join(osTmpdir(), entry)
    try {
      if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a root another worker is removing right now is not an error */
    }
  }
}

function sweepAbandonedRoots(): void {
  sweepStaleRoots("deepagent-code-core-test-", 6 * 60 * 60 * 1000)
}

async function remove(dir: string, retries = 30): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch (error) {
    if (retries === 0 || !error || typeof error !== "object" || !("code" in error) || error.code !== "EBUSY")
      throw error
    Bun.gc(true)
    await Bun.sleep(100)
    return remove(dir, retries - 1)
  }
}
