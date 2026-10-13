import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

test("DAG fixture Git baseline refuses ambient config, hooks and templates", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-native-git-boundary-"))
  try {
    const project = path.join(directory, "project")
    const hooks = path.join(directory, "ambient-hooks")
    const template = path.join(directory, "ambient-template")
    const marker = path.join(directory, "ambient-hook-ran")
    await fs.mkdir(project, { recursive: true })
    await fs.mkdir(hooks, { recursive: true })
    await fs.mkdir(path.join(template, "hooks"), { recursive: true })
    await fs.mkdir(path.join(directory, "ambient-home"), { recursive: true })
    await fs.writeFile(path.join(project, "guard.test.ts"), "export const guard = true;\n")
    await fs.writeFile(path.join(directory, "ambient.gitconfig"),
      `[core]\n hooksPath = ${hooks}\n[init]\n templateDir = ${template}\n[user]\n name = Ambient identity\n email = ambient@example.invalid\n`)
    const hook = `#!/bin/sh\nprintf 'ambient hook ran' > '${marker}'\nexit 1\n`
    await fs.writeFile(path.join(hooks, "pre-commit"), hook, { mode: 0o700 })
    await fs.writeFile(path.join(template, "hooks", "pre-commit"), hook, { mode: 0o700 })
    const runner = path.join(directory, "run.ts")
    await fs.writeFile(runner, `import { EventDagNativeFixture } from ${JSON.stringify(path.join(import.meta.dir, "fixture/event-dag-native-fixture.ts"))};\n` +
      `await EventDagNativeFixture.projectBaseline(${JSON.stringify({ directory, project, env: {
        PATH: process.env.PATH, HOME: path.join(directory, "owned-home"), XDG_CONFIG_HOME: path.join(directory, "owned-config"),
      } })});\n`)
    // The hostile environment exists only in this owned child, never the test runner or user shell.
    const child = Bun.spawn([process.execPath, runner], { stdout: "pipe", stderr: "pipe", env: {
      PATH: process.env.PATH, HOME: path.join(directory, "ambient-home"),
      GIT_CONFIG_GLOBAL: path.join(directory, "ambient.gitconfig"), GIT_CONFIG_SYSTEM: path.join(directory, "ambient.gitconfig"),
      GIT_TEMPLATE_DIR: template, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks,
    } })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(await Bun.file(path.join(project, ".git/hooks/pre-commit")).exists()).toBe(false)
    const actual = Bun.spawnSync(["git", "log", "-1", "--format=%an <%ae>"], { cwd: project, env: {
      PATH: process.env.PATH, HOME: path.join(directory, "owned-home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    }, stdout: "pipe", stderr: "pipe" })
    expect(actual.exitCode).toBe(0)
    expect(actual.stdout.toString().trim()).toBe("Native fixture <native-fixture@example.invalid>")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 15_000)
