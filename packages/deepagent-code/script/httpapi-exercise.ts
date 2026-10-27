import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// The root composition materializes its process-cwd tool/index instance. Give
// that instance an owned workspace instead of indexing this source checkout.
const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-httpapi-root-")))
try {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      fileURLToPath(new URL("../test/server/httpapi-exercise/main.ts", import.meta.url)),
      ...Bun.argv.slice(2),
    ],
    { cwd: directory, env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  )
  const interrupt = () => child.kill("SIGINT")
  const terminate = () => child.kill("SIGTERM")
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", terminate)
  try {
    process.exitCode = await child.exited
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
  }
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}
