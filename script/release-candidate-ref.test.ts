import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "deepagent-ai",
  GIT_AUTHOR_EMAIL: "deepagent-ai@deepagent.ltd",
  GIT_COMMITTER_NAME: "deepagent-ai",
  GIT_COMMITTER_EMAIL: "deepagent-ai@deepagent.ltd",
}

function git(root: string, args: string[], date = "2026-10-14T00:00:00Z") {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: {
      ...environment,
      GIT_CONFIG_GLOBAL: path.join(root, ".git-test-config"),
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

async function repository(run: (root: string, base: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "dac-candidate-ref-"))
  try {
    // Git for Windows cannot open node:os.devNull as a config file.
    await Bun.write(path.join(root, ".git-test-config"), "")
    git(root, ["init", "--quiet"])
    git(root, ["init", "--bare", "--quiet", path.join(root, "origin.git")])
    await Bun.write(path.join(root, ".gitignore"), "origin.git/\nhooks/\n.git-test-config\n")
    await Bun.write(path.join(root, "version"), "base\n")
    git(root, ["add", "."])
    git(root, ["commit", "--quiet", "-m", "test: candidate base"])
    git(root, ["remote", "add", "origin", path.join(root, "origin.git")])
    git(root, ["config", "core.hooksPath", path.join(root, "hooks")])
    await run(root, git(root, ["rev-parse", "HEAD"]))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function prepare(root: string, contents: string, date = "2026-10-14T00:00:00Z") {
  await Bun.write(path.join(root, "version"), contents)
  git(root, ["add", "version"])
  git(root, ["commit", "--quiet", "-m", "chore(release): prepare v2.0.4"], date)
  return git(root, ["rev-parse", "HEAD"])
}

function admit(root: string, baseCommit: string, commit: string) {
  return Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { ensureReleaseCandidateRef } from ${JSON.stringify(path.join(import.meta.dir, "release-candidate-ref.ts"))};
    try {
      console.log(await ensureReleaseCandidateRef(${JSON.stringify({ repository: root, version: "2.0.4", baseCommit, commit })}));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  `,
    ],
    {
      cwd: root,
      env: { ...environment, GIT_CONFIG_GLOBAL: path.join(root, ".git-test-config") },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
}

test("candidate push retains actual hook diagnostics and refuses the remote ref", async () => {
  await repository(async (root, base) => {
    const candidate = await prepare(root, "2.0.4\n")
    const hook = path.join(root, "hooks/pre-push")
    await Bun.write(
      hook,
      "#!/bin/sh\nprintf 'TYPECHECK_STDOUT_DIAGNOSTIC\\n'\nprintf 'TYPECHECK_STDERR_DIAGNOSTIC\\n' >&2\nexit 2\n",
    )
    const { chmod } = await import("node:fs/promises")
    await chmod(hook, 0o700)
    const result = admit(root, base, candidate)
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("TYPECHECK_STDOUT_DIAGNOSTIC")
    expect(result.stderr.toString()).toContain("TYPECHECK_STDERR_DIAGNOSTIC")
    expect(git(root, ["ls-remote", "origin", "refs/heads/release-candidates/v2.0.4"])).toBe("")
  })
})

test("candidate retry reuses identical prepared bytes and never overwrites source drift", async () => {
  await repository(async (root, base) => {
    const candidate = await prepare(root, "2.0.4\n")
    expect(admit(root, base, candidate).exitCode).toBe(0)
    git(root, ["checkout", "--quiet", "--detach", base])
    const retry = await prepare(root, "2.0.4\n", "2026-10-14T01:00:00Z")
    expect(retry).not.toBe(candidate)
    const reused = admit(root, base, retry)
    expect(reused.exitCode).toBe(0)
    expect(reused.stdout.toString().trim()).toBe(candidate)
    expect(git(root, ["rev-parse", "HEAD"])).toBe(candidate)
    git(root, ["checkout", "--quiet", "--detach", base])
    const drift = await prepare(root, "different source\n")
    const rejected = admit(root, base, drift)
    expect(rejected.exitCode).toBe(1)
    expect(rejected.stderr.toString()).toContain("release candidate ref drifted from prepared source")
    expect(git(root, ["ls-remote", "origin", "refs/heads/release-candidates/v2.0.4"]).split("\t")[0]).toBe(candidate)
  })
})

test("release job Git configuration preserves the requested deepagent-ai source identity", async () => {
  const action = Bun.YAML.parse(
    await Bun.file(path.resolve(import.meta.dir, "../.github/actions/setup-git-committer/action.yml")).text(),
  ) as { runs: { steps: { name?: string; run?: string }[] } }
  await repository(async (root) => {
    const step = action.runs.steps.find((entry) => entry.name === "Configure git user")!
    const result = Bun.spawnSync(["bash", "-c", step.run!], {
      cwd: root,
      env: { ...environment, GIT_CONFIG_GLOBAL: path.join(root, ".git-test-config") },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode).toBe(0)
    expect(git(root, ["config", "--global", "--get", "user.name"])).toBe("deepagent-ai")
    expect(git(root, ["config", "--global", "--get", "user.email"])).toBe("deepagent-ai@deepagent.ltd")
  })
})
