import path from "path"
import os from "os"

// V3.2.1 P2-F (single storage-root source): the ONE pure computation of the DeepAgent data root.
// Both core's Global.Path (global.ts) and the control-plane resolver
// (deepagent/workspace.ts:resolveDeepAgentCodeHome) delegate here, so the root can never diverge
// across env combinations again ([storage-root-dual-resolver]). This module is intentionally
// side-effect free (no top-level await / mkdir), so importing it from leaf modules and unit tests
// is safe — unlike global.ts, which performs filesystem migration/creation at load time.
//
// Contract: DEEPAGENT_CODE_HOME wins; otherwise <DEEPAGENT_CODE_TEST_HOME ?? os.homedir()>/
// .deepagent/code. The env is a parameter so tests can resolve against an explicit environment
// without mutating process.env.
export const resolveHomeBase = (env: NodeJS.ProcessEnv = process.env): string =>
  env.DEEPAGENT_CODE_TEST_HOME ?? os.homedir()

export const resolveDataPath = (env: NodeJS.ProcessEnv = process.env): string =>
  path.resolve(env.DEEPAGENT_CODE_HOME ?? path.join(resolveHomeBase(env), ".deepagent", "code"))
