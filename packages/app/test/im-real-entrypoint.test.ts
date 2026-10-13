import { expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"

const required = ["DAC_GUI_IM_CDP_URL", "DAC_GUI_IM_SOURCE_TEXT", "DAC_GUI_IM_COMMAND", "DAC_GUI_IM_OUTPUT_DIR"]
const supplied = {
  DAC_GUI_IM_CDP_URL: "http://127.0.0.1:9",
  DAC_GUI_IM_SOURCE_TEXT: "Discovery only; no incoming message is created",
  DAC_GUI_IM_COMMAND: "Discovery only; no command is submitted",
  DAC_GUI_IM_OUTPUT_DIR: path.join(os.tmpdir(), "dac-im-entrypoint-discovery"),
}
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !required.includes(name)))
const discover = (env: NodeJS.ProcessEnv) => Bun.spawnSync(
  [process.execPath, "run", "test:e2e:im-real", "--list"],
  { cwd: path.resolve(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe", timeout: 15_000 },
)

test.each(required)("private IM entrypoint rejects missing %s before discovery", (name) => {
  const result = discover({ ...environment, ...supplied, [name]: "" })
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString() + result.stdout.toString()).toContain(`Private IM /dac acceptance requires: ${name}`)
})

test("private IM entrypoint discovers the current /dac chain without connecting or submitting", () => {
  const result = discover({ ...environment, ...supplied })
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain("im-dac-real-chain.spec.ts")
  expect(result.stdout.toString()).toContain("Total: 1 test in 1 file")
  expect(result.stdout.toString()).not.toContain("im-task-real-chain.spec.ts")
})
