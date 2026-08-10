#!/usr/bin/env bun

import path from "node:path"

const packageRoot = path.resolve(import.meta.dirname, "..")
const name = process.platform === "win32" ? "windows" : process.platform
const binary = path.join(
  packageRoot,
  "dist",
  `deepagent-code-${name}-${process.arch}`,
  "bin",
  `deepagent-code${process.platform === "win32" ? ".exe" : ""}`,
)
if (!(await Bun.file(binary).exists())) {
  throw new Error(
    `packaged binary is missing: ${binary}; run bun run build --single --skip-install --skip-embed-web-ui`,
  )
}

const result = Bun.spawnSync(["bun", "test", "--timeout", "120000", "test/cli/serve/packaged-fork.test.ts"], {
  cwd: packageRoot,
  env: { ...process.env, DEEPAGENT_CODE_TEST_BINARY: binary },
  stdout: "inherit",
  stderr: "inherit",
})
process.exit(result.exitCode)
