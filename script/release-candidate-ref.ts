export type CandidateRelease = {
  databaseId: number
  tagName: string
  isDraft: boolean
  publishedAt: string | null
  assets: unknown[]
  targetCommitish: string
}

export function releaseCandidateReplacement(version: string, release?: CandidateRelease) {
  // Each entry authorizes only one observed, never-published candidate generation.
  const replacement =
    version === "2.0.4"
      ? {
          candidate: "8b86573580109b42b0d724d60817a181de0cf34f",
          tag: "8b86573580109b42b0d724d60817a181de0cf34f",
          releaseID: 412460632,
        }
      : version === "2.0.5"
        ? {
            candidate: "04f248daca1b4a97a9b5730a1e5240cb8184d51b",
            tag: "04f248daca1b4a97a9b5730a1e5240cb8184d51b",
            releaseID: 422617422,
          }
        : undefined
  if (!replacement || release?.databaseId !== replacement.releaseID || release.tagName !== `v${version}`) return
  return replacement
}

export async function ensureReleaseDraftTarget(input: {
  version: string
  commit: string
  initialRelease: CandidateRelease
  release: CandidateRelease
  update: () => Promise<unknown>
  confirm: () => Promise<CandidateRelease | undefined>
}) {
  if (
    !/^[a-f0-9]{40}$/.test(input.commit) ||
    ![input.initialRelease, input.release].every(
      (release) =>
        release.databaseId === input.initialRelease.databaseId &&
        release.tagName === `v${input.version}` &&
        release.isDraft &&
        release.publishedAt === null,
    )
  )
    throw new Error("release target replacement requires the authorized empty draft")
  // A retry after the target edit must not overwrite notes or reject existing build assets.
  if (input.release.targetCommitish === input.commit) return
  const replacement = releaseCandidateReplacement(input.version, input.initialRelease)
  if (
    !replacement ||
    input.initialRelease.targetCommitish !== replacement.candidate ||
    ![input.initialRelease, input.release].every(
      (release) =>
        release.databaseId === replacement.releaseID &&
        release.tagName === `v${input.version}` &&
        release.isDraft &&
        release.publishedAt === null &&
        release.assets.length === 0 &&
        release.targetCommitish === replacement.candidate,
    )
  )
    throw new Error("release target replacement requires the authorized empty draft")
  await input.update()
  const confirmed = await input.confirm()
  if (
    !confirmed ||
    confirmed.databaseId !== replacement.releaseID ||
    confirmed.tagName !== `v${input.version}` ||
    !confirmed.isDraft ||
    confirmed.publishedAt !== null ||
    confirmed.assets.length !== 0 ||
    confirmed.targetCommitish !== input.commit
  )
    throw new Error("release draft changed during target replacement")
}

export async function ensureReleaseCandidateRef(input: {
  repository: string
  version: string
  baseCommit: string
  commit: string
  sourceRef?: string
  sourceCommit?: string
  release?: CandidateRelease
  replacement?: { candidate: string; tag: string; releaseID: number }
  confirmReplacement?: () => Promise<CandidateRelease | undefined>
}) {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: input.repository, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0)
      throw new Error(
        `git ${args[0]} failed: ${[result.stderr, result.stdout]
          .map((output) => output.toString().trim())
          .filter(Boolean)
          .join("\n")}`,
      )
    return result.stdout.toString().trim()
  }
  if (input.release && (!input.release.isDraft || input.release.publishedAt !== null))
    throw new Error("release candidate is already published")
  if (input.release && input.release.tagName !== `v${input.version}`) throw new Error("release draft tag changed")
  if (git("rev-parse", "HEAD") !== input.commit) throw new Error("candidate HEAD changed before ref push")
  if (git("status", "--porcelain", "--untracked-files=all")) throw new Error("candidate tree is dirty before ref push")
  const ref = `refs/heads/release-candidates/v${input.version}`
  const existing = git("ls-remote", "origin", ref).split("\t")[0]
  if (!existing) {
    // The pre-push checks can run for minutes. Stream their diagnostics rather
    // than retaining them inside a synchronous subprocess until push exits.
    const push = Bun.spawn(["git", "push", "origin", `HEAD:${ref}`], {
      cwd: input.repository,
      stdout: "inherit",
      stderr: "inherit",
    })
    const code = await push.exited
    if (code !== 0) throw new Error(`git push failed with exit code ${code}`)
    return input.commit
  }
  if (existing === input.commit) return input.commit

  // A retry may create a different commit object for the same prepared bytes.
  // Reuse the previously pushed object only when its parent and tree match.
  git("fetch", "origin", ref)
  if (git("rev-parse", "FETCH_HEAD") !== existing) throw new Error("release candidate ref changed during retry")
  if (
    git("rev-parse", "FETCH_HEAD^{tree}") === git("rev-parse", "HEAD^{tree}") &&
    git("rev-parse", "FETCH_HEAD^") === input.baseCommit
  ) {
    git("checkout", "--detach", existing)
    return existing
  }

  const replacement = input.replacement
  if (!replacement || replacement.candidate !== existing)
    throw new Error("release candidate ref drifted from prepared source")
  const release = input.release
  if (
    !release ||
    release.databaseId !== replacement.releaseID ||
    !Array.isArray(release.assets) ||
    release.assets.length ||
    release.targetCommitish !== existing
  )
    throw new Error("release replacement requires the authorized empty draft")
  if (
    input.sourceRef !== "refs/heads/main" ||
    input.sourceCommit !== input.baseCommit ||
    git("ls-remote", "origin", "refs/heads/main").split("\t")[0] !== input.baseCommit
  )
    throw new Error("release replacement requires the current main source")
  if (
    git("rev-parse", "HEAD^") !== input.baseCommit ||
    git("rev-list", "--parents", "-n", "1", "HEAD").split(" ").length !== 2 ||
    git("rev-list", "--parents", "-n", "1", existing).split(" ").length !== 2
  )
    throw new Error("release replacement requires a prepared single-parent candidate")
  git("merge-base", "--is-ancestor", git("rev-parse", `${existing}^`), input.baseCommit)

  const tagRef = `refs/tags/v${input.version}`
  const tags = git("ls-remote", "origin", tagRef, `${tagRef}^{}`).split("\n").filter(Boolean)
  const rawTag = tags.find((line) => line.endsWith(`\t${tagRef}`))?.split("\t")[0]
  const tagCommit = (
    tags.find((line) => line.endsWith(`\t${tagRef}^{}`)) ?? tags.find((line) => line.endsWith(`\t${tagRef}`))
  )?.split("\t")[0]
  if (rawTag !== replacement.tag || tagCommit !== existing)
    throw new Error("release replacement tag differs from the authorized candidate")
  const confirmed = await input.confirmReplacement?.()
  if (
    !confirmed ||
    confirmed.databaseId !== release.databaseId ||
    confirmed.tagName !== release.tagName ||
    !confirmed.isDraft ||
    confirmed.publishedAt !== null ||
    !Array.isArray(confirmed.assets) ||
    confirmed.assets.length ||
    confirmed.targetCommitish !== existing
  )
    throw new Error("release draft changed before replacement")
  if (
    git("rev-parse", "HEAD") !== input.commit ||
    git("status", "--porcelain", "--untracked-files=all") ||
    git("ls-remote", "origin", "refs/heads/main").split("\t")[0] !== input.baseCommit
  )
    throw new Error("release replacement source changed before push")
  // Never force an unobserved ref. An atomic lease keeps candidate and tag paired.
  const push = Bun.spawn(
    [
      "git",
      "push",
      "--atomic",
      `--force-with-lease=${ref}:${existing}`,
      `--force-with-lease=${tagRef}:${rawTag}`,
      "origin",
      `HEAD:${ref}`,
      `HEAD:${tagRef}`,
    ],
    {
      cwd: input.repository,
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  const code = await push.exited
  if (code !== 0) throw new Error(`release replacement push failed with exit code ${code}`)
  const written = git("ls-remote", "origin", ref, tagRef).split("\n").filter(Boolean)
  if (written.length !== 2 || written.some((line) => line.split("\t")[0] !== input.commit))
    throw new Error("release replacement refs changed after push")
  return input.commit
}
