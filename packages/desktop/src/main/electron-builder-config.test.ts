import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

import config from "../../electron-builder.config"

test("Desktop ships the supplied owner authorization at the runtime Resources root", async () => {
  const previous = process.env.DEEPAGENT_CODE_RELEASE_OWNER_AUTHORIZATION_FILE
  const previousKey = process.env.DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY
  const previousRequired = process.env.DEEPAGENT_CODE_RELEASE_NATIVE_REQUIRED
  try {
    delete process.env.DEEPAGENT_CODE_RELEASE_NATIVE_REQUIRED
    for (const file of [undefined, "/tmp/dac-owner-input/owner-authorization.json"]) {
      if (file === undefined) delete process.env.DEEPAGENT_CODE_RELEASE_OWNER_AUTHORIZATION_FILE
      if (file !== undefined) process.env.DEEPAGENT_CODE_RELEASE_OWNER_AUTHORIZATION_FILE = file
      if (file === undefined) delete process.env.DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY
      if (file !== undefined) process.env.DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY = "/tmp/dac-owner-input/public.pem"
      const module = await import(`../../electron-builder.config.ts?owner=${encodeURIComponent(file ?? "none")}`)
      expect(module.default.extraResources).toEqual([
        {
          from: "native/",
          to: "native/",
          filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
        },
        ...(file ? [{ from: file, to: "owner-authorization.json" }] : []),
      ])
    }
    delete process.env.DEEPAGENT_CODE_RELEASE_OWNER_AUTHORIZATION_FILE
    await expect(import("../../electron-builder.config.ts?owner=incomplete-key")).rejects.toThrow(
      "Release owner public key and authorization file must be supplied together",
    )
    delete process.env.DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY
    process.env.DEEPAGENT_CODE_RELEASE_OWNER_AUTHORIZATION_FILE = "/tmp/dac-owner-input/owner-authorization.json"
    await expect(import("../../electron-builder.config.ts?owner=incomplete-row")).rejects.toThrow(
      "Release owner public key and authorization file must be supplied together",
    )
    delete process.env.DEEPAGENT_CODE_RELEASE_OWNER_AUTHORIZATION_FILE
    process.env.DEEPAGENT_CODE_RELEASE_NATIVE_REQUIRED = "1"
    await expect(import("../../electron-builder.config.ts?owner=release-missing")).rejects.toThrow(
      "Release owner public key and authorization file must be supplied together",
    )
  } finally {
    if (previous === undefined) delete process.env.DEEPAGENT_CODE_RELEASE_OWNER_AUTHORIZATION_FILE
    if (previous !== undefined) process.env.DEEPAGENT_CODE_RELEASE_OWNER_AUTHORIZATION_FILE = previous
    if (previousKey === undefined) delete process.env.DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY
    if (previousKey !== undefined) process.env.DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY = previousKey
    if (previousRequired === undefined) delete process.env.DEEPAGENT_CODE_RELEASE_NATIVE_REQUIRED
    if (previousRequired !== undefined) process.env.DEEPAGENT_CODE_RELEASE_NATIVE_REQUIRED = previousRequired
  }
})

// W-01 §2.2.6: the Windows packaging contract. The NSIS installer must stay
// per-user (no elevation), guided, and own the user-PATH include script; the
// updater feeds on GitHub latest.yml with the Trusted-Signing-compatible
// signature verification setting. These fields cannot be exercised on a mac
// dev machine, so this pins their configuration values instead.
describe("electron-builder Windows packaging config", () => {
  const win = (config as { win: Record<string, unknown> }).win
  const nsis = (config as { nsis: Record<string, unknown> }).nsis

  test("NSIS stays a guided per-user installer that manages the user PATH", () => {
    expect(nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      include: "resources/installer.nsh",
    })
  })

  test("the user-PATH include script exists with install and uninstall hooks", async () => {
    const script = await Bun.file(new URL("../../resources/installer.nsh", import.meta.url)).text()
    expect(script).toContain("!macro customInstall")
    expect(script).toContain("!macro customUnInstall")
    // User hive only — the machine PATH must never be touched (VSCode parity).
    expect(script).toContain('HKCU "Environment" "Path"')
    expect(script).not.toContain("HKLM")
  })

  test("targets NSIS with a custom signing hook and updater-compatible verification", () => {
    expect(win.target).toEqual(["nsis"])
    expect(typeof (win.signtoolOptions as { sign?: unknown }).sign).toBe("function")
    expect(win.verifyUpdateCodeSignature).toBe(false)
  })

  test("published channels expose a GitHub feed for electron-updater", async () => {
    for (const channel of ["beta", "prod"]) {
      process.env.DEEPAGENT_CODE_CHANNEL = channel
      // The config resolves its channel from the environment at import time,
      // so import per channel under a cache-busting query string.
      const mod = (await import(`../../electron-builder.config.ts?channel=${channel}`)) as {
        default: { publish?: { provider?: string } }
      }
      expect(mod.default.publish?.provider).toBe("github")
    }
    delete process.env.DEEPAGENT_CODE_CHANNEL
  })

  test("Linux channels resolve a safe real executable for the offline installation contract", async () => {
    const previous = process.env.DEEPAGENT_CODE_CHANNEL
    try {
      for (const [channel, executable] of [
        ["dev", "deepagent-code-dev"],
        ["beta", "deepagent-code-beta"],
        ["prod", "deepagent-code"],
      ]) {
        process.env.DEEPAGENT_CODE_CHANNEL = channel
        const module = await import(`../../electron-builder.config.ts?linux=${channel}`)
        const { LinuxPackager, Packager } = await import("electron-builder")
        const info = new Packager({
          projectDir: fileURLToPath(new URL("../..", import.meta.url)),
          config: module.default,
        })
        await info.validateConfig()
        const packager = new LinuxPackager(info)
        expect(packager.executableName).toBe(executable)
        expect(packager.executableName).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
        expect(module.default.linux?.target).toEqual(["deb"])
      }
    } finally {
      if (previous === undefined) delete process.env.DEEPAGENT_CODE_CHANNEL
      if (previous !== undefined) process.env.DEEPAGENT_CODE_CHANNEL = previous
    }
  })
})
