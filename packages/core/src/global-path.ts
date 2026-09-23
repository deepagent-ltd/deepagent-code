import path from "path"
import os from "os"

// The single pure computation of DeepAgent's private storage roots. POSIX production resolves to
// the unified ~/.deepagent/code. Windows production splits by D-W1: user config and credentials
// roam with the domain account (%APPDATA%\deepagent-code), while data, caches, worktrees and
// snapshots stay machine-local (%LOCALAPPDATA%\deepagent-code).
//
// Test/desktop boundary: when DEEPAGENT_CODE_TEST_HOME is present the layout stays unified
// (<home>/.deepagent/code) on every platform — an isolated test home emulates a POSIX-style home
// and must never touch the real APPDATA/LOCALAPPDATA directories. An exact data-root override is
// honored only when that boundary is present, so DEEPAGENT_CODE_HOME cannot redirect production
// writes.
export const resolveHomeBase = (env: NodeJS.ProcessEnv = process.env): string =>
  env.DEEPAGENT_CODE_TEST_HOME ?? os.homedir()

// The pre-split unified root (pre-2.0.1 previews and the WSL era). Kept for the one-time win32
// migration in global-migrate.ts; new code must go through platformDataHome/platformConfigHome.
export const legacyDataHome = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(resolveHomeBase(env), ".deepagent", "code")

const override = (env: NodeJS.ProcessEnv): string | undefined =>
  env.DEEPAGENT_CODE_TEST_HOME && env.DEEPAGENT_CODE_HOME ? path.resolve(env.DEEPAGENT_CODE_HOME) : undefined

export const platformDataHome = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string => {
  const exact = override(env)
  if (exact) return exact
  if (platform !== "win32" || env.DEEPAGENT_CODE_TEST_HOME) return legacyDataHome(env)
  // path.win32 keeps injected-platform probes canonical; at runtime this branch only runs on win32.
  return path.win32.join(env.LOCALAPPDATA ?? path.win32.join(resolveHomeBase(env), "AppData", "Local"), "deepagent-code")
}

export const platformConfigHome = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string => {
  const exact = override(env)
  if (exact) return exact
  if (platform !== "win32" || env.DEEPAGENT_CODE_TEST_HOME) return platformDataHome(env, platform)
  return path.win32.join(env.APPDATA ?? path.win32.join(resolveHomeBase(env), "AppData", "Roaming"), "deepagent-code")
}

export const resolveDataPath = (env: NodeJS.ProcessEnv = process.env): string => path.resolve(platformDataHome(env))

export const resolveConfigPath = (env: NodeJS.ProcessEnv = process.env): string =>
  path.resolve(platformConfigHome(env))

export const containsDataPath = (candidate: string, env: NodeJS.ProcessEnv = process.env): boolean => {
  const root = resolveDataPath(env)
  const relative = path.relative(root, path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}
