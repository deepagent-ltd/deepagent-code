#!/usr/bin/env bun

import path from "node:path"

export async function assertReleaseCandidate(input: {
  repository: string
  commit: string
  tree: string
  tag: string
  packageDir?: string
}) {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: input.repository, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`)
    return result.stdout.toString().trim()
  }
  if (git("rev-parse", "HEAD") !== input.commit) throw new Error("release candidate HEAD changed")
  if (git("rev-parse", "HEAD^{tree}") !== input.tree) throw new Error("release candidate tree changed")
  if (git("status", "--porcelain", "--untracked-files=all")) throw new Error("release candidate tree is dirty")
  const tagRef = `refs/tags/${input.tag}`
  const remote = git("ls-remote", "origin", tagRef, `${tagRef}^{}`)
    .split("\n")
    .filter(Boolean)
  const tagCommit = remote.find((line) => line.endsWith(`${tagRef}^{}`)) ?? remote.find((line) => line.endsWith(tagRef))
  if (tagCommit?.split("\t")[0] !== input.commit) throw new Error("release tag does not point at candidate commit")

  if (!input.packageDir) return
  const packageDir = path.resolve(input.repository, input.packageDir)
  const metadata = (await Bun.file(path.join(packageDir, "package.json")).json()) as {
    version?: string
    deepagentCodeBuild?: { sourceCommit?: string; sourceDirty?: boolean; binarySha256?: string }
  }
  if (`v${metadata.version}` !== input.tag) throw new Error("release package version does not match tag")
  if (metadata.deepagentCodeBuild?.sourceCommit !== input.commit)
    throw new Error("release package sourceCommit does not match candidate commit")
  if (metadata.deepagentCodeBuild.sourceDirty !== false) throw new Error("release package was built from a dirty tree")
  const binary = ["bin/deepagent-code", "bin/deepagent-code.exe"].map((name) => path.join(packageDir, name))
  const present = await Promise.all(binary.map(async (file) => (await Bun.file(file).exists() ? file : undefined)))
  const found = present.filter((file): file is string => file !== undefined)
  if (found.length !== 1) throw new Error("release package must contain exactly one CLI binary")
  const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(found[0]!).bytes()).digest("hex")
  if (metadata.deepagentCodeBuild.binarySha256 !== digest)
    throw new Error("release package binary SHA-256 does not match metadata")
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const option = (name: string) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const commit = option("--commit")
  const tree = option("--tree")
  const tag = option("--tag")
  if (!commit || !tree || !tag)
    throw new Error("usage: assert-release-candidate.ts --commit <sha> --tree <sha> --tag <tag> [--package-dir <dir>]")
  await assertReleaseCandidate({
    repository: path.resolve(import.meta.dir, ".."),
    commit,
    tree,
    tag,
    packageDir: args.includes("--package-dir") ? option("--package-dir") : undefined,
  })
}
