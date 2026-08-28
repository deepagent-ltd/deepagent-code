import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { prepareToolSandbox } from "./sandbox"

const testRoot = await mkdtemp(path.join(os.tmpdir(), "deepagent-code-sandbox-conformance-"))
try {
  const workspace = path.join(testRoot, "workspace")
  await mkdir(workspace, { recursive: true })
  const marker = `python-verifier-${crypto.randomUUID()}`
  const sandbox = await prepareToolSandbox({
    workspace,
    testRoot,
    verifierScript: [
      "#!/bin/sh",
      "set -eu",
      '"$DEEPAGENT_LIVE_LLM_PYTHON" -B - <<\'PY\'',
      `print(${JSON.stringify(marker)})`,
      "PY",
      "",
    ].join("\n"),
  })
  const process = Bun.spawn([sandbox.shell, "-c", "./verify"], { cwd: workspace, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0 || !stdout.includes(marker)) {
    throw new Error(`tool-bash-sandbox: Python verifier failed (${exitCode}): ${stderr.trim()}`)
  }
  console.log(
    `tool-bash-sandbox: passed (${sandbox.evidence.platform}, ${sandbox.evidence.profileHash}, python=${sandbox.evidence.pythonRuntimeAvailable})`,
  )
} finally {
  await rm(testRoot, { recursive: true, force: true })
}
