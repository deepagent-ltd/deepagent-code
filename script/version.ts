#!/usr/bin/env bun

import { Script } from "@deepagent-code/script"
import { $ } from "bun"
import { assertReleaseCandidate } from "./assert-release-candidate"
import { prepareReleaseFiles } from "./prepare-release-files"

const output = [`version=${Script.version}`]
const sourceSha = process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim()
let candidateSha = (await $`git rev-parse HEAD`.text()).trim()

if (!Script.preview) {
  await $`bun script/changelog.ts --to ${sourceSha}`.cwd(process.cwd())
  const file = `${process.cwd()}/UPCOMING_CHANGELOG.md`
  const body = await Bun.file(file)
    .text()
    .catch(() => "No notable changes")
  const dir = process.env.RUNNER_TEMP ?? "/tmp"
  const notesFile = `${dir}/deepagent-code-release-notes.txt`
  await Bun.write(notesFile, body)
  await prepareReleaseFiles(Script.version, process.cwd())
  await $`git add -A`
  if ((await $`git diff --cached --quiet`.nothrow()).exitCode !== 0)
    await $`git commit -m ${`chore(release): prepare v${Script.version}`}`
  if ((await $`git status --porcelain --untracked-files=all`.text()).trim())
    throw new Error("release candidate source tree is dirty after preparation")
  candidateSha = (await $`git rev-parse HEAD`.text()).trim()
  const candidateRef = `refs/heads/release-candidates/v${Script.version}`
  if ((await $`git ls-remote --exit-code origin ${candidateRef}`.nothrow()).exitCode === 0)
    throw new Error(`release candidate ref already exists: ${candidateRef}`)
  await $`git push origin ${`HEAD:${candidateRef}`}`
  await $`gh release create v${Script.version} -d --target ${candidateSha} --title "v${Script.version}" --notes-file ${notesFile} --repo ${process.env.GH_REPO}`
  await assertReleaseCandidate({
    repository: process.cwd(),
    commit: candidateSha,
    tree: (await $`git rev-parse HEAD^{tree}`.text()).trim(),
    tag: `v${Script.version}`,
  })
  const release = await $`gh release view v${Script.version} --json tagName,databaseId`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
} else if (Script.channel === "beta") {
  await $`gh release create v${Script.version} -d --title "v${Script.version}" --repo ${process.env.GH_REPO}`
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
