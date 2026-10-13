#!/usr/bin/env bun

import path from "node:path"
import semver from "semver"
import { ReleasePackageManifests } from "./prepare-release-files"

export async function resolvePublishVersion(input: {
  ref: string
  version?: string
  bump?: string
  repository?: string
}) {
  if (!/^refs\/(heads|tags)\/[^\r\n]+$/.test(input.ref)) throw new Error("publish requires a branch or tag ref")
  const tag = input.ref.startsWith("refs/tags/")
  const branch = input.ref.replace(/^refs\/heads\//, "")
  const version = (tag ? input.ref.slice("refs/tags/".length) : (input.version ?? "")).replace(/^v/, "")
  const channel = branch === "beta" ? "beta" : tag || version || input.bump || branch === "main" ? "latest" : branch
  if (version) return { version: requireVersion(version, channel), channel, bump: "" }

  const bump = input.bump?.toLowerCase() ?? ""
  if (bump && !["major", "minor", "patch"].includes(bump)) throw new Error("invalid release bump")
  // Explicit bumps retain the existing registry-based bump policy; previews retain their timestamps.
  if (bump || channel !== "latest") return { version: "", channel, bump }

  const packages = await Promise.all(
    ReleasePackageManifests.map(async (entry) => {
      const metadata = await Bun.file(
        path.join(input.repository ?? path.resolve(import.meta.dir, ".."), entry[0]),
      ).json()
      if (metadata.name !== entry[1] || typeof metadata.version !== "string")
        throw new Error(`Unexpected release package identity: ${entry[0]}`)
      return { file: entry[0], version: requireVersion(metadata.version, "latest") }
    }),
  )
  if (packages.some((entry) => entry.version !== packages[0].version))
    throw new Error(
      `Committed release package versions disagree: ${packages.map((entry) => `${entry.file}=${entry.version}`).join(", ")}`,
    )
  return { version: packages[0].version, channel: "latest", bump: "" }
}

function requireVersion(version: string, channel: string) {
  if (
    semver.valid(version) !== version ||
    (channel === "latest" && (!/^\d+\.\d+\.\d+$/.test(version) || version === "0.0.0"))
  )
    throw new Error(`invalid ${channel} release version: ${version}`)
  return version
}

if (import.meta.main) {
  const result = await resolvePublishVersion({
    ref: process.env.DAC_PUBLISH_REF ?? "",
    version: process.env.DAC_PUBLISH_VERSION,
    bump: process.env.DAC_PUBLISH_BUMP,
  })
  if (!process.env.GITHUB_OUTPUT) throw new Error("publish version resolution requires GITHUB_OUTPUT")
  await Bun.write(
    process.env.GITHUB_OUTPUT,
    `version=${result.version}\nchannel=${result.channel}\nbump=${result.bump}\n`,
  )
}
