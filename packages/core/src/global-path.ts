import path from "path"
import os from "os"

// The single pure computation of DeepAgent's private storage root. Production always resolves to
// ~/.deepagent/code. Tests may supply an isolated home; an exact data-root override is honored only
// when that test boundary is present, so DEEPAGENT_CODE_HOME cannot redirect production writes.
export const resolveHomeBase = (env: NodeJS.ProcessEnv = process.env): string =>
  env.DEEPAGENT_CODE_TEST_HOME ?? os.homedir()

export const resolveDataPath = (env: NodeJS.ProcessEnv = process.env): string =>
  path.resolve(
    env.DEEPAGENT_CODE_TEST_HOME && env.DEEPAGENT_CODE_HOME
      ? env.DEEPAGENT_CODE_HOME
      : path.join(resolveHomeBase(env), ".deepagent", "code"),
  )

export const containsDataPath = (candidate: string, env: NodeJS.ProcessEnv = process.env): boolean => {
  const root = resolveDataPath(env)
  const relative = path.relative(root, path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}
