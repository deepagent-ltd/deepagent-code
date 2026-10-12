import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { packageEnvironment } from "./package"

test("explicit unsigned packaging skips the signing file and inherited credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dac-package-env-"))
  try {
    const signingFile = path.join(directory, "signing.env")
    await Bun.write(signingFile, "malformed-private-signing-value")
    const environment = {
      DEEPAGENT_CODE_ALLOW_UNSIGNED: "1",
      CSC_NAME: "private-subject",
      APPLE_ID: "private-account",
      APPLE_API_KEY: "private-key",
      WIN_CSC_LINK: "private-link",
      PATH: "/existing/bin",
    }
    const result = await packageEnvironment({ environment, args: ["--mac"], platform: "darwin", signingFile })
    expect(result.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false")
    expect(result.CSC_NAME).toBeUndefined()
    expect(result.APPLE_ID).toBeUndefined()
    expect(result.APPLE_API_KEY).toBeUndefined()
    expect(result.WIN_CSC_LINK).toBeUndefined()
    expect(result.PATH).toBe("/existing/bin")
    expect(environment.CSC_NAME).toBe("private-subject")
    expect(await Bun.file(signingFile).text()).toBe("malformed-private-signing-value")
    // CI can invoke electron-builder directly, without the wrapper's cleaned environment.
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import config from ${JSON.stringify(path.resolve(import.meta.dir, "../electron-builder.config.ts"))}; console.log(JSON.stringify({ identity: config.mac?.identity, notarize: config.mac?.notarize, dmgSign: config.dmg?.sign }))`,
      ],
      {
        env: { ...environment, PATH: process.env.PATH, DEEPAGENT_CODE_ALLOW_UNSIGNED: "true" },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const output = await new Response(child.stdout).text()
    const error = await new Response(child.stderr).text()
    expect(await child.exited, error).toBe(0)
    expect(JSON.parse(output)).toEqual({ identity: null, notarize: false, dmgSign: false })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("signed packaging preserves explicit values, normalizes identity and rejects missing configuration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dac-package-env-"))
  try {
    const signingFile = path.join(directory, "signing.env")
    await Bun.write(
      signingFile,
      "APPLE_ID=file-account\nAPPLE_APP_SPECIFIC_PASSWORD='file-password'\nAPPLE_TEAM_ID=team\nCSC_NAME=\"Developer ID Application: subject\"\n",
    )
    const result = await packageEnvironment({
      environment: { APPLE_ID: "explicit-account" },
      args: ["--mac"],
      platform: "linux",
      signingFile,
    })
    expect(result.APPLE_ID).toBe("explicit-account")
    expect(result.CSC_NAME).toBe("subject")
    expect(result.APPLE_APP_SPECIFIC_PASSWORD).toBe("file-password")
    await expect(
      packageEnvironment({
        environment: {},
        args: ["--mac"],
        platform: "linux",
        signingFile: path.join(directory, "absent"),
      }),
    ).rejects.toThrow("Missing macOS signing config")
    await Bun.write(signingFile, "private-value-without-equals")
    await expect(packageEnvironment({ environment: {}, args: [], platform: "linux", signingFile })).rejects.toThrow(
      "Invalid signing.env entry at line 1",
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
