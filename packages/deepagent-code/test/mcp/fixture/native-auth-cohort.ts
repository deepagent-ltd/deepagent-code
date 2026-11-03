import fs from "node:fs/promises"
import path from "node:path"
import { WindowsNativeCliCohort } from "../../fixture/windows-native-cli-cohort"

export async function build(businessEntry: string) {
  if (process.platform !== "win32") return undefined
  const runner = process.env.RUNNER_TEMP
  if (!runner || path.win32.parse(runner).root.toUpperCase() !== "D:\\")
    throw new Error("Native MCP auth tests require D: scratch space")
  await fs.mkdir(runner, { recursive: true })
  return WindowsNativeCliCohort.build({
    directory: await fs.mkdtemp(path.join(runner, "dac-mcp-native-auth-")),
    businessEntry,
  })
}
