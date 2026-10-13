import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { generateKeyPairSync } from "node:crypto"
import { completeMacPackageEnvironment } from "./complete-mac-package"

async function fixture() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-complete-package-")))
  const keys = generateKeyPairSync("ed25519")
  const pin = keys.publicKey.export({ type: "spki", format: "pem" }).toString()
  const publisher = path.join(directory, "publisher.pem")
  await fs.writeFile(publisher, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
  const environment = { DEEPAGENT_CODE_ALLOW_UNSIGNED: "1", DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY: pin,
    DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY: publisher, DEEPAGENT_CODE_RELEASE_ID: "dac-2.0.3-candidate",
    DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY: "-", CSC_NAME: "ignored-private-subject" }
  return { directory, pin, publisher, environment, input: { environment, platform: "darwin" as const, arch: "arm64",
    args: ["--mac", "--arm64"], signingFile: path.join(directory, "absent-signing.env") } }
}

test("complete candidate captures the matching pin before build and keeps unsigned intent explicit", async () => {
  const value = await fixture()
  try {
    const result = await completeMacPackageEnvironment(value.input)
    expect(result.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY).toBe(value.pin)
    expect(result.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY).toBe(value.publisher)
    expect(result.DEEPAGENT_CODE_RELEASE_ID).toBe("dac-2.0.3-candidate")
    expect(result.DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY).toBe("-")
    expect(result.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false")
    expect(result.CSC_NAME).toBeUndefined()
    expect(value.environment.CSC_NAME).toBe("ignored-private-subject")
    expect((await fs.readdir(value.directory)).toSorted()).toEqual(["publisher.pem"])
  } finally {
    await fs.rm(value.directory, { recursive: true, force: true })
  }
})

test("complete signed preparation imports the same public pin and exact asset certificate for compilation", async () => {
  const value = await fixture()
  try {
    await fs.writeFile(path.join(value.directory, "public.pem"), value.pin, { mode: 0o644 })
    await fs.writeFile(path.join(value.directory, "signing.env"), ["APPLE_ID=private-test-account",
      "APPLE_APP_SPECIFIC_PASSWORD=private-test-password", "APPLE_TEAM_ID=private-test-team", "CSC_NAME=Developer ID Application: private-test-subject",
      `DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY=${path.join(value.directory, "public.pem")}`,
      `DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY=${value.publisher}`, "DEEPAGENT_CODE_RELEASE_ID=dac-2.0.3-signed",
      `DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY=${"a".repeat(40)}`].join("\n"), { mode: 0o600 })
    const result = await completeMacPackageEnvironment({ ...value.input, environment: {},
      signingFile: path.join(value.directory, "signing.env") })
    expect(result.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY).toBe(value.pin)
    expect(result.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY).toBe(value.publisher)
    expect(result.DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY).toBe("a".repeat(40))
    expect(result.CSC_NAME).toBe("private-test-subject")
    expect(result.DEEPAGENT_CODE_RELEASE_ID).toBe("dac-2.0.3-signed")
  } finally {
    await fs.rm(value.directory, { recursive: true, force: true })
  }
})

test("complete preparation rejects another publisher, exposed or aliased key and invalid release identity", async () => {
  const value = await fixture()
  try {
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()
    await expect(completeMacPackageEnvironment({ ...value.input, environment: { ...value.environment,
      DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY: other } })).rejects.toThrow("matching Ed25519")
    await fs.chmod(value.publisher, 0o644)
    await expect(completeMacPackageEnvironment(value.input)).rejects.toThrow("private key permissions")
    await fs.chmod(value.publisher, 0o600)
    await fs.symlink(value.publisher, path.join(value.directory, "alias.pem"))
    await expect(completeMacPackageEnvironment({ ...value.input, environment: { ...value.environment,
      DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY: path.join(value.directory, "alias.pem") } })).rejects.toThrow("physical files")
    await expect(completeMacPackageEnvironment({ ...value.input, environment: { ...value.environment,
      DEEPAGENT_CODE_RELEASE_ID: "unsafe release/identity" } })).rejects.toThrow("bounded release")
  } finally {
    await fs.rm(value.directory, { recursive: true, force: true })
  }
})

test("complete Native preparation fails missing assets configuration before any build output exists", async () => {
  const value = await fixture()
  try {
    await expect(completeMacPackageEnvironment({ ...value.input, environment: { DEEPAGENT_CODE_ALLOW_UNSIGNED: "1" } }))
      .rejects.toThrow("Complete Native packaging requires:")
    await expect(completeMacPackageEnvironment({ ...value.input, environment: { ...value.environment,
      DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY: "" } })).rejects.toThrow("explicit asset certificate")
    await expect(completeMacPackageEnvironment({ ...value.input, environment: { ...value.environment,
      DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY: await fs.readFile(value.publisher, "utf8") } })).rejects.toThrow("public release pin")
    expect(await Bun.file(path.join(value.directory, "out")).exists()).toBe(false)
    expect(await Bun.file(path.join(value.directory, "dist")).exists()).toBe(false)
  } finally {
    await fs.rm(value.directory, { recursive: true, force: true })
  }
})

test("complete macOS build rejects cross architecture and other platforms before accessing credentials", async () => {
  const input = { environment: {}, args: ["--mac"], platform: "darwin" as const, arch: "arm64", signingFile: "/absent" }
  await expect(completeMacPackageEnvironment({ ...input, platform: "win32" })).rejects.toThrow("native ARM or Intel host")
  await expect(completeMacPackageEnvironment({ ...input, args: ["--mac", "--x64"] })).rejects.toThrow("native ARM or Intel host")
  await expect(completeMacPackageEnvironment({ ...input, args: ["--mac", "--universal"] })).rejects.toThrow("native ARM or Intel host")
  await expect(completeMacPackageEnvironment({ ...input, args: ["--linux"] })).rejects.toThrow("native ARM or Intel host")
})
