#!/usr/bin/env bun

import os from "node:os"
import path from "node:path"

const result = Bun.spawnSync(["bun", "test", "--timeout", "600000", "test/cli/serve/live-context-authority.test.ts"], {
  cwd: new URL("../..", import.meta.url).pathname,
  env: {
    ...process.env,
    DEEPAGENT_CODE_LIVE_CONTEXT_AUTHORITY: "1",
    DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE:
      process.env.DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE?.trim() ||
      path.join(os.homedir(), ".deepagent", "code", "tmp", "live-llm-deepseek.key"),
  },
  stdout: "inherit",
  stderr: "inherit",
})

process.exit(result.exitCode)
