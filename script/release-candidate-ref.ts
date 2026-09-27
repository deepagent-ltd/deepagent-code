export function ensureReleaseCandidateRef(input: {
  repository: string
  version: string
  baseCommit: string
  commit: string
}): string {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: input.repository, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`)
    return result.stdout.toString().trim()
  }
  if (git("rev-parse", "HEAD") !== input.commit) throw new Error("candidate HEAD changed before ref push")
  if (git("status", "--porcelain", "--untracked-files=all")) throw new Error("candidate tree is dirty before ref push")
  const ref = `refs/heads/release-candidates/v${input.version}`
  const existing = git("ls-remote", "origin", ref).split("\t")[0]
  if (!existing) {
    git("push", "origin", `HEAD:${ref}`)
    return input.commit
  }
  if (existing === input.commit) return input.commit

  // A retry may create a different commit object for the same prepared bytes.
  // Reuse the previously pushed object only when its parent and tree match.
  git("fetch", "origin", ref)
  if (git("rev-parse", "FETCH_HEAD") !== existing) throw new Error("release candidate ref changed during retry")
  if (
    git("rev-parse", "FETCH_HEAD^{tree}") !== git("rev-parse", "HEAD^{tree}") ||
    git("rev-parse", "FETCH_HEAD^") !== input.baseCommit
  )
    throw new Error("release candidate ref drifted from prepared source")
  git("checkout", "--detach", existing)
  return existing
}
