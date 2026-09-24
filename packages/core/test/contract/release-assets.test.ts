import { expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { stageReleaseAssets, verifyArchiveAgainstPackage, verifyReleaseAssets } from "../../../../script/release-assets"
import { tmpdir } from "../fixture/tmpdir"

test("final Linux and signed Windows archives match candidate packages byte for byte", async () => {
  await using root = await tmpdir()
  const commit = "c".repeat(40)
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  for (const target of ["linux", "windows"] as const) {
    const packageDir = join(root.path, target)
    const binDir = join(packageDir, "bin")
    await mkdir(binDir, { recursive: true })
    const binary = target === "linux" ? "deepagent-code" : "deepagent-code.exe"
    await Bun.write(join(binDir, binary), `${target}-binary`)
    await Bun.write(join(binDir, "owner-authorization.json"), "owner")
    await Bun.write(
      join(packageDir, "package.json"),
      JSON.stringify({
        version: "2.0.2",
        deepagentCodeBuild: {
          sourceCommit: commit,
          sourceDirty: false,
          binarySha256:
            target === "windows"
              ? "pre-signing digest"
              : new Bun.CryptoHasher("sha256").update(`${target}-binary`).digest("hex"),
        },
      }),
    )
    const archive = join(root.path, target === "linux" ? "linux.tar.gz" : "windows.zip")
    if (target === "linux") git("tar", "-czf", archive, "-C", binDir, ".")
    else git("zip", "-j", archive, join(binDir, binary), join(binDir, "owner-authorization.json"))
    await verifyArchiveAgainstPackage(archive, packageDir, commit, "2.0.2")
    await expect(verifyArchiveAgainstPackage(archive, packageDir, "other", "2.0.2")).rejects.toThrow(
      "identity mismatch",
    )
    await Bun.write(join(binDir, "owner-authorization.json"), "changed")
    await expect(verifyArchiveAgainstPackage(archive, packageDir, commit, "2.0.2")).rejects.toThrow("bytes differ")
  }
})

test("release asset manifest rejects remote byte drift", async () => {
  await using root = await tmpdir()
  const name = "deepagent-code-linux-x64.tar.gz"
  await Bun.write(join(root.path, name), "archive")
  const manifest = join(root.path, "manifest.json")
  await Bun.write(
    manifest,
    JSON.stringify({
      schemaVersion: "release-assets.v1",
      candidateCommit: "c".repeat(40),
      candidateTree: "t".repeat(40),
      version: "2.0.2",
      assets: [{ name, bytes: 7, sha256: new Bun.CryptoHasher("sha256").update("archive").digest("hex"), kind: "cli" }],
    }),
  )
  await verifyReleaseAssets(manifest, root.path, "c".repeat(40), "t".repeat(40))
  await Bun.write(join(root.path, name), "changed")
  await expect(verifyReleaseAssets(manifest, root.path)).rejects.toThrow("bytes differ")
})

test("staging covers every CLI target, owner row and six desktop targets", async () => {
  await using root = await tmpdir()
  const commit = "c".repeat(40)
  const tree = "t".repeat(40)
  const cliDist = join(root.path, "cli")
  const windowsArchives = join(root.path, "signed-windows")
  const desktopDir = join(root.path, "desktop")
  const assetsDir = join(root.path, "staged")
  const manifestPath = join(root.path, "release-assets.json")
  await Promise.all([mkdir(cliDist), mkdir(windowsArchives), mkdir(desktopDir)])
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
  ]
  for (const target of targets) {
    const name = `deepagent-code-${target}`
    const binDir = join(cliDist, name, "bin")
    await mkdir(binDir, { recursive: true })
    const binary = target.startsWith("windows") ? "deepagent-code.exe" : "deepagent-code"
    await Bun.write(join(binDir, binary), `${name}-binary`)
    await Bun.write(join(binDir, "owner-authorization.json"), "shared-owner")
    await Bun.write(
      join(cliDist, name, "package.json"),
      JSON.stringify({
        version: "2.0.2",
        deepagentCodeBuild: {
          sourceCommit: commit,
          sourceDirty: false,
          binarySha256: target.startsWith("windows")
            ? "pre-signing"
            : new Bun.CryptoHasher("sha256").update(`${name}-binary`).digest("hex"),
        },
      }),
    )
    const archive = join(
      target.startsWith("windows") ? windowsArchives : cliDist,
      `${name}${target.startsWith("linux") ? ".tar.gz" : ".zip"}`,
    )
    const command = target.startsWith("linux")
      ? ["tar", "-czf", archive, "-C", binDir, "."]
      : ["zip", "-j", archive, join(binDir, binary), join(binDir, "owner-authorization.json")]
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  await Promise.all(
    [
      "deepagent-code-desktop-win-x64.exe",
      "deepagent-code-desktop-win-arm64.exe",
      "deepagent-code-desktop-mac-x64.app.tar.gz",
      "deepagent-code-desktop-mac-arm64.app.tar.gz",
      "deepagent-code-desktop-linux-x64.deb",
      "deepagent-code-desktop-linux-arm64.deb",
    ].map((name) => Bun.write(join(desktopDir, name), name)),
  )
  await stageReleaseAssets({
    commit,
    tree,
    version: "2.0.2",
    cliDist,
    windowsArchives,
    desktopDir,
    assetsDir,
    manifestPath,
  })
  const manifest = await verifyReleaseAssets(manifestPath, assetsDir, commit, tree, true)
  expect(manifest.assets).toHaveLength(19)
  await Promise.all(
    ["ledger.json", "release-evidence-products.tar.gz", "latest.yml"].map((name) =>
      Bun.write(join(assetsDir, name), name),
    ),
  )
  await verifyReleaseAssets(manifestPath, assetsDir, commit, tree, true, true)
  await Promise.all(
    ["ledger.json", "release-evidence-products.tar.gz", "latest.yml"].map((name) => rm(join(assetsDir, name))),
  )
  await Bun.write(join(assetsDir, "stale.zip"), "old release asset")
  await expect(verifyReleaseAssets(manifestPath, assetsDir, commit, tree, true)).rejects.toThrow("unexpected files")
  await rm(join(assetsDir, "stale.zip"), { force: true })
  await Bun.write(join(assetsDir, "deepagent-code-linux-x64.tar.gz"), "tampered")
  await expect(verifyReleaseAssets(manifestPath, assetsDir, commit, tree, true)).rejects.toThrow("bytes differ")
  await Bun.write(
    join(assetsDir, "deepagent-code-linux-x64.tar.gz"),
    await Bun.file(join(cliDist, "deepagent-code-linux-x64.tar.gz")).bytes(),
  )
  const missing = "deepagent-code-desktop-win-arm64.exe"
  await Bun.write(
    manifestPath,
    JSON.stringify({ ...manifest, assets: manifest.assets?.filter((asset) => asset.name !== missing) }),
  )
  await rm(join(assetsDir, missing))
  await expect(verifyReleaseAssets(manifestPath, assetsDir, commit, tree, true)).rejects.toThrow(
    "missing a desktop platform",
  )
}, 30_000)

test("RI-51 binds staged asset bytes into the archived ledger before NO-GO", async () => {
  await using root = await tmpdir()
  const assetsDir = join(root.path, "assets")
  await mkdir(assetsDir)
  const targetNames = [
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
  ]
  const names = [
    ...targetNames.map((target) => `deepagent-code-${target}${target.startsWith("linux") ? ".tar.gz" : ".zip"}`),
    "owner-authorization.json",
    "deepagent-code-desktop-win-x64.exe",
    "deepagent-code-desktop-win-arm64.exe",
    "deepagent-code-desktop-mac-x64.app.tar.gz",
    "deepagent-code-desktop-mac-arm64.app.tar.gz",
    "deepagent-code-desktop-linux-x64.deb",
    "deepagent-code-desktop-linux-arm64.deb",
  ]
  const assets = await Promise.all(
    names.map(async (name) => {
      await Bun.write(join(assetsDir, name), name)
      return {
        name,
        bytes: Buffer.byteLength(name),
        sha256: new Bun.CryptoHasher("sha256").update(name).digest("hex"),
        kind:
          name === "owner-authorization.json" ? "owner" : name.startsWith("deepagent-code-desktop") ? "desktop" : "cli",
      }
    }),
  )
  const manifestPath = join(root.path, "release-assets.json")
  await Bun.write(
    manifestPath,
    JSON.stringify({
      schemaVersion: "release-assets.v1",
      candidateCommit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: join(import.meta.dir, "../../../..") })
        .stdout.toString()
        .trim(),
      candidateTree: Bun.spawnSync(["git", "rev-parse", "HEAD^{tree}"], { cwd: join(import.meta.dir, "../../../..") })
        .stdout.toString()
        .trim(),
      version: "2.0.2",
      assets,
    }),
  )
  const out = join(root.path, "ledger.json")
  const gate = new URL("../../script/evidence-ledger/release-gate.ts", import.meta.url)
  const child = Bun.spawn(
    [process.execPath, gate.pathname, "--asset-manifest", manifestPath, "--assets-dir", assetsDir, "--out", out],
    { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  )
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
  expect(exitCode).not.toBe(0)
  expect(stderr).toContain("NO-GO")
  const ledger = (await Bun.file(out).json()) as { manifest: { packageDigests: Record<string, string> } }
  expect(ledger.manifest.packageDigests["release-asset:deepagent-code-linux-x64.tar.gz"]).toBe(
    assets.find((asset) => asset.name === "deepagent-code-linux-x64.tar.gz")!.sha256,
  )
  const archived = join(root.path, "release-evidence-products/release-assets.json")
  expect(await Bun.file(archived).exists()).toBe(true)
  await Bun.write(archived, `${await Bun.file(archived).text()}\n`)
  const verifier = new URL("../../script/evidence-ledger/verify-ledger-products.ts", import.meta.url)
  const verify = Bun.spawn(
    [
      process.execPath,
      verifier.pathname,
      "--ledger",
      out,
      "--artifact-dir",
      join(root.path, "release-evidence-products"),
    ],
    { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  )
  expect(await verify.exited).not.toBe(0)
  expect(await new Response(verify.stderr).text()).toContain("release asset manifest bytes do not match ledger")
}, 30_000)
