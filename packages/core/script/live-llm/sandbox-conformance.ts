import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { prepareToolSandbox } from "./sandbox"

const testRoot = await mkdtemp(path.join(os.tmpdir(), "deepagent-code-sandbox-conformance-"))
try {
  const workspace = path.join(testRoot, "workspace")
  await mkdir(workspace, { recursive: true })
  const sandbox = await prepareToolSandbox({ workspace, testRoot })
  console.log(`tool-bash-sandbox: passed (${sandbox.evidence.platform}, ${sandbox.evidence.profileHash})`)
} finally {
  await rm(testRoot, { recursive: true, force: true })
}
