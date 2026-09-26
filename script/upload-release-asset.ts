#!/usr/bin/env bun

import { lstat } from "node:fs/promises"
import path from "node:path"
import { assertReleaseDraftFromEnv } from "./assert-release-candidate"

export async function uploadReleaseAsset(input: {
  file: string
  releaseID: string
  repository: string
  tag: string
  token: string
  checkCandidate: () => Promise<void>
  apiBaseURL?: string
  uploadOrigin?: string
  request?: typeof fetch
}) {
  if (!/^\d+$/.test(input.releaseID) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
    throw new Error("release ID or repository is invalid")
  const name = path.basename(input.file)
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name) || name.endsWith("."))
    throw new Error(`release asset name is unsafe: ${name}`)
  if (!(await lstat(input.file)).isFile()) throw new Error(`release asset is not a regular file: ${name}`)
  const file = Bun.file(input.file)
  const request = input.request ?? fetch
  const api = new URL(input.apiBaseURL ?? "https://api.github.com")
  const releasePath = `/repos/${input.repository}/releases/${input.releaseID}`
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${input.token}`,
  }
  const getRelease = async () => {
    const response = await request(new URL(releasePath, api), { headers, redirect: "error" })
    if (!response.ok) throw new Error(`release ID ${input.releaseID} could not be read: HTTP ${response.status}`)
    const release = (await response.json()) as {
      id?: number
      tag_name?: string
      draft?: boolean
      upload_url?: string
    }
    if (String(release.id) !== input.releaseID || release.tag_name !== input.tag || !release.draft)
      throw new Error("release ID, tag or draft state changed")
    if (!release.upload_url) throw new Error("release upload URL is missing")
    const upload = new URL(release.upload_url.split("{")[0])
    if (
      upload.origin !== (input.uploadOrigin ?? "https://uploads.github.com") ||
      upload.pathname !== `${releasePath}/assets` ||
      upload.search
    )
      throw new Error("release upload URL does not belong to frozen release ID")
    return upload
  }

  await input.checkCandidate()
  await getRelease()
  const existing: { id: number; name: string }[] = []
  for (let page = 1; page <= 100; page++) {
    const url = new URL(`${releasePath}/assets`, api)
    url.searchParams.set("per_page", "100")
    url.searchParams.set("page", String(page))
    const response = await request(url, { headers, redirect: "error" })
    if (!response.ok) throw new Error(`release assets could not be listed: HTTP ${response.status}`)
    const assets = (await response.json()) as { id: number; name: string }[]
    if (
      !Array.isArray(assets) ||
      assets.some((asset) => !Number.isSafeInteger(asset.id) || typeof asset.name !== "string")
    )
      throw new Error("release asset list is malformed")
    existing.push(...assets.filter((asset) => asset.name === name))
    if (assets.length < 100) break
    if (page === 100) throw new Error("release asset list exceeds pagination limit")
  }
  for (const asset of existing) {
    await input.checkCandidate()
    await getRelease()
    const response = await request(new URL(`/repos/${input.repository}/releases/assets/${asset.id}`, api), {
      method: "DELETE",
      headers,
      redirect: "error",
    })
    if (response.status !== 204 && response.status !== 404)
      throw new Error(`release asset ${asset.id} could not be replaced: HTTP ${response.status}`)
  }

  await input.checkCandidate()
  const upload = await getRelease()
  upload.searchParams.set("name", name)
  const response = await request(upload, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.size),
    },
    body: file.stream(),
    redirect: "error",
  })
  if (response.status !== 201) throw new Error(`release asset ${name} upload failed: HTTP ${response.status}`)
  const asset = (await response.json()) as { id?: number; name?: string; size?: number; state?: string }
  if (!Number.isSafeInteger(asset.id) || asset.name !== name || asset.size !== file.size || asset.state !== "uploaded")
    throw new Error(`release asset ${name} upload response does not match local file`)
  await input.checkCandidate()
  return asset.id
}

if (import.meta.main) {
  const files = process.argv.slice(2)
  const releaseID = process.env.DEEPAGENT_CODE_RELEASE
  const repository = process.env.GH_REPO
  const version = process.env.DEEPAGENT_CODE_VERSION
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (!files.length || !releaseID || !repository || !version || !token)
    throw new Error("usage: upload-release-asset.ts <file>... (release ID, repository and token required)")
  for (const file of files)
    await uploadReleaseAsset({
      file,
      releaseID,
      repository,
      tag: `v${version}`,
      token,
      checkCandidate: () => assertReleaseDraftFromEnv(),
    })
}
