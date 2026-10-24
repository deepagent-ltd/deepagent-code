import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const module = new URL("./assert-release-candidate.ts", import.meta.url).href

for (const scenario of [
  { name: "unstaged tracked", filename: "tracked.txt", status: " M tracked.txt", staged: false },
  { name: "untracked", filename: "untracked-note.txt", status: "?? untracked-note.txt", staged: false },
  { name: "staged tracked", filename: "tracked.txt", status: "M  tracked.txt", staged: true },
]) {
  test(`dirty candidate reports ${scenario.name} status before any remote query without exposing contents`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dac-dirty-candidate-"))
    const repository = path.join(root, "repository")
    const trace = path.join(root, "git-trace.log")
    const environment = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
      GIT_TEMPLATE_DIR: path.join(root, "template"),
      GIT_ALLOW_PROTOCOL: "file",
      GIT_AUTHOR_NAME: "Guard Fixture",
      GIT_AUTHOR_EMAIL: "guard-fixture@example.invalid",
      GIT_COMMITTER_NAME: "Guard Fixture",
      GIT_COMMITTER_EMAIL: "guard-fixture@example.invalid",
    }
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: repository,
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      return result.stdout.toString().trimEnd()
    }
    try {
      await Promise.all(
        [repository, environment.GIT_TEMPLATE_DIR, path.join(root, "hooks")].map((directory) => mkdir(directory)),
      )
      await Bun.write(environment.GIT_CONFIG_GLOBAL, "")
      git("init", "--quiet")
      git("config", "core.hooksPath", path.join(root, "hooks"))
      // Even a broken guard may only attempt a local, nonexistent origin.
      git("remote", "add", "origin", path.join(root, "never-query-origin.git"))
      await Bun.write(path.join(repository, "tracked.txt"), "frozen fixture\n")
      git("add", "tracked.txt")
      git("commit", "--quiet", "-m", "test: freeze guard fixture")
      const candidate = {
        repository,
        commit: git("rev-parse", "HEAD"),
        tree: git("rev-parse", "HEAD^{tree}"),
        tag: "v2.0.5",
        releaseID: "1",
        releaseRepository: "fixture/repository",
        ghCommand: path.join(root, "never-call-gh"),
      }
      const contents = `PRIVATE_DIRTY_${scenario.name.toUpperCase().replaceAll(" ", "_")}_CONTENTS\n`
      await Bun.write(path.join(repository, scenario.filename), contents)
      if (scenario.staged) git("add", scenario.filename)
      expect(git("status", "--porcelain=v1", "--untracked-files=all")).toBe(scenario.status)

      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `
            import { assertReleaseCandidate } from ${JSON.stringify(module)};
            await assertReleaseCandidate(${JSON.stringify(candidate)}).then(
              () => { console.error("Dirty candidate was admitted"); process.exitCode = 2 },
              (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 },
            );
          `,
        ],
        {
          cwd: repository,
          env: { ...environment, GIT_TRACE: trace },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 15_000,
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      const output = stdout + stderr
      expect(code).toBe(1)
      expect(output).toContain("release candidate tree is dirty")
      expect(output).toContain(scenario.status)
      expect(output).toContain(scenario.filename)
      expect(output).not.toContain(contents.trim())
      const observed = await Bun.file(trace).text()
      expect(observed).toContain("git status")
      expect(observed).not.toMatch(/\bgit (?:ls-remote|fetch|push|remote|send-pack|upload-pack)\b/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
