import { rename, rm, stat } from "node:fs/promises"

export async function preserveBuildOutput(output: string, execute: () => Promise<number>) {
  const backup = `${output}.previous-${process.pid}-${crypto.randomUUID()}`
  const previous = await stat(output)
    .then(() => true)
    .catch(() => false)
  if (previous) await rename(output, backup)

  const result = await execute().then(
    (exitCode) => ({ exitCode }),
    (error: unknown) => ({ exitCode: 1, error }),
  )
  if (result.exitCode === 0) {
    await rm(backup, { recursive: true, force: true })
    return 0
  }

  await rm(output, { recursive: true, force: true })
  if (previous) await rename(backup, output)
  if ("error" in result) throw result.error
  return result.exitCode
}

if (import.meta.main) {
  const run = (args: string[]) =>
    Bun.spawn(args, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).exited
  const exitCode = await preserveBuildOutput("out", async () => {
    const build = await run([process.execPath, "x", "electron-vite", "build"])
    if (build !== 0) return build
    return run([process.execPath, "./scripts/audit-server-bundle.ts"])
  })
  if (exitCode !== 0) process.exit(exitCode)
}
