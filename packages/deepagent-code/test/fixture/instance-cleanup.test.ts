import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "./fixture"

test("cold instance cleanup does not build a production application root", async () => {
  await using directory = await tmpdir()
  const database = path.join(directory.path, "cold.sqlite")
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--eval",
      `
        const { existsSync } = await import("node:fs")
        const { AppRuntime, builtAppRuntimeRoot } = await import(${JSON.stringify(new URL("../../src/effect/app-runtime.ts", import.meta.url).href)})
        const { disposeAllInstances } = await import(${JSON.stringify(new URL("./fixture.ts", import.meta.url).href)})
        const before = builtAppRuntimeRoot() !== undefined
        try {
          await disposeAllInstances()
          await disposeAllInstances()
          console.log(JSON.stringify({
            before,
            after: builtAppRuntimeRoot() !== undefined,
            databaseCreated: existsSync(process.env.DEEPAGENT_CODE_DB),
            ownerCreated: existsSync(process.env.DEEPAGENT_CODE_DB + ".runtime.lock"),
          }))
        } finally {
          await AppRuntime.dispose()
        }
      `,
    ],
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      ...process.env,
      DEEPAGENT_CODE_TEST_HOME: directory.path,
      DEEPAGENT_CODE_DB: database,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const deadline = setTimeout(() => child.kill("SIGKILL"), 25_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(JSON.parse(stdout)).toEqual({
      before: false,
      after: false,
      databaseCreated: false,
      ownerCreated: false,
    })
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
}, 30_000)
