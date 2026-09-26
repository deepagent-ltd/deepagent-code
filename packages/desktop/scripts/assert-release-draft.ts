import path from "node:path"

export function assertReleaseDraft() {
  const commit = process.env.DEEPAGENT_CODE_CANDIDATE_COMMIT
  const tree = process.env.DEEPAGENT_CODE_CANDIDATE_TREE
  const version = process.env.DEEPAGENT_CODE_VERSION
  const releaseID = process.env.DEEPAGENT_CODE_RELEASE
  const repository = process.env.GH_REPO
  if (!commit || !tree || !version || !releaseID || !repository)
    throw new Error("release candidate and draft identity are required before publishing")
  const check = Bun.spawnSync(
    [
      process.execPath,
      path.resolve(import.meta.dir, "../../../script/assert-release-candidate.ts"),
      "--commit",
      commit,
      "--tree",
      tree,
      "--tag",
      `v${version}`,
      "--release-id",
      releaseID,
      "--release-repo",
      repository,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  if (check.exitCode !== 0) throw new Error(`release candidate check failed: ${check.stderr.toString().trim()}`)
}
