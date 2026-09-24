import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { verifyUpdaterInputs, verifyUpdaterReadback } from "./verify-updater-assets"

test("all six updater sources bind candidate version, target URL and staged asset bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepagent-updater-inputs-"))
  try {
    const sources = path.join(root, "sources")
    const assets = path.join(root, "assets")
    await mkdir(assets)
    const targets = [
      ["latest-yml-x86_64-pc-windows-msvc/latest.yml", "deepagent-code-desktop-win-x64.exe"],
      ["latest-yml-aarch64-pc-windows-msvc/latest.yml", "deepagent-code-desktop-win-arm64.exe"],
      ["latest-yml-x86_64-apple-darwin/latest-mac.yml", "deepagent-code-desktop-mac-x64.zip"],
      ["latest-yml-aarch64-apple-darwin/latest-mac.yml", "deepagent-code-desktop-mac-arm64.zip"],
      ["latest-yml-x86_64-unknown-linux-gnu/latest-linux.yml", "deepagent-code-desktop-linux-x64.deb"],
      ["latest-yml-aarch64-unknown-linux-gnu/latest-linux-arm64.yml", "deepagent-code-desktop-linux-arm64.deb"],
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
    await Bun.write(fakeGh, "#!/bin/sh\nexit 0\n")
    await chmod(fakeGh, 0o755)
    const finalized = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "finalize-latest-yml.ts")], {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        LATEST_YML_DIR: sources,
        RUNNER_TEMP: output,
        GH_REPO: "example/repo",
        DEEPAGENT_CODE_VERSION: "2.0.2",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(finalized.exitCode).toBe(0)
    for (const name of ["latest.yml", "latest-mac.yml", "latest-linux.yml", "latest-linux-arm64.yml"])
      expect(await Bun.file(path.join(output, name)).exists()).toBe(true)
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

test("all five uploaded updater outputs read back byte for byte before undraft", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepagent-updater-readback-test-"))
  const previous = process.env.FAKE_GH_ASSETS
  try {
    const local = path.join(root, "local")
    const remote = path.join(root, "remote")
    await Promise.all([mkdir(local), mkdir(remote)])
    for (const name of ["latest.json", "latest.yml", "latest-mac.yml", "latest-linux.yml", "latest-linux-arm64.yml"]) {
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
    await rm(path.join(remote, "latest-linux-arm64.yml"))
    await expect(verifyUpdaterReadback(local, "example/repo", "v2.0.2", gh)).rejects.toThrow("download failed")
  } finally {
    if (previous === undefined) delete process.env.FAKE_GH_ASSETS
    else process.env.FAKE_GH_ASSETS = previous
    await rm(root, { recursive: true, force: true })
  }
})
