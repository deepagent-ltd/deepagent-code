import os from "os"
import path from "path"
import fs from "fs/promises"

// Seed the ripgrep binary into a test home's cache so search-backed tools (grep/glob/shell/skill,
// and the tool-registry construction that eagerly resolves `rg`) never trigger the ~50s GitHub
// download that otherwise blows past every per-test timeout and makes those tests appear to hang.
//
// The tool resolves `rg` from `<home>/.deepagent/code/cache/bin` (see core global-path.ts:
// resolveDataPath → DEEPAGENT_CODE_TEST_HOME/.deepagent/code, then Global.Path.bin = <data>/cache/bin).
// Any test that repoints DEEPAGENT_CODE_TEST_HOME to a fresh dir must re-seed, or its rg resolution
// falls through to the network download. This helper is idempotent and best-effort: if no local `rg`
// is available (clean CI image with no ripgrep anywhere), it does nothing and the tool keeps its own
// download fallback — behavior is unchanged, just not pre-seeded.

let cachedSource: string | null | undefined

const rgName = () => (process.platform === "win32" ? "rg.exe" : "rg")

const isFile = (p: string) =>
  fs
    .stat(p)
    .then((s) => s.isFile())
    .catch(() => false)

// Locate a reusable `rg` binary: first a real one on PATH (shell-function shims are not files and are
// skipped), then the developer's real-home cache where a prior non-test run already downloaded it.
const findLocalRg = async (): Promise<string | null> => {
  if (cachedSource !== undefined) return cachedSource
  const name = rgName()
  for (const base of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!base) continue
    const candidate = path.join(base, name)
    if (await isFile(candidate)) return (cachedSource = candidate)
  }
  const realHomeRg = path.join(os.homedir(), ".deepagent", "code", "cache", "bin", name)
  if (await isFile(realHomeRg)) return (cachedSource = realHomeRg)
  return (cachedSource = null)
}

/**
 * Copy a local `rg` into `<homeDir>/.deepagent/code/cache/bin`. Idempotent (no-op if already seeded),
 * best-effort (no throw). Call from preload for the default test home, and from any test that
 * repoints DEEPAGENT_CODE_TEST_HOME to a fresh directory.
 */
export const seedRipgrep = async (homeDir: string): Promise<void> => {
  const name = rgName()
  const binDir = path.join(homeDir, ".deepagent", "code", "cache", "bin")
  const target = path.join(binDir, name)
  if (await isFile(target)) return
  const source = await findLocalRg()
  if (!source) return
  await fs.mkdir(binDir, { recursive: true }).catch(() => undefined)
  await fs.copyFile(source, target).catch(() => undefined)
  if (process.platform !== "win32") await fs.chmod(target, 0o755).catch(() => undefined)
}
