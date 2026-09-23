import { describe, expect, test } from "bun:test"

import config from "../../electron-builder.config"

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
})
