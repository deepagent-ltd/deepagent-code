#!/usr/bin/env bun

import { Script } from "@deepagent-code/script"
import { $ } from "bun"
import { assertReleaseCandidate } from "./assert-release-candidate"
import { prepareReleaseFiles } from "./prepare-release-files"
import { ensureReleaseCandidateRef } from "./release-candidate-ref"
import type { CandidateRelease } from "./release-candidate-ref"

if (
  Script.channel !== "beta" &&
  process.env.GH_REPO &&
  process.env.GITHUB_REPOSITORY &&
  process.env.GH_REPO !== process.env.GITHUB_REPOSITORY
)
  throw new Error("release candidate target repository differs from checkout")
const output = [`version=${Script.version}`]
const baseSha = (await $`git rev-parse HEAD`.text()).trim()
const sourceSha = process.env.GITHUB_SHA ?? baseSha
if (sourceSha !== baseSha) throw new Error("release checkout differs from workflow source")
let candidateSha = baseSha

if (!Script.preview) {
  const initialRelease = await readRelease()
  if (initialRelease && (!initialRelease.isDraft || initialRelease.publishedAt !== null))
    throw new Error("release candidate is already published")
  output.push(`owner_reuse_required=${Boolean(initialRelease)}`)
  const body = await $`bun script/raw-changelog.ts --to ${sourceSha}`.cwd(process.cwd()).text()
  const dir = process.env.RUNNER_TEMP ?? "/tmp"
  const notesFile = `${dir}/deepagent-code-release-notes.txt`
  await Bun.write(notesFile, body)
  await prepareReleaseFiles(Script.version, process.cwd())
  await $`bun script/check-public-source-boundary.ts --worktree`.cwd(process.cwd())
  await $`git add -A`
  if ((await $`git diff --cached --quiet`.nothrow()).exitCode !== 0)
    await $`git commit -m ${`chore(release): prepare v${Script.version}`}`
  if ((await $`git status --porcelain --untracked-files=all`.text()).trim())
    throw new Error("release candidate source tree is dirty after preparation")
  candidateSha = await ensureReleaseCandidateRef({
    repository: process.cwd(),
    version: Script.version,
    baseCommit: baseSha,
    commit: (await $`git rev-parse HEAD`.text()).trim(),
    sourceRef: process.env.GITHUB_REF,
    sourceCommit: sourceSha,
    release: initialRelease,
    // One recovery of the failed, never-published v2.0.4 candidate authorized
    // by its owner. Other versions and later ref generations keep the strict gate.
    replacement:
      Script.version === "2.0.4" && initialRelease?.databaseId === 412460632
        ? {
            candidate: "8b86573580109b42b0d724d60817a181de0cf34f",
            tag: "8b86573580109b42b0d724d60817a181de0cf34f",
            releaseID: 412460632,
          }
        : undefined,
    confirmReplacement: readRelease,
  })
  // A draft GitHub release does not create its Git tag.
  const tagRef = `refs/tags/v${Script.version}`
  const remoteTags = (await $`git ls-remote origin ${tagRef} ${`${tagRef}^{}`}`.text()).trim().split("\n")
  const remoteTag =
    remoteTags.find((line) => line.endsWith(`${tagRef}^{}`)) ?? remoteTags.find((line) => line.endsWith(tagRef))
  if (remoteTag && remoteTag.split("\t")[0] !== candidateSha)
    throw new Error("release tag does not point at candidate commit")
  if (!remoteTag) await $`git push origin ${`${candidateSha}:${tagRef}`}`
  const existingRelease = await readRelease()
  if (existingRelease) {
    if (!existingRelease.isDraft || existingRelease.publishedAt !== null)
      throw new Error("release candidate is already published")
    if (initialRelease && existingRelease.databaseId !== initialRelease.databaseId)
      throw new Error("release draft ID changed during preparation")
    if (initialRelease && candidateSha !== initialRelease.targetCommitish && initialRelease.databaseId === 412460632) {
      if (existingRelease.assets.length) throw new Error("release draft gained assets during replacement")
      await $`gh release edit v${Script.version} --target ${candidateSha} --notes-file ${notesFile} --repo ${process.env.GH_REPO}`
    }
  } else {
    if (initialRelease) throw new Error("release draft disappeared during preparation")
    await $`gh release create v${Script.version} -d --target ${candidateSha} --title "v${Script.version}" --notes-file ${notesFile} --repo ${process.env.GH_REPO}`
  }
  await assertReleaseCandidate({
    repository: process.cwd(),
    commit: candidateSha,
    tree: (await $`git rev-parse HEAD^{tree}`.text()).trim(),
    tag: `v${Script.version}`,
  })
  const release =
    await $`gh release view v${Script.version} --json tagName,databaseId --repo ${process.env.GH_REPO}`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
}

output.push(`repo=${process.env.GH_REPO}`)
output.push(`candidate_commit=${candidateSha}`)
output.push(`candidate_tree=${(await $`git rev-parse HEAD^{tree}`.text()).trim()}`)
output.push(`channel=${Script.channel}`)

if (process.env.GITHUB_OUTPUT) {
  await Bun.write(process.env.GITHUB_OUTPUT, output.join("\n"))
}

process.exit(0)

async function readRelease() {
  const result =
    await $`gh release view v${Script.version} --json tagName,databaseId,isDraft,publishedAt,assets,targetCommitish --repo ${process.env.GH_REPO}`
      .quiet()
      .nothrow()
  if (result.exitCode !== 0) {
    if (result.stderr.toString().trim() === "release not found") return undefined
    throw new Error(`release state could not be read: ${result.stderr.toString().trim()}`)
  }
  const release = JSON.parse(result.stdout.toString()) as CandidateRelease
  if (
    release.tagName !== `v${Script.version}` ||
    !Number.isSafeInteger(release.databaseId) ||
    release.databaseId <= 0 ||
    typeof release.isDraft !== "boolean" ||
    !Array.isArray(release.assets) ||
    (release.publishedAt !== null && typeof release.publishedAt !== "string") ||
    typeof release.targetCommitish !== "string"
  )
    throw new Error("invalid release identity")
  return release
}
