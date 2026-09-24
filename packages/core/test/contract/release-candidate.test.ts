import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { assertReleaseCandidate } from "../../../../script/assert-release-candidate"
import { ensureReleaseCandidateRef } from "../../../../script/release-candidate-ref"
import { tmpdir } from "../fixture/tmpdir"

test("release candidate guard binds HEAD, remote tag, clean tree, and packaged binary", async () => {
  await using root = await tmpdir()
  const repository = join(root.path, "checkout")
  const remote = join(root.path, "remote.git")
  await mkdir(repository)
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  git(root.path, "init", "--bare", remote)
  git(repository, "init", "-b", "main")
  git(repository, "config", "user.email", "release@test.example")
  git(repository, "config", "user.name", "Release Test")
  await Bun.write(join(repository, "tracked.txt"), "candidate")
  await mkdir(join(repository, "packages/sdk/js/dist"), { recursive: true })
  const preparedFiles = ["package.json", "bun.lock", "packages/sdk/js/dist/generated.js", "UPCOMING_CHANGELOG.md"]
  for (const file of preparedFiles) await Bun.write(join(repository, file), "prepared candidate bytes")
  git(repository, "add", "-A")
  git(repository, "commit", "-m", "chore(release): prepare candidate")
  const commit = git(repository, "rev-parse", "HEAD")
  const tree = git(repository, "rev-parse", "HEAD^{tree}")
  git(repository, "remote", "add", "origin", remote)
  git(repository, "tag", "v2.0.2")
  git(repository, "push", "origin", "v2.0.2")

  const packageDir = join(root.path, "package")
  await mkdir(join(packageDir, "bin"), { recursive: true })
  await Bun.write(join(packageDir, "bin/deepagent-code"), "binary")
  const metadata = {
    version: "2.0.2",
    deepagentCodeBuild: {
      sourceCommit: commit,
      sourceDirty: false,
      binarySha256: new Bun.CryptoHasher("sha256").update("binary").digest("hex"),
    },
  }
  await Bun.write(join(packageDir, "package.json"), JSON.stringify(metadata))
  const candidate = { repository, commit, tree, tag: "v2.0.2", packageDir }
  await expect(assertReleaseCandidate(candidate)).resolves.toBeUndefined()

  await expect(assertReleaseCandidate({ ...candidate, tree: "0".repeat(40) })).rejects.toThrow(
    "release candidate tree changed",
  )
  for (const file of preparedFiles) {
    await Bun.write(join(repository, file), "changed after candidate")
    await expect(assertReleaseCandidate(candidate)).rejects.toThrow("release candidate tree is dirty")
    await Bun.write(join(repository, file), "prepared candidate bytes")
  }

  await Bun.write(join(packageDir, "package.json"), JSON.stringify({ ...metadata, version: "2.0.3" }))
  await expect(assertReleaseCandidate(candidate)).rejects.toThrow("release package version does not match tag")
  await Bun.write(join(packageDir, "package.json"), JSON.stringify(metadata))

  await Bun.write(
    join(packageDir, "package.json"),
    JSON.stringify({ ...metadata, deepagentCodeBuild: { ...metadata.deepagentCodeBuild, sourceDirty: true } }),
  )
  await expect(assertReleaseCandidate(candidate)).rejects.toThrow("release package was built from a dirty tree")
  await Bun.write(join(packageDir, "package.json"), JSON.stringify(metadata))

  await Bun.write(join(packageDir, "bin/deepagent-code"), "different binary")
  await expect(assertReleaseCandidate(candidate)).rejects.toThrow(
    "release package binary SHA-256 does not match metadata",
  )
  await Bun.write(join(packageDir, "bin/deepagent-code"), "binary")

  await Bun.write(join(repository, "tracked.txt"), "different commit")
  git(repository, "add", "tracked.txt")
  git(repository, "commit", "-m", "test: move remote tag")
  await expect(assertReleaseCandidate(candidate)).rejects.toThrow("release candidate HEAD changed")
  git(repository, "tag", "-f", "v2.0.2")
  git(repository, "push", "--force", "origin", "v2.0.2")
  git(repository, "reset", "--hard", commit)
  await expect(assertReleaseCandidate(candidate)).rejects.toThrow("release tag does not point at candidate commit")
})

test("candidate ref rerun reuses identical prepared tree and rejects drift", async () => {
  await using root = await tmpdir()
  const repository = join(root.path, "checkout")
  const remote = join(root.path, "remote.git")
  await mkdir(repository)
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  git(root.path, "init", "--bare", remote)
  git(repository, "init", "-b", "main")
  git(repository, "config", "user.email", "release@test.example")
  git(repository, "config", "user.name", "Release Test")
  await Bun.write(join(repository, "package.json"), '{"version":"2.0.1"}')
  git(repository, "add", "-A")
  git(repository, "commit", "-m", "chore: base")
  const baseCommit = git(repository, "rev-parse", "HEAD")
  git(repository, "remote", "add", "origin", remote)
  await Bun.write(join(repository, "package.json"), '{"version":"2.0.2"}')
  git(repository, "add", "-A")
  git(repository, "commit", "-m", "chore(release): first candidate")
  const commit = git(repository, "rev-parse", "HEAD")
  const input = { repository, version: "2.0.2", baseCommit, commit }
  expect(ensureReleaseCandidateRef(input)).toBe(commit)
  expect(ensureReleaseCandidateRef(input)).toBe(commit)

  git(repository, "checkout", "--detach", baseCommit)
  await Bun.write(join(repository, "package.json"), '{"version":"2.0.2"}')
  git(repository, "add", "-A")
  git(repository, "commit", "-m", "chore(release): retried candidate")
  expect(ensureReleaseCandidateRef({ ...input, commit: git(repository, "rev-parse", "HEAD") })).toBe(commit)
  expect(git(repository, "rev-parse", "HEAD")).toBe(commit)

  git(repository, "checkout", "--detach", baseCommit)
  await Bun.write(join(repository, "package.json"), '{"version":"2.0.3"}')
  git(repository, "add", "-A")
  git(repository, "commit", "-m", "chore(release): drifted candidate")
  expect(() => ensureReleaseCandidateRef({ ...input, commit: git(repository, "rev-parse", "HEAD") })).toThrow(
    "release candidate ref drifted",
  )

  git(repository, "checkout", "--detach", baseCommit)
  git(repository, "commit", "--allow-empty", "-m", "chore: changed source base")
  const changedBase = git(repository, "rev-parse", "HEAD")
  await Bun.write(join(repository, "package.json"), '{"version":"2.0.2"}')
  git(repository, "add", "-A")
  git(repository, "commit", "-m", "chore(release): same tree from changed base")
  expect(() =>
    ensureReleaseCandidateRef({ ...input, baseCommit: changedBase, commit: git(repository, "rev-parse", "HEAD") }),
  ).toThrow("release candidate ref drifted")
})
