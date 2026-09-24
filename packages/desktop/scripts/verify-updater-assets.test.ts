import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { publishUpdaterEvidence, verifyUpdaterInputs, verifyUpdaterReadback } from "./verify-updater-assets"

test("all four updater sources bind candidate version, target URL and staged asset bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepagent-updater-inputs-"))
  try {
    const sources = path.join(root, "sources")
    const assets = path.join(root, "assets")
    await mkdir(assets)
    const targets = [
      ["latest-yml-x86_64-pc-windows-msvc/latest.yml", "deepagent-code-desktop-win-x64.exe"],
      ["latest-yml-x86_64-apple-darwin/latest-mac.yml", "deepagent-code-desktop-mac-x64.zip"],
      ["latest-yml-aarch64-apple-darwin/latest-mac.yml", "deepagent-code-desktop-mac-arm64.zip"],
      ["latest-yml-x86_64-unknown-linux-gnu/latest-linux.yml", "deepagent-code-desktop-linux-x64.deb"],
    ]
    for (const [source, asset] of targets) {
      await mkdir(path.dirname(path.join(sources, source)), { recursive: true })
      await Bun.write(path.join(assets, asset), asset)
      await Bun.write(
        path.join(sources, source),
        `version: 2.0.2\nfiles:\n  - url: ${asset}\n    sha512: ${createHash("sha512").update(asset).digest("base64")}\n    size: ${Buffer.byteLength(asset)}\npath: ${asset}\nreleaseDate: '2026-09-24'\n`,
      )
    }
    await verifyUpdaterInputs(sources, assets, "2.0.2")
    const output = path.join(root, "output")
    await mkdir(output)
    const fakeGh = path.join(root, "gh")
    const uploadMarker = path.join(root, "uploaded")
    await Bun.write(fakeGh, '#!/bin/sh\ntouch "$FAKE_GH_MARKER"\n')
    await chmod(fakeGh, 0o755)
    const finalized = Bun.spawnSync(
      [process.execPath, path.join(import.meta.dir, "finalize-latest-yml.ts"), "--dry-run"],
      {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          FAKE_GH_MARKER: uploadMarker,
          LATEST_YML_DIR: sources,
          RUNNER_TEMP: output,
          GH_REPO: "example/repo",
          DEEPAGENT_CODE_VERSION: "2.0.2",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    expect(finalized.exitCode).toBe(0)
    const refused = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "finalize-latest-yml.ts")], {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        FAKE_GH_MARKER: uploadMarker,
        LATEST_YML_DIR: sources,
        RUNNER_TEMP: output,
        GH_REPO: "example/repo",
        DEEPAGENT_CODE_VERSION: "2.0.2",
        DEEPAGENT_CODE_CANDIDATE_COMMIT: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stderr.toString()).toContain("release candidate and draft identity are required")
    expect(await Bun.file(uploadMarker).exists()).toBe(false)
    for (const name of ["latest.yml", "latest-mac.yml", "latest-linux.yml"])
      expect(await Bun.file(path.join(output, name)).exists()).toBe(true)
    const macFeed = await Bun.file(path.join(output, "latest-mac.yml")).text()
    expect(macFeed).toContain("deepagent-code-desktop-mac-x64.zip")
    expect(macFeed).toContain("deepagent-code-desktop-mac-arm64.zip")
    await rm(path.join(sources, targets[1]![0]))
    await expect(verifyUpdaterInputs(sources, assets, "2.0.2")).rejects.toThrow()
    await Bun.write(path.join(sources, targets[1]![0]), `version: 2.0.1\nfiles:\n  - url: ${targets[1]![1]}\n`)
    await expect(verifyUpdaterInputs(sources, assets, "2.0.2")).rejects.toThrow("version mismatch")
    await Bun.write(
      path.join(sources, targets[1]![0]),
      `version: 2.0.2\nfiles:\n  - url: other.exe\n    sha512: x\n    size: 1\n`,
    )
    await expect(verifyUpdaterInputs(sources, assets, "2.0.2")).rejects.toThrow("missing target")
    await Bun.write(
      path.join(sources, targets[1]![0]),
      `version: 2.0.2\nfiles:\n  - url: ${targets[1]![1]}\n    sha512: ${createHash("sha512").update(targets[1]![1]).digest("base64")}\n    size: ${Buffer.byteLength(targets[1]![1])}\n`,
    )
    await Bun.write(path.join(assets, targets[1]![1]), "changed")
    await expect(verifyUpdaterInputs(sources, assets, "2.0.2")).rejects.toThrow("bytes differ")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("all four uploaded updater outputs read back byte for byte before undraft", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepagent-updater-readback-test-"))
  const previous = process.env.FAKE_GH_ASSETS
  try {
    const local = path.join(root, "local")
    const remote = path.join(root, "remote")
    await Promise.all([mkdir(local), mkdir(remote)])
    for (const name of ["latest.json", "latest.yml", "latest-mac.yml", "latest-linux.yml"]) {
      await Bun.write(path.join(local, name), name)
      await Bun.write(path.join(remote, name), name)
    }
    const gh = path.join(root, "gh")
    await Bun.write(
      gh,
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    --dir) shift; dir="$1";;\n    --pattern) shift; name="$1";;\n  esac\n  shift\ndone\ncp "$FAKE_GH_ASSETS/$name" "$dir/$name"\n',
    )
    await chmod(gh, 0o755)
    process.env.FAKE_GH_ASSETS = remote
    await verifyUpdaterReadback(local, "example/repo", "v2.0.2", gh)
    await Bun.write(path.join(remote, "latest-mac.yml"), "tampered")
    await expect(verifyUpdaterReadback(local, "example/repo", "v2.0.2", gh)).rejects.toThrow("bytes differ")
    await Bun.write(path.join(remote, "latest-mac.yml"), "latest-mac.yml")
    await rm(path.join(remote, "latest-linux.yml"))
    await expect(verifyUpdaterReadback(local, "example/repo", "v2.0.2", gh)).rejects.toThrow("download failed")
  } finally {
    if (previous === undefined) delete process.env.FAKE_GH_ASSETS
    else process.env.FAKE_GH_ASSETS = previous
    await rm(root, { recursive: true, force: true })
  }
})

test("post-gate updater evidence binds candidate and ledger, survives same-SHA retry and rejects remote drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepagent-updater-evidence-test-"))
  const previousAssets = process.env.FAKE_GH_ASSETS
  const previousTamper = process.env.FAKE_GH_TAMPER
  try {
    const local = path.join(root, "local")
    const remote = path.join(root, "remote")
    await Promise.all([mkdir(local), mkdir(remote)])
    for (const name of ["latest.json", "latest.yml", "latest-mac.yml", "latest-linux.yml"]) {
      await Bun.write(path.join(local, name), name)
      await Bun.write(path.join(remote, name), name)
    }
    const commit = "c".repeat(40)
    const tree = "d".repeat(40)
    const ledgerDigest = "e".repeat(64)
    const ledgerPath = path.join(root, "ledger.json")
    await Bun.write(ledgerPath, JSON.stringify({ ledgerDigest, manifest: { commit, tree } }))
    const gh = path.join(root, "gh")
    await Bun.write(
      gh,
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    --dir) shift; dir="$1";;\n    --pattern) shift; name="$1";;\n  esac\n  shift\ndone\ncp "$FAKE_GH_ASSETS/$name" "$dir/$name"\n',
    )
    await chmod(gh, 0o755)
    process.env.FAKE_GH_ASSETS = remote
    const input = {
      directory: local,
      repository: "example/repo",
      tag: "v2.0.2",
      commit,
      tree,
      ledgerPath,
      gh,
      upload: async (file: string) => {
        await copyFile(file, path.join(remote, path.basename(file)))
        if (process.env.FAKE_GH_TAMPER === "1") await Bun.write(path.join(remote, path.basename(file)), "tampered")
      },
    }
    await expect(
      publishUpdaterEvidence({
        ...input,
        assertCandidate: async () => {
          throw new Error("release candidate drifted")
        },
      }),
    ).rejects.toThrow("release candidate drifted")
    expect(await Bun.file(path.join(remote, "release-updater-evidence.json")).exists()).toBe(false)
    const evidence = await publishUpdaterEvidence(input)
    expect(evidence).toMatchObject({ candidateCommit: commit, candidateTree: tree, tag: "v2.0.2", ledgerDigest })
    expect(evidence.ledgerSha256).toBe(
      createHash("sha256")
        .update(await Bun.file(ledgerPath).bytes())
        .digest("hex"),
    )
    expect(evidence.metadata).toHaveLength(4)
    expect(await Bun.file(path.join(local, "release-updater-evidence.json")).text()).toBe(
      await Bun.file(path.join(remote, "release-updater-evidence.json")).text(),
    )
    await publishUpdaterEvidence(input)
    await Bun.write(path.join(local, "latest.json"), "new latest.json")
    await Bun.write(path.join(remote, "latest.json"), "new latest.json")
    expect((await publishUpdaterEvidence(input)).metadata[0]?.sha256).toBe(
      createHash("sha256").update("new latest.json").digest("hex"),
    )
    await expect(publishUpdaterEvidence({ ...input, commit: "f".repeat(40) })).rejects.toThrow("candidate differs")
    process.env.FAKE_GH_TAMPER = "1"
    await expect(publishUpdaterEvidence(input)).rejects.toThrow("evidence readback bytes differ")
  } finally {
    if (previousAssets === undefined) delete process.env.FAKE_GH_ASSETS
    else process.env.FAKE_GH_ASSETS = previousAssets
    if (previousTamper === undefined) delete process.env.FAKE_GH_TAMPER
    else process.env.FAKE_GH_TAMPER = previousTamper
    await rm(root, { recursive: true, force: true })
  }
})
