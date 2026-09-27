#!/usr/bin/env bun
// Self-hosted mirror publisher — packages the built deepagent-code binaries into the flat
// download layout the `install` script consumes and (optionally) rsyncs it to the public
// mirror. This is the China-direct distribution channel; GitHub Releases remains the
// fallback source baked into the same installer.
//
// Layout produced (under DEEPAGENT_MIRROR_UPLOAD root):
//   install                                            <- repo ./install (curl-able)
//   stable.version                                     <- "2.0.0-beta.0" (plain text)
//   stable.json / {version}/manifest.json              <- tooling manifest (sha256 + size)
//   {version}/deepagent-code-{target}.zip|.tar.gz      <- one binary per archive
//   {version}/deepagent-code-{target}.zip|.tar.gz.sha256
//
// Usage:
//   bun script/publish-mirror.ts [--dry-run]
//     DEEPAGENT_MIRROR_UPLOAD=user@host:/var/www/download   rsync destination (required for upload)
//   Without DEEPAGENT_MIRROR_UPLOAD the script stages + prints the rsync command.

import { $ } from "bun"
import { fileURLToPath } from "url"
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, writeFile, cp } from "node:fs/promises"
import path from "node:path"

const dryRun = process.argv.includes("--dry-run")
const upload = process.env.DEEPAGENT_MIRROR_UPLOAD
const dir = fileURLToPath(new URL("..", import.meta.url))
const pkgDir = path.join(dir, "packages", "deepagent-code")
const distDir = path.join(pkgDir, "dist")

const pkg = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"))
const version = pkg.version as string

const entries = await readdir(distDir, { withFileTypes: true })
const targets = entries
  .filter(
    (entry) =>
      entry.isDirectory() &&
      entry.name.startsWith("deepagent-code-") &&
      !entry.name.startsWith("deepagent-code-linux-arm64") &&
      !entry.name.startsWith("deepagent-code-windows-arm64"),
  )
  .map((entry) => entry.name)

if (targets.length === 0) {
  console.error(`no built targets under ${distDir} — run: bun ./packages/deepagent-code/script/build.ts`)
  process.exit(1)
}

const archiveExt = (target: string) => (target.includes("linux-") ? ".tar.gz" : ".zip")
const stageDir = path.join(distDir, "mirror")
const versionDir = path.join(stageDir, version)
await mkdir(versionDir, { recursive: true })

const sha256 = async (file: string) => {
  const digest = createHash("sha256")
  digest.update(await readFile(file))
  return digest.digest("hex")
}

console.log(`=== staging deepagent-code ${version} (${targets.length} targets) -> ${stageDir} ===\n`)

const manifest: Record<string, { sha256: string; size: number }> = {}
for (const target of targets) {
  const binary = path.join(distDir, target, "bin", "deepagent-code")
  if (target.includes("windows-")) {
    // Windows builds ship via the npm deepagent-code-ai package + postinstall.
    continue
  }
  const stat = await readFile(binary).catch(() => undefined)
  if (stat === undefined) {
    console.warn(`skip ${target}: ${binary} missing`)
    continue
  }
  const ext = archiveExt(target)
  // dist dirs are named deepagent-code-{target}; the installer fetches $APP-$target$ext.
  const archiveName = `deepagent-code-${target.replace(/^deepagent-code-/, "")}${ext}`
  const archivePath = path.join(versionDir, archiveName)
  if (ext === ".tar.gz") {
    // tar from inside the target's bin dir so the archive contains a top-level `deepagent-code`
    await $`tar -czf ${archivePath} -C ${path.join(distDir, target, "bin")} deepagent-code`
  } else {
    await $`cd ${path.join(distDir, target, "bin")} && zip -q -X ${archivePath} deepagent-code`
  }
  const hash = await sha256(archivePath)
  const size = (await readFile(archivePath)).byteLength
  manifest[archiveName] = { sha256: hash, size }
  await writeFile(`${archivePath}.sha256`, `${hash}  ${archiveName}\n`)
  console.log(`  ${archiveName}  ${(size / 1024 / 1024).toFixed(1)} MB  ${hash.slice(0, 16)}…`)
}

const manifestBody = JSON.stringify({ version, publishedAt: Date.now(), platforms: manifest }, null, 2)
await writeFile(path.join(versionDir, "manifest.json"), manifestBody + "\n")
await writeFile(path.join(stageDir, "stable.json"), manifestBody + "\n")
await writeFile(path.join(stageDir, "stable.version"), `${version}\n`)
await cp(path.join(dir, "install"), path.join(stageDir, "install"))

console.log(`\nstaged: ${stageDir}`)
if (dryRun) {
  console.log("dry-run: skipping upload")
  process.exit(0)
}

if (!upload) {
  console.log(`\nDEEPAGENT_MIRROR_UPLOAD not set. Upload manually:\n`)
  console.log(`  rsync -av --delete ${stageDir}/ ${upload ?? "user@host:/var/www/download"}/`)
  process.exit(0)
}

console.log(`\n=== rsync -> ${upload} ===\n`)
await $`rsync -av --delete ${stageDir}/ ${upload}/`
console.log(`\ndone. install with:`)
console.log(`  curl -fsSL https://ai.deepagent.ltd/download/install | bash`)
