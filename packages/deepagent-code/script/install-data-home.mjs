import os from "node:os"
import path from "node:path"

// Node runs postinstall in the published package, where Core's TypeScript source is unavailable.
// Keep this pure resolver aligned with Core's platformDataHome via the cross-package test.
export function installDataHome(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.DEEPAGENT_CODE_TEST_HOME && env.DEEPAGENT_CODE_HOME) return path.resolve(env.DEEPAGENT_CODE_HOME)
  const base = env.DEEPAGENT_CODE_TEST_HOME ?? home
  if (platform !== "win32" || env.DEEPAGENT_CODE_TEST_HOME) return path.join(base, ".deepagent", "code")
  return path.win32.join(env.LOCALAPPDATA ?? path.win32.join(base, "AppData", "Local"), "deepagent-code")
}
