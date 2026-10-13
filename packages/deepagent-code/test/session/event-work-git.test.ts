import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"
import { Effect } from "effect"
import { EventWorkGit } from "../../src/session/event-work-git"

test("formal raw Git does not execute hooks or filters and refuses external merge variants", async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-event-git-")))
  const directory = path.join(base, "project")
  await fs.mkdir(directory)
  const prepare = (args: string[], input?: string) => {
    const result = spawnSync("git", args, { cwd: directory, input, encoding: "utf8", timeout: 10_000 })
    if (result.status !== 0) throw new Error("GIT_FIXTURE_PREPARE_FAILED")
    return result.stdout.trim()
  }
  const run = (cwd: string, args: string[], stdin?: Buffer, blob?: boolean) => Effect.runPromise(EventWorkGit.run({ directory: cwd, args, stdin, blob }))
  try {
    prepare(["init", "--quiet"])
    const hooks = path.join(base, "hooks")
    await fs.mkdir(hooks)
    await fs.writeFile(path.join(hooks, "post-checkout"), `#!/bin/sh\nprintf hook > '${path.join(base, "hook-ran")}'\n`, { mode: 0o700 })
    prepare(["config", "core.hooksPath", hooks])
    prepare(["config", "filter.unsafe.smudge", `printf filter > '${path.join(base, "filter-ran")}'`])
    prepare(["config", "filter.unsafe.clean", `printf filter > '${path.join(base, "filter-ran")}'`])
    prepare(["config", "filter.unsafe.required", "true"])
    prepare(["config", "merge.unsafe.driver", `printf merge > '${path.join(base, "merge-ran")}'`])
    const attributes = prepare(["hash-object", "-w", "--stdin"], "*.txt filter=unsafe merge=unsafe\n")
    const body = Buffer.from("exact raw UTF8 🌟\0body\n")
    const object = (await run(directory, ["hash-object", "-w", "--stdin"], body)).stdout.toString().trim()
    prepare(["update-index", "--add", "--cacheinfo", `100644,${attributes},.gitattributes`])
    prepare(["update-index", "--add", "--cacheinfo", `100644,${object},file.txt`])
    const tree = prepare(["write-tree"])
    const commit = prepare(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", tree, "-m", "fixture"])
    prepare(["update-ref", "HEAD", commit])
    const target = path.join(base, "child")
    const branch = "deepagent-code/event-0123456789abcdef01234567"
    const added = await run(directory, ["worktree", "add", "-b", branch, target, commit])
    expect(added.exitCode).toBe(0)
    expect(await fs.readdir(target)).toEqual([".git"])
    const list = await run(target, ["ls-tree", "-rz", "--full-tree", commit])
    expect(list.exitCode).toBe(0)
    expect(list.stdout.toString()).toContain("file.txt\0")
    const raw = await run(target, ["cat-file", "blob", object], undefined, true)
    expect(raw.stdout).toEqual(body)
    expect(raw.exitCode).toBe(0)
    expect((await run(directory, ["merge-base", "--is-ancestor", commit, commit])).exitCode).toBe(0)
    expect((await run(directory, ["worktree", "list", "--porcelain"])).stdout.toString()).toContain(target)
    expect(await Effect.runPromise(EventWorkGit.run({ directory, args: ["cat-file", "--filters", object] }).pipe(Effect.exit))).toMatchObject({ _tag: "Failure" })
    expect(await Effect.runPromise(EventWorkGit.run({ directory, args: ["merge-tree", "--write-tree", commit, commit] }).pipe(Effect.exit))).toMatchObject({ _tag: "Failure" })
    expect(await Effect.runPromise(EventWorkGit.run({ directory, args: ["checkout", "HEAD"] }).pipe(Effect.exit))).toMatchObject({ _tag: "Failure" })
    expect(await fs.readdir(base)).not.toContain("hook-ran")
    expect(await fs.readdir(base)).not.toContain("filter-ran")
    expect(await fs.readdir(base)).not.toContain("merge-ran")
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
}, 30_000)
