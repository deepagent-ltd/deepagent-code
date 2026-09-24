#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { lstat, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const sources = [
  ["latest-yml-x86_64-pc-windows-msvc/latest.yml", "deepagent-code-desktop-win-x64.exe"],
  ["latest-yml-aarch64-pc-windows-msvc/latest.yml", "deepagent-code-desktop-win-arm64.exe"],
  ["latest-yml-x86_64-apple-darwin/latest-mac.yml", "deepagent-code-desktop-mac-x64.zip"],
  ["latest-yml-aarch64-apple-darwin/latest-mac.yml", "deepagent-code-desktop-mac-arm64.zip"],
  ["latest-yml-x86_64-unknown-linux-gnu/latest-linux.yml", "deepagent-code-desktop-linux-x64.deb"],
  ["latest-yml-aarch64-unknown-linux-gnu/latest-linux-arm64.yml", "deepagent-code-desktop-linux-arm64.deb"],
] as const
const outputs = ["latest.json", "latest.yml", "latest-mac.yml", "latest-linux.yml", "latest-linux-arm64.yml"]
const evidenceName = "release-updater-evidence.json"

export async function verifyUpdaterInputs(directory: string, assetsDir: string, version: string) {
  for (const [source, requiredAsset] of sources) {
    const content = await Bun.file(path.join(directory, source)).text()
    if (content.match(/^version:\s*(\S+)\s*$/m)?.[1] !== version)
      throw new Error(`updater source version mismatch: ${source}`)
    const rows: { url: string; sha512?: string; size?: number }[] = []
    let current: (typeof rows)[number] | undefined
    for (const line of content.split(/\r?\n/)) {
      const url = line.match(/^\s*- url:\s*(\S+)\s*$/)?.[1]
      if (url) {
        current = { url }
        rows.push(current)
      }
      if (line && !/^\s/.test(line)) current = undefined
      if (!current) continue
      const digest = line.match(/^\s+sha512:\s*(\S+)\s*$/)?.[1]
      if (digest) current.sha512 = digest
      const size = line.match(/^\s+size:\s*(\S+)\s*$/)?.[1]
      if (size) current.size = Number(size)
    }
    if (!rows.some((row) => row.url === requiredAsset))
      throw new Error(`updater source is missing target ${requiredAsset}: ${source}`)
    for (const row of rows) {
      if (!/^[A-Za-z0-9._-]+$/.test(row.url)) throw new Error(`updater asset URL is invalid: ${row.url}`)
      const file = path.join(assetsDir, row.url)
      if (!(await lstat(file)).isFile()) throw new Error(`updater asset is not a regular file: ${row.url}`)
      const bytes = await Bun.file(file).bytes()
      if (row.size !== bytes.byteLength || row.sha512 !== createHash("sha512").update(bytes).digest("base64"))
        throw new Error(`updater source bytes differ from staged asset: ${row.url}`)
    }
  }
}

export async function verifyUpdaterReadback(directory: string, repository: string, tag: string, gh = "gh") {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "deepagent-updater-readback-"))
  const verified: { name: string; bytes: number; sha256: string }[] = []
  try {
    for (const name of outputs) {
      const local = path.join(directory, name)
      if (!(await lstat(local)).isFile()) throw new Error(`updater output is missing: ${name}`)
      const child = Bun.spawnSync(
        [gh, "release", "download", tag, "--repo", repository, "--dir", temporary, "--pattern", name],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
      )
      if (child.exitCode !== 0) throw new Error(`updater asset download failed: ${name}: ${child.stderr.toString()}`)
      if (!(await lstat(path.join(temporary, name))).isFile()) throw new Error(`updater readback is missing: ${name}`)
      const localBytes = await Bun.file(local).bytes()
      if (!Buffer.from(localBytes).equals(Buffer.from(await Bun.file(path.join(temporary, name)).bytes())))
        throw new Error(`updater readback bytes differ: ${name}`)
      const sha256 = createHash("sha256").update(localBytes).digest("hex")
      console.log(`updater readback ${name} sha256:${sha256}`)
      verified.push({ name, bytes: localBytes.byteLength, sha256 })
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return verified
}

export async function publishUpdaterEvidence(input: {
  directory: string
  repository: string
  tag: string
  commit: string
  tree: string
  ledgerPath: string
  gh?: string
}) {
  const ledgerBytes = await Bun.file(input.ledgerPath).bytes()
  const ledger = JSON.parse(Buffer.from(ledgerBytes).toString("utf8")) as {
    ledgerDigest?: string
    manifest?: { commit?: string; tree?: string }
  }
  if (ledger.manifest?.commit !== input.commit || ledger.manifest.tree !== input.tree)
    throw new Error("updater evidence candidate differs from RI-51 ledger")
  if (!ledger.ledgerDigest || !/^[a-f0-9]{64}$/.test(ledger.ledgerDigest))
    throw new Error("updater evidence RI-51 ledger digest is invalid")
  const metadata = await verifyUpdaterReadback(input.directory, input.repository, input.tag, input.gh)
  const evidence = {
    schemaVersion: "release-updater-evidence.v1",
    candidateCommit: input.commit,
    candidateTree: input.tree,
    tag: input.tag,
    ledgerDigest: ledger.ledgerDigest,
    ledgerSha256: createHash("sha256").update(ledgerBytes).digest("hex"),
    metadata,
  }
  const file = path.join(input.directory, evidenceName)
  await Bun.write(file, `${JSON.stringify(evidence, null, 2)}\n`)
  const gh = input.gh ?? "gh"
  const upload = Bun.spawnSync([gh, "release", "upload", input.tag, file, "--clobber", "--repo", input.repository], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  })
  if (upload.exitCode !== 0) throw new Error(`updater evidence upload failed: ${upload.stderr.toString()}`)
  const temporary = await mkdtemp(path.join(os.tmpdir(), "deepagent-updater-evidence-readback-"))
  try {
    const download = Bun.spawnSync(
      [gh, "release", "download", input.tag, "--repo", input.repository, "--dir", temporary, "--pattern", evidenceName],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    )
    if (download.exitCode !== 0) throw new Error(`updater evidence download failed: ${download.stderr.toString()}`)
    if (!(await lstat(path.join(temporary, evidenceName))).isFile())
      throw new Error("updater evidence readback is missing")
    if (
      !Buffer.from(await Bun.file(file).bytes()).equals(
        Buffer.from(await Bun.file(path.join(temporary, evidenceName)).bytes()),
      )
    )
      throw new Error("updater evidence readback bytes differ")
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  console.log(
    `updater evidence ${evidenceName} sha256:${createHash("sha256")
      .update(await Bun.file(file).bytes())
      .digest("hex")}`,
  )
  return evidence
}
