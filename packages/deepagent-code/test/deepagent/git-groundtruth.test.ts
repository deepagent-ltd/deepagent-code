import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { gitGroundTruth } from "../../src/deepagent/git-groundtruth"
import { tmpdir } from "../fixture/fixture"

test("git ground truth outside a repository remains empty", async () => {
  await using directory = await tmpdir()
  expect(await gitGroundTruth(directory.path)).toEqual({ changed_files: [], diff_stat: null, repo_root: null })
})

test("unused git stderr cannot block completion of a failing child", async () => {
  await using directory = await tmpdir()
  const bin = path.join(directory.path, "bin")
  const driver = path.join(directory.path, "git-driver.ts")
  const marker = path.join(directory.path, "stderr-flushed")
  await fs.mkdir(bin)
  await Bun.write(driver, `import { writeFileSync } from "node:fs"\nprocess.stderr.write("x".repeat(1024 * 1024), () => { writeFileSync(${JSON.stringify(marker)}, "flushed"); process.exit(129) })\n`)
  await fs.writeFile(path.join(bin, process.platform === "win32" ? "git.cmd" : "git"), process.platform === "win32"
    ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${process.execPath.replaceAll("%", "%%")}" "${driver.replaceAll("%", "%%")}"\r\n`
    : `#!/bin/sh\nexec ${[process.execPath, driver].map((value) => "'" + value.replaceAll("'", "'\\''") + "'").join(" ")}\n`, { mode: 0o700 })
  const previous = process.env.PATH
  process.env.PATH = bin + path.delimiter + previous
  try {
    expect(await gitGroundTruth(directory.path)).toEqual({ changed_files: [], diff_stat: null, repo_root: null })
    // The child writes this only after its full stderr flush. A timeout kill is not completion.
    expect(await Bun.file(marker).exists()).toBe(true)
  } finally {
    process.env.PATH = previous
  }
})
