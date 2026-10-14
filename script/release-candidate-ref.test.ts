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

type Release = {
  databaseId: number
  tagName: string
  isDraft: boolean
  publishedAt: string | null
  assets: unknown[]
  targetCommitish: string
}
type Recovery = {
  sourceRef: string
  sourceCommit: string
  release: Release
  replacement: { candidate: string; tag: string; releaseID: number }
}

function admit(root: string, baseCommit: string, commit: string, recovery?: Recovery, confirmed?: Release) {
  return Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { ensureReleaseCandidateRef } from ${JSON.stringify(path.join(import.meta.dir, "release-candidate-ref.ts"))};
    try {
      console.log(await ensureReleaseCandidateRef({
        ...${JSON.stringify({ repository: root, version: "2.0.4", baseCommit, commit, ...recovery })},
        ${recovery ? `confirmReplacement: async () => (${JSON.stringify(confirmed ?? recovery.release)}),` : ""}
      }));
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

async function recoveryRepository(
  run: (root: string, input: Recovery, candidate: string) => Promise<void>,
  annotated = false,
) {
  await repository(async (root, base) => {
    const previous = await prepare(root, "2.0.4\n")
    git(root, ["push", "--quiet", "origin", `${previous}:refs/heads/release-candidates/v2.0.4`])
    git(
      root,
      annotated
        ? ["tag", "--annotate", "v2.0.4", "--message", "test: prepared draft", previous]
        : ["tag", "v2.0.4", previous],
    )
    const tag = git(root, ["rev-parse", "refs/tags/v2.0.4"])
    git(root, ["push", "--quiet", "origin", "refs/tags/v2.0.4"])
    git(root, ["checkout", "--quiet", "--detach", base])
    await Bun.write(path.join(root, "repair"), "published source repair\n")
    git(root, ["add", "repair"])
    git(root, ["commit", "--quiet", "-m", "fix(release): repair source"])
    const source = git(root, ["rev-parse", "HEAD"])
    git(root, ["push", "--quiet", "origin", `${source}:refs/heads/main`])
    const candidate = await prepare(root, "2.0.4\n")
    const release = {
      databaseId: 412460632,
      tagName: "v2.0.4",
      isDraft: true,
      publishedAt: null,
      assets: [],
      targetCommitish: previous,
    }
    await run(
      root,
      {
        sourceRef: "refs/heads/main",
        sourceCommit: source,
        release,
        replacement: { candidate: previous, tag, releaseID: release.databaseId },
      },
      candidate,
    )
  })
}

function refs(root: string) {
  return git(root, [
    "ls-remote",
    "origin",
    "refs/heads/release-candidates/v2.0.4",
    "refs/tags/v2.0.4",
    "refs/tags/v2.0.4^{}",
  ]).split("\n")
}

test("candidate recovery replaces only an explicitly pinned empty draft from an ancestor source", async () => {
  await recoveryRepository(async (root, input, candidate) => {
    const result = admit(root, input.sourceCommit, candidate, input)
    expect({ code: result.exitCode, error: result.exitCode ? result.stderr.toString() : null }).toEqual({
      code: 0,
      error: null,
    })
    expect(refs(root)).toEqual([`${candidate}\trefs/heads/release-candidates/v2.0.4`, `${candidate}\trefs/tags/v2.0.4`])
    expect(git(root, ["ls-remote", "origin", "refs/heads/main"]).split("\t")[0]).toBe(input.sourceCommit)
    expect(git(root, ["rev-parse", "HEAD"])).toBe(candidate)
  })
})

test("candidate recovery refuses published, nonempty and inconsistent release facts without changing refs", async () => {
  await recoveryRepository(async (root, input, candidate) => {
    const original = refs(root)
    for (const release of [
      { ...input.release, isDraft: false },
      { ...input.release, publishedAt: "2026-10-14T00:00:00Z" },
      { ...input.release, assets: [{ id: 1, name: "already-built.zip" }] },
      { ...input.release, databaseId: input.release.databaseId + 1 },
      { ...input.release, tagName: "v2.0.5" },
      { ...input.release, targetCommitish: input.sourceCommit },
    ]) {
      expect(admit(root, input.sourceCommit, candidate, { ...input, release }).exitCode).toBe(1)
      expect(refs(root)).toEqual(original)
      expect(git(root, ["rev-parse", "HEAD"])).toBe(candidate)
    }
  })
})

test("candidate recovery refuses changed confirmation metadata before any Git replacement", async () => {
  await recoveryRepository(async (root, input, candidate) => {
    const original = refs(root)
    for (const confirmed of [
      { ...input.release, isDraft: false, publishedAt: "2026-10-14T01:00:00Z" },
      { ...input.release, assets: [{ id: 2, name: "concurrent-upload.zip" }] },
      { ...input.release, databaseId: input.release.databaseId + 1 },
      { ...input.release, targetCommitish: candidate },
    ]) {
      expect(admit(root, input.sourceCommit, candidate, input, confirmed).exitCode).toBe(1)
      expect(refs(root)).toEqual(original)
    }
  })
})

test("candidate recovery leases an annotated raw tag while requiring its peeled candidate", async () => {
  await recoveryRepository(async (root, input, candidate) => {
    expect(input.replacement.tag).not.toBe(input.replacement.candidate)
    const original = refs(root)
    expect(original).toContain(`${input.replacement.candidate}\trefs/tags/v2.0.4^{}`)
    expect(
      admit(root, input.sourceCommit, candidate, {
        ...input,
        replacement: { ...input.replacement, tag: input.replacement.candidate },
      }).exitCode,
    ).toBe(1)
    expect(refs(root)).toEqual(original)
    expect(admit(root, input.sourceCommit, candidate, input).exitCode).toBe(0)
    expect(refs(root)).toEqual([`${candidate}\trefs/heads/release-candidates/v2.0.4`, `${candidate}\trefs/tags/v2.0.4`])
  }, true)
})

test("candidate recovery rejects a real pre-push lease race atomically", async () => {
  await recoveryRepository(async (root, input, candidate) => {
    const raced = git(root, ["commit-tree", "HEAD^{tree}", "-p", candidate, "-m", "test: concurrent candidate writer"])
    git(root, ["push", "--quiet", "origin", `${raced}:refs/heads/race-fixture`])
    const hook = path.join(root, "hooks/pre-push")
    await Bun.write(
      hook,
      `#!/bin/sh\ngit --git-dir=origin.git update-ref refs/heads/release-candidates/v2.0.4 ${raced} ${input.replacement.candidate} || exit 3\nprintf 'ACTUAL_CONCURRENT_WRITER\\n'\n`,
    )
    const { chmod } = await import("node:fs/promises")
    await chmod(hook, 0o700)
    const rejected = admit(root, input.sourceCommit, candidate, input)
    expect(rejected.exitCode).toBe(1)
    expect(rejected.stdout.toString()).toContain("ACTUAL_CONCURRENT_WRITER")
    expect(refs(root)).toEqual([
      `${raced}\trefs/heads/release-candidates/v2.0.4`,
      `${input.replacement.tag}\trefs/tags/v2.0.4`,
    ])
  })
})

test("candidate recovery rejects a real raw-tag lease race without updating the candidate", async () => {
  await recoveryRepository(async (root, input, candidate) => {
    const raced = git(root, ["commit-tree", "HEAD^{tree}", "-p", candidate, "-m", "test: concurrent tag writer"])
    git(root, ["push", "--quiet", "origin", `${raced}:refs/heads/race-fixture`])
    const hook = path.join(root, "hooks/pre-push")
    await Bun.write(
      hook,
      `#!/bin/sh\ngit --git-dir=origin.git update-ref refs/tags/v2.0.4 ${raced} ${input.replacement.tag} || exit 3\nprintf 'ACTUAL_CONCURRENT_TAG_WRITER\\n'\n`,
    )
    const { chmod } = await import("node:fs/promises")
    await chmod(hook, 0o700)
    const rejected = admit(root, input.sourceCommit, candidate, input)
    expect(rejected.exitCode).toBe(1)
    expect(rejected.stdout.toString()).toContain("ACTUAL_CONCURRENT_TAG_WRITER")
    expect(refs(root)).toEqual([
      `${input.replacement.candidate}\trefs/heads/release-candidates/v2.0.4`,
      `${raced}\trefs/tags/v2.0.4`,
    ])
  })
})

test("candidate recovery refuses a changed main source and a multi-parent preparation", async () => {
  await recoveryRepository(async (root, input, candidate) => {
    const original = refs(root)
    const advanced = git(root, [
      "commit-tree",
      `${input.sourceCommit}^{tree}`,
      "-p",
      input.sourceCommit,
      "-m",
      "test: advanced main",
    ])
    git(root, ["push", "--quiet", "origin", `${advanced}:refs/heads/main`])
    expect(admit(root, input.sourceCommit, candidate, input).exitCode).toBe(1)
    expect(refs(root)).toEqual(original)
    git(root, [
      "push",
      "--quiet",
      "origin",
      `--force-with-lease=refs/heads/main:${advanced}`,
      `${input.sourceCommit}:refs/heads/main`,
    ])
    const merged = git(root, [
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      input.sourceCommit,
      "-p",
      input.replacement.candidate,
      "-m",
      "test: invalid merge preparation",
    ])
    git(root, ["reset", "--hard", merged])
    expect(admit(root, input.sourceCommit, merged, input).exitCode).toBe(1)
    expect(refs(root)).toEqual(original)
  })
})

test("candidate recovery refuses an old candidate whose parent is outside the new source ancestry", async () => {
  await recoveryRepository(async (root, input) => {
    const original = refs(root)
    const unrelated = git(root, ["commit-tree", `${input.sourceCommit}^{tree}`, "-m", "test: unrelated source history"])
    git(root, ["reset", "--hard", unrelated])
    git(root, [
      "push",
      "--quiet",
      "origin",
      `--force-with-lease=refs/heads/main:${input.sourceCommit}`,
      `${unrelated}:refs/heads/main`,
    ])
    const candidate = await prepare(root, "2.0.4\n")
    expect(admit(root, unrelated, candidate, { ...input, sourceCommit: unrelated }).exitCode).toBe(1)
    expect(refs(root)).toEqual(original)
  })
})
