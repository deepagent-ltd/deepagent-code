#!/usr/bin/env bun
import { copyFile, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const sha256 = async (file: string) => new Bun.CryptoHasher("sha256").update(await Bun.file(file).bytes()).digest("hex")
const targets = [
  "linux-arm64",
  "linux-x64",
  "linux-x64-baseline",
  "linux-arm64-musl",
  "linux-x64-musl",
  "linux-x64-baseline-musl",
  "darwin-arm64",
  "darwin-x64",
  "darwin-x64-baseline",
  "windows-arm64",
  "windows-x64",
  "windows-x64-baseline",
].map((target) => `deepagent-code-${target}`)

async function files(directory: string, root = directory): Promise<string[]> {
  return (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map((entry) => {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) return files(file, root)
        if (entry.isFile()) return Promise.resolve([path.relative(root, file).replaceAll(path.sep, "/")])
        throw new Error(`release asset contains a non-regular file: ${file}`)
      }),
    )
  )
    .flat()
    .sort()
}

const command = (args: string[]) => {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}

export async function verifyArchiveAgainstPackage(
  archive: string,
  packageDir: string,
  candidateCommit: string,
  version: string,
) {
  const metadata = (await Bun.file(path.join(packageDir, "package.json")).json()) as {
    version?: string
    deepagentCodeBuild?: { sourceCommit?: string; sourceDirty?: boolean; binarySha256?: string }
  }
  if (
    metadata.version !== version ||
    metadata.deepagentCodeBuild?.sourceCommit !== candidateCommit ||
    metadata.deepagentCodeBuild.sourceDirty !== false
  )
    throw new Error(`release archive package identity mismatch: ${archive}`)
  const binDir = path.join(packageDir, "bin")
  const binFiles = await files(binDir)
  const binary = archive.endsWith(".zip") && archive.includes("windows") ? "deepagent-code.exe" : "deepagent-code"
  if (!binFiles.includes(binary) || !binFiles.includes("owner-authorization.json"))
    throw new Error(`release archive package is missing binary or owner row: ${archive}`)
  if (
    !archive.includes("windows") &&
    metadata.deepagentCodeBuild.binarySha256 !== (await sha256(path.join(binDir, binary)))
  )
    throw new Error(`release archive package binary metadata mismatch: ${archive}`)
  const temporary = await mkdtemp(path.join(os.tmpdir(), "deepagent-release-archive-"))
  try {
    const listing = command(archive.endsWith(".zip") ? ["unzip", "-Z", "-1", archive] : ["tar", "-tzf", archive])
      .split("\n")
      .map((entry) => entry.replace(/^\.\//, ""))
      .filter(Boolean)
    if (listing.some((entry) => entry.startsWith("/") || entry.split("/").includes("..")))
      throw new Error(`release archive contains an unsafe path: ${archive}`)
    command(
      archive.endsWith(".zip") ? ["unzip", "-qq", archive, "-d", temporary] : ["tar", "-xzf", archive, "-C", temporary],
    )
    const extracted = await files(temporary)
    if (extracted.join("\n") !== binFiles.join("\n"))
      throw new Error(`release archive files differ from package bin: ${archive}`)
    for (const file of binFiles)
      if ((await sha256(path.join(temporary, file))) !== (await sha256(path.join(binDir, file))))
        throw new Error(`release archive bytes differ from package bin: ${archive}/${file}`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function verifyReleaseAssets(
  manifestPath: string,
  assetsDir: string,
  candidateCommit?: string,
  candidateTree?: string,
  requireComplete = false,
  allowLedgerAssets = false,
) {
  const manifest = (await Bun.file(manifestPath).json()) as {
    schemaVersion?: string
    candidateCommit?: string
    candidateTree?: string
    version?: string
    assets?: { name: string; bytes: number; sha256: string; kind: string }[]
  }
  if (
    manifest.schemaVersion !== "release-assets.v1" ||
    !manifest.candidateCommit ||
    !manifest.candidateTree ||
    !manifest.version ||
    !Array.isArray(manifest.assets)
  )
    throw new Error("release asset manifest is malformed")
  if (candidateCommit && manifest.candidateCommit !== candidateCommit)
    throw new Error("release asset candidate commit mismatch")
  if (candidateTree && manifest.candidateTree !== candidateTree)
    throw new Error("release asset candidate tree mismatch")
  if (new Set(manifest.assets.map((asset) => asset.name)).size !== manifest.assets.length)
    throw new Error("release asset names are duplicated")
  if (manifest.assets.some((asset) => !["cli", "desktop", "owner"].includes(asset.kind)))
    throw new Error("release asset kind is invalid")
  if (requireComplete) {
    const cli = manifest.assets
      .filter((asset) => asset.kind === "cli")
      .map((asset) => asset.name)
      .toSorted()
    const expected = targets.map((name) => `${name}${name.includes("linux") ? ".tar.gz" : ".zip"}`).toSorted()
    if (cli.join("\n") !== expected.join("\n")) throw new Error("release asset manifest is missing a CLI platform")
    if (
      manifest.assets.filter((asset) => asset.kind === "owner" && asset.name === "owner-authorization.json").length !==
      1
    )
      throw new Error("release asset manifest is missing owner authorization")
    const desktop = manifest.assets.filter((asset) => asset.kind === "desktop").map((asset) => asset.name)
    if (
      !desktop.some((name) => /\.exe$/.test(name)) ||
      !desktop.some((name) => /\.dmg$|\.app\.tar\.gz$/.test(name)) ||
      !desktop.some((name) => /\.AppImage$|\.deb$|\.rpm$/.test(name))
    )
      throw new Error("release asset manifest is missing a desktop platform")
    const expectedNames = manifest.assets.map((asset) => asset.name)
    const allowed = allowLedgerAssets
      ? [...expectedNames, "ledger.json", "release-evidence-products.tar.gz"]
      : expectedNames
    if ((await readdir(assetsDir)).toSorted().join("\n") !== allowed.toSorted().join("\n"))
      throw new Error("release asset directory has missing or unexpected files")
  }
  for (const asset of manifest.assets) {
    if (!/^[A-Za-z0-9._-]+$/.test(asset.name) || !(await lstat(path.join(assetsDir, asset.name))).isFile())
      throw new Error(`release asset path is invalid: ${asset.name}`)
    const file = Bun.file(path.join(assetsDir, asset.name))
    if (file.size !== asset.bytes || (await sha256(path.join(assetsDir, asset.name))) !== asset.sha256)
      throw new Error(`release asset bytes differ from manifest: ${asset.name}`)
  }
  return manifest
}

export async function stageReleaseAssets(input: {
  commit: string
  tree: string
  version: string
  cliDist: string
  windowsArchives: string
  desktopDir: string
  assetsDir: string
  manifestPath: string
}) {
  await mkdir(input.assetsDir, { recursive: true })
  if ((await readdir(input.assetsDir)).length) throw new Error("release asset staging directory is not empty")
  const cli = await Promise.all(
    targets.map(async (name) => {
      const archive = path.join(
        name.includes("linux") ? input.cliDist : name.includes("windows") ? input.windowsArchives : input.cliDist,
        `${name}${name.includes("linux") ? ".tar.gz" : ".zip"}`,
      )
      await verifyArchiveAgainstPackage(archive, path.join(input.cliDist, name), input.commit, input.version)
      return archive
    }),
  )
  const desktop = (await readdir(input.desktopDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(exe|blockmap|dmg|zip|AppImage|deb|rpm)$|\.app\.tar\.gz$/.test(entry.name))
    .map((entry) => path.join(input.desktopDir, entry.name))
  if (
    !desktop.some((file) => /\.exe$/.test(file)) ||
    !desktop.some((file) => /\.dmg$|\.app\.tar\.gz$/.test(file)) ||
    !desktop.some((file) => /\.AppImage$|\.deb$|\.rpm$/.test(file))
  )
    throw new Error("release desktop assets are missing a platform")
  const owner = path.join(input.cliDist, "deepagent-code-linux-x64/bin/owner-authorization.json")
  const ownerDigest = await sha256(owner)
  for (const name of targets)
    if ((await sha256(path.join(input.cliDist, name, "bin/owner-authorization.json"))) !== ownerDigest)
      throw new Error(`release owner authorization differs across platforms: ${name}`)
  const sources = [...cli, ...desktop, owner]
  if (new Set(sources.map((file) => path.basename(file))).size !== sources.length)
    throw new Error("release asset filenames collide")
  const assets = await Promise.all(
    sources.map(async (source) => {
      const name = path.basename(source)
      const destination = path.join(input.assetsDir, name)
      await copyFile(source, destination)
      return {
        name,
        bytes: Bun.file(destination).size,
        sha256: await sha256(destination),
        kind: source === owner ? "owner" : cli.includes(source) ? "cli" : "desktop",
      }
    }),
  )
  const manifest = {
    schemaVersion: "release-assets.v1",
    candidateCommit: input.commit,
    candidateTree: input.tree,
    version: input.version,
    assets: assets.toSorted((a, b) => a.name.localeCompare(b.name)),
  }
  await Bun.write(input.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await verifyReleaseAssets(input.manifestPath, input.assetsDir, input.commit, input.tree, true)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const option = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined)
  const manifestPath = option("--manifest")
  const assetsDir = option("--assets-dir")
  if (!manifestPath || !assetsDir) throw new Error("release-assets.ts requires --manifest and --assets-dir")
  if (args.includes("--verify"))
    await verifyReleaseAssets(
      manifestPath,
      assetsDir,
      option("--commit"),
      option("--tree"),
      true,
      args.includes("--allow-ledger-assets"),
    )
  else {
    const commit = option("--commit")
    const tree = option("--tree")
    const version = option("--version")
    const cliDist = option("--cli-dist")
    const windowsArchives = option("--windows-archives")
    const desktopDir = option("--desktop-dir")
    if (!commit || !tree || !version || !cliDist || !windowsArchives || !desktopDir)
      throw new Error("release-assets.ts staging requires commit/tree/version/cli-dist/windows-archives/desktop-dir")
    await stageReleaseAssets({ commit, tree, version, cliDist, windowsArchives, desktopDir, assetsDir, manifestPath })
  }
}
