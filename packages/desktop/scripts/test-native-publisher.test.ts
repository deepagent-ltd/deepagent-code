import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../../deepagent-code/src/installation/native-installation.schema"
import { cleanupNativePublisher, cleanupTestNativePublisher, guardTestNativeAssets, prepareNativePublisher, prepareTestNativePublisher,
  sealTestNativeCLI, verifyTestNativeReceipt, verifyTestWindowsPreloader, verifyTestWindowsCLIPreloader } from "./test-native-publisher"
import { guardReleaseNativePackage, prepareReleaseNativePublisher, releaseMacAssetIdentity } from "./native-publisher"
import { sealInstalledNativeNode } from "./native-node-artifact"

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-ci-native-publisher-")))
  const environmentFile = path.join(root, "job.env")
  await fs.writeFile(environmentFile, "", { mode: 0o600 })
  const target = `${process.platform}-${process.arch}`
  const publisher = await prepareTestNativePublisher({ runnerTemp: root, environmentFile, target, releaseID: "dac-test-native-fixture" })
  const directory = path.join(root, "bin")
  await fs.mkdir(directory)
  const executable = path.join(directory, "deepagent-code")
  // These files test actual publisher cryptography and fixed-file mutation
  // detection. They deliberately do not execute or qualify a Native runtime.
  const pin = await fs.readFile(publisher.publicKeyFile, "utf8")
  await fs.writeFile(executable, `synthetic publisher bytes\n${JSON.stringify(pin)}`, { mode: 0o700 })
  const names = ["deepagent-work-file-helper", "deepagent-work-storage-cleanup", "bun-command-runtime"]
  const components = await Promise.all(names.map(async (name) => {
    const bytes = Buffer.from(`synthetic fixed asset: ${name}\n`)
    await fs.writeFile(path.join(directory, name), bytes, { mode: 0o700 })
    return new NativeInstallationSchema.Component({ path: `packages/work-file-helper/bin/${target}/${name}`,
      bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })
  }))
  const inventory = new NativeInstallationSchema.Components({ schemaVersion: "dac.native-components.v1", target,
    sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), components: components.toSorted((a, b) => a.path.localeCompare(b.path)) })
  await fs.writeFile(`${executable}.native-components.json`, CanonicalJson.stringify(inventory), { mode: 0o600 })
  return { root, target, publisher, executable, environmentFile, inventory }
}

test("one job gets fresh private temp keys, public-only environment references, and exact cleanup", async () => {
  const value = await fixture()
  try {
    const second = await prepareTestNativePublisher({ runnerTemp: value.root, environmentFile: value.environmentFile,
      target: value.target, releaseID: "dac-test-native-second" })
    expect(second.signerHash).not.toBe(value.publisher.signerHash)
    expect(second.directory).not.toBe(value.publisher.directory)
    const environment = await fs.readFile(value.environmentFile, "utf8")
    expect(environment).toContain(`DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY=${value.publisher.privateKeyFile}`)
    expect(environment).toContain(`DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY=${value.publisher.publicKeyFile}`)
    expect(environment).not.toContain("-----BEGIN")
    expect(environment).not.toContain("PRIVATE KEY")
    if (process.platform !== "win32") {
      expect((await fs.stat(value.publisher.privateKeyFile)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(value.publisher.directory)).mode & 0o777).toBe(0o700)
    }
    expect(await cleanupTestNativePublisher({ runnerTemp: value.root, ...second })).toEqual({ state: "removed" })
    expect(await Bun.file(second.privateKeyFile).exists()).toBe(false)
    await expect(prepareTestNativePublisher({ runnerTemp: value.root, environmentFile: path.join(value.root, "../foreign.env"),
      target: value.target, releaseID: "dac-test-foreign" })).rejects.toThrow("QA_PUBLISHER_TEMP_REJECTED")
  } finally { await fs.rm(value.root, { recursive: true, force: true }) }
})

test("release certificate selection preserves the configured unique Developer ID subject without ad-hoc fallback", () => {
  const identity = "a".repeat(40)
  const developer = `1) ${identity} "Developer ID Application: Acme LLC (TEAM)"`
  for (const certificateName of ["Acme", "Acme LLC (TEAM)", "Developer ID Application: Acme", identity.toUpperCase()])
    expect(releaseMacAssetIdentity({ signed: true, certificateName, identities: developer })).toBe(identity)
  expect(releaseMacAssetIdentity({ signed: false, identities: developer })).toBeNull()
  for (const certificateName of [undefined, "", "-", "Other", "\nAcme", "Acme\n"])
    expect(() => releaseMacAssetIdentity({ signed: true, certificateName, identities: developer }))
      .toThrow("RELEASE_MAC_CERTIFICATE_REJECTED")
  expect(() => releaseMacAssetIdentity({ signed: true, certificateName: "Acme", identities:
    `${developer}\n2) ${"b".repeat(40)} "Developer ID Application: Acme Two (TEAM)"` }))
    .toThrow("RELEASE_MAC_CERTIFICATE_REJECTED")
  for (const subject of ["Apple Development: Acme", "Developer ID Installer: Acme"])
    expect(() => releaseMacAssetIdentity({ signed: true, certificateName: "Acme", identities: `1) ${identity} "${subject}"` }))
      .toThrow("RELEASE_MAC_CERTIFICATE_REJECTED")
})

test("release publisher uses real temporary keys and exact job identity, with isolated QA cleanup", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-ci-release-publisher-")))
  const environmentFile = path.join(root, "job.env")
  await fs.writeFile(environmentFile, "", { mode: 0o600 })
  try {
    const input = { runnerTemp: root, environmentFile, version: "2.0.4", runID: "1234", attempt: "2", macAssetSigningIdentity: null }
    const publisher = await prepareReleaseNativePublisher(input)
    expect(publisher.releaseID).toBe(`dac-desktop-2.0.4-${process.platform}-${process.arch}-gh1234.2`)
    expect(path.dirname(publisher.directory)).toBe(root)
    expect(path.basename(publisher.directory)).toStartWith("dac-release-native-publisher-")
    const environment = await fs.readFile(environmentFile, "utf8")
    expect(environment).toContain("DEEPAGENT_CODE_RELEASE_NATIVE_REQUIRED=1\n")
    expect(environment).not.toContain("-----BEGIN")
    expect(environment).not.toContain("PRIVATE KEY")
    if (process.platform === "darwin") expect(environment).toContain("DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY=\n")
    if (process.platform !== "win32") {
      expect((await fs.stat(publisher.privateKeyFile)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(publisher.directory)).mode & 0o777).toBe(0o700)
    }
    await expect(cleanupTestNativePublisher({ runnerTemp: root, ...publisher })).rejects.toThrow("QA_PUBLISHER_CLEANUP_REJECTED")
    expect(await Bun.file(publisher.privateKeyFile).exists()).toBe(true)
    expect(await cleanupNativePublisher({ runnerTemp: root, ...publisher, release: true })).toEqual({ state: "removed" })
    expect(await Bun.file(publisher.privateKeyFile).exists()).toBe(false)
    const signed = await prepareReleaseNativePublisher({ ...input, macAssetSigningIdentity: "c".repeat(40) })
    if (process.platform === "darwin") expect(await fs.readFile(environmentFile, "utf8"))
      .toContain(`DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY=${"c".repeat(40)}\n`)
    await cleanupNativePublisher({ runnerTemp: root, ...signed, release: true })
    expect(await cleanupNativePublisher({ runnerTemp: root, release: true })).toEqual({ state: "not_prepared" })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("release publisher refuses unsafe physical files and cleanup symlinks without deleting foreign files", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-ci-release-boundary-")))
  const foreign = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-ci-foreign-publisher-")))
  const environmentFile = path.join(root, "job.env")
  await fs.writeFile(environmentFile, "", { mode: 0o600 })
  try {
    const input = { runnerTemp: root, environmentFile, version: "2.0.4", runID: "12", attempt: "1", macAssetSigningIdentity: null }
    for (const change of [{ version: "2.0.4\nOTHER=1" }, { runID: "12\nOTHER=1" }, { attempt: "" }])
      await expect(prepareReleaseNativePublisher({ ...input, ...change })).rejects.toThrow("RELEASE_NATIVE_IDENTITY_REJECTED")
    await expect(prepareReleaseNativePublisher({ ...input, macAssetSigningIdentity: "-" }))
      .rejects.toThrow("RELEASE_NATIVE_ASSET_IDENTITY_REJECTED")
    await expect(prepareNativePublisher({ runnerTemp: root, environmentFile, target: "foreign-target", releaseID: "release" }))
      .rejects.toThrow("QA_PUBLISHER_TARGET_REJECTED")
    await expect(prepareReleaseNativePublisher({ ...input, environmentFile: path.join(foreign, "job.env") }))
      .rejects.toThrow("QA_PUBLISHER_TEMP_REJECTED")
    await fs.link(environmentFile, path.join(root, "hardlinked.env"))
    await expect(prepareReleaseNativePublisher(input)).rejects.toThrow("QA_PUBLISHER_TEMP_REJECTED")
    await fs.unlink(path.join(root, "hardlinked.env"))
    await fs.writeFile(path.join(foreign, "publisher-private.pem"), "foreign private file")
    await fs.writeFile(path.join(foreign, "publisher-public.pem"), "foreign public file")
    // Junctions use the same parent-redirection boundary on Windows without requiring symlink privilege.
    const redirected = path.join(root, "dac-release-native-publisher-redirected")
    await fs.symlink(foreign, redirected, process.platform === "win32" ? "junction" : "dir")
    await expect(cleanupNativePublisher({ runnerTemp: root, release: true,
      privateKeyFile: path.join(redirected, "publisher-private.pem"), publicKeyFile: path.join(redirected, "publisher-public.pem") }))
      .rejects.toThrow("QA_PUBLISHER_CLEANUP_REJECTED")
    expect(await fs.readFile(path.join(foreign, "publisher-private.pem"), "utf8")).toBe("foreign private file")
    expect(await fs.readFile(path.join(foreign, "publisher-public.pem"), "utf8")).toBe("foreign public file")
    const redirectedEnv = path.join(redirected, "publisher-public.pem")
    await expect(prepareReleaseNativePublisher({ ...input, environmentFile: redirectedEnv }))
      .rejects.toThrow("QA_PUBLISHER_TEMP_REJECTED")
    expect((await fs.readdir(root)).filter((name) => name.startsWith("dac-release-native-publisher-")))
      .toEqual(["dac-release-native-publisher-redirected"])
    expect(await fs.readFile(environmentFile, "utf8")).toBe("")
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(foreign, { recursive: true, force: true }) }
})

test("release package guard refuses missing publisher, wrong target, changed pin and absent compiled metadata", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-ci-release-package-")))
  const environmentFile = path.join(root, "job.env")
  await fs.writeFile(environmentFile, "", { mode: 0o600 })
  try {
    const publisher = await prepareReleaseNativePublisher({ runnerTemp: root, environmentFile, version: "2.0.4",
      runID: "12", attempt: "1", macAssetSigningIdentity: null })
    const input = { ...publisher, directory: root, channel: "prod" }
    await expect(guardReleaseNativePackage({ ...input, privateKeyFile: undefined }))
      .rejects.toThrow("RELEASE_NATIVE_ENVIRONMENT_REJECTED")
    await expect(guardReleaseNativePackage({ ...input, target: "foreign-target" }))
      .rejects.toThrow("RELEASE_NATIVE_ENVIRONMENT_REJECTED")
    await expect(guardReleaseNativePackage({ ...input, channel: "dev" }))
      .rejects.toThrow("RELEASE_NATIVE_ENVIRONMENT_REJECTED")
    const wrongPin = path.join(root, "wrong-public.pem")
    await fs.writeFile(wrongPin, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }))
    await expect(guardReleaseNativePackage({ ...input, publicKeyFile: wrongPin })).rejects.toThrow("QA_PUBLISHER_PIN_CHANGED")
    await expect(guardReleaseNativePackage(input)).rejects.toThrow("ENOENT")
    await cleanupNativePublisher({ runnerTemp: root, ...publisher, release: true })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("release sealing fails fast when required job keys are absent while optional local packaging retains its behavior", async () => {
  const names = ["DEEPAGENT_CODE_RELEASE_NATIVE_REQUIRED", "DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY",
    "DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY", "DEEPAGENT_CODE_RELEASE_ID"]
  const previous = names.map((name) => process.env[name])
  try {
    names.forEach((name) => delete process.env[name])
    process.env.DEEPAGENT_CODE_RELEASE_NATIVE_REQUIRED = "1"
    const context = { appOutDir: "/unused", electronPlatformName: "darwin", packager: { appInfo: { productFilename: "DeepAgent Code" } } } as Parameters<typeof sealInstalledNativeNode>[0]
    await expect(sealInstalledNativeNode(context)).rejects.toThrow("Required Native release publisher is missing its key or release identity")
    delete process.env.DEEPAGENT_CODE_RELEASE_NATIVE_REQUIRED
    expect(await sealInstalledNativeNode(context)).toEqual({ state: "publisher_not_configured" })
  } finally {
    names.forEach((name, index) => previous[index] === undefined ? delete process.env[name] : process.env[name] = previous[index])
  }
})

test("release publisher CLI prepares and destroys its real job keys and reports build failures without key material", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-ci-release-entry-")))
  const environmentFile = path.join(root, "job.env")
  await fs.writeFile(environmentFile, "", { mode: 0o600 })
  try {
    const environment = { ...process.env, RUNNER_TEMP: root, GITHUB_ENV: environmentFile, GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1", DEEPAGENT_CODE_VERSION: "2.0.4", DEEPAGENT_CODE_CHANNEL: "prod",
      DAC_NATIVE_APPLE_SIGNED: "0", DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY: "",
      DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY: "", DEEPAGENT_CODE_RELEASE_ID: "" }
    const run = async (phase: string, env: Record<string, string | undefined>) => {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "native-publisher.ts"), phase],
        { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { exit, stdout, stderr }
    }
    const prepared = await run("prepare", environment)
    expect(prepared.exit).toBe(0)
    expect(prepared.stderr).toBe("")
    expect(JSON.parse(prepared.stdout)).toMatchObject({ state: "prepared", keyStorage: "RUNNER_TEMP",
      privateKeyUploaded: false, functionalAcceptance: false })
    expect(prepared.stdout).not.toContain("-----BEGIN")
    expect(prepared.stdout).not.toContain("publisher-private.pem")
    const references = Object.fromEntries((await fs.readFile(environmentFile, "utf8")).trimEnd().split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]))
    const guarded = await run("guard", { ...environment, ...references })
    expect(guarded.exit).toBe(1)
    expect(guarded.stdout).toBe("")
    expect(JSON.parse(guarded.stderr)).toMatchObject({ state: "refused", phase: "guard", functionalAcceptance: false })
    expect(guarded.stderr).not.toContain("-----BEGIN")
    expect(guarded.stderr).not.toContain(root)
    expect(await Bun.file(references.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY).exists()).toBe(true)
    const cleanup = await run("cleanup", { ...environment, ...references })
    expect(cleanup.exit).toBe(0)
    expect(JSON.parse(cleanup.stdout)).toEqual({ state: "removed" })
    expect(await Bun.file(references.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY).exists()).toBe(false)
    expect(await Bun.file(references.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY).exists()).toBe(false)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("real CLI Payload signing verifies exact files and refuses changed executable, inventory and signer", async () => {
  const value = await fixture()
  try {
    if (process.platform === "win32") {
      // This fixture has synthetic bytes and no original Native publisher. It
      // cannot attest a Windows compiled CLI through the real issuer path.
      await expect(sealTestNativeCLI({ executable: value.executable, ...value.publisher })).rejects.toThrow()
      return
    }
    const signed = await sealTestNativeCLI({ executable: value.executable, ...value.publisher })
    expect(signed.state).toBe("sealed")
    expect(signed.nativeRuntimeQualified).toBe(false)
    const actual = await verifyTestNativeReceipt({ executable: value.executable, ...value.publisher })
    expect(actual.signerHash).toBe(value.publisher.signerHash)
    expect(actual.receiptHash).toBe(signed.receiptHash)
    expect((await Bun.file(`${value.executable}.native-installation.json`).json()).payload.domain)
      .toBe(NativeInstallationSchema.DOMAIN)
    const prior = await fs.readFile(value.executable)
    await fs.appendFile(value.executable, "changed")
    await expect(verifyTestNativeReceipt({ executable: value.executable, ...value.publisher }))
      .rejects.toThrow("QA_EXECUTABLE_BYTES_REJECTED")
    await fs.writeFile(value.executable, prior)
    const unconfigured = path.join(path.dirname(value.executable), "unconfigured-cli")
    await fs.writeFile(unconfigured, "synthetic CLI without a compiled Native pin", { mode: 0o700 })
    await fs.writeFile(`${unconfigured}.native-components.json`, CanonicalJson.stringify(value.inventory), { mode: 0o600 })
    await sealTestNativeCLI({ executable: unconfigured, ...value.publisher })
    await expect(verifyTestNativeReceipt({ executable: unconfigured, ...value.publisher }))
      .rejects.toThrow("QA_COMPILED_PIN_MISSING")
    await fs.writeFile(`${value.executable}.native-components.json`, CanonicalJson.stringify({ ...value.inventory, sourceTree: "c".repeat(40) }))
    await expect(verifyTestNativeReceipt({ executable: value.executable, ...value.publisher }))
      .rejects.toThrow("QA_RECEIPT_BINDING_REJECTED")
    await fs.writeFile(`${value.executable}.native-components.json`, CanonicalJson.stringify(value.inventory))
    const replacement = generateKeyPairSync("ed25519")
    await fs.writeFile(value.publisher.privateKeyFile, replacement.privateKey.export({ type: "pkcs8", format: "pem" }))
    await expect(sealTestNativeCLI({ executable: value.executable, ...value.publisher }))
      .rejects.toThrow("QA_PUBLISHER_PIN_CHANGED")
    await expect(verifyTestNativeReceipt({ executable: value.executable,
      ...value.publisher, runtime: value.executable })).rejects.toThrow("QA_RECEIPT_BINDING_REJECTED")
  } finally { await fs.rm(value.root, { recursive: true, force: true }) }
})

test("fixed Native assets refuse missing and replaced physical bytes without invoking them", async () => {
  const value = await fixture()
  try {
    if (value.target.startsWith("darwin-"))
      expect(await guardTestNativeAssets({ executable: value.executable, target: value.target, kind: "cli" })).toEqual({ assetCount: 3 })
    await fs.writeFile(path.join(path.dirname(value.executable), "bun-command-runtime"), "replacement")
    await expect(guardTestNativeAssets({ executable: value.executable, target: value.target, kind: "desktop" }))
      .rejects.toThrow(value.target.startsWith("darwin-") ? "QA_FIXED_NATIVE_ASSET_CHANGED" : "QA_FIXED_NATIVE_ASSETS_MISSING")
    await expect(verifyTestNativeReceipt({ executable: value.executable, runtime: value.executable,
      target: value.target === "linux-x64" ? "darwin-arm64" : "linux-x64", releaseID: value.publisher.releaseID, publicKeyFile: value.publisher.publicKeyFile }))
      .rejects.toThrow("QA_COMPONENTS_REJECTED")
    await expect(guardTestNativeAssets({ executable: "unused", target: "win32-x64", kind: "cli" }))
      .rejects.toThrow()
  } finally { await fs.rm(value.root, { recursive: true, force: true }) }
})

test("compiled CLI preloader receipt requires its three exact roles and refuses desktop purpose or changed bytes", async () => {
  const value = await fixture()
  try {
    const directory = path.join(value.root, "compiled-cli")
    await fs.mkdir(directory)
    const images = await Promise.all(["native-image-factory.node", "deepagent-code.exe", "deepagent-code.exe.native-components.json"].map(async (name) => {
      const bytes = Buffer.from(`synthetic receipt grammar image: ${name}`)
      await fs.writeFile(path.join(directory, name), bytes, { mode: 0o600 })
      return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
    }))
    const key = createPrivateKey(await fs.readFile(value.publisher.privateKeyFile))
    const payload = { domain: "dac.windows-native-preloader.v1", purpose: "compiled-bun-cli", target: "win32-x64", images }
    const put = async (input: typeof payload) => fs.writeFile(path.join(directory, "native-preloader.installation.json"),
      CanonicalJson.stringify({ payload: input, signature: sign(null, Buffer.from(CanonicalJson.stringify(input)), key).toString("hex") }), { mode: 0o600 })
    const input = { executable: path.join(directory, "deepagent-code.exe"), target: "win32-x64", publicKeyFile: value.publisher.publicKeyFile }
    await put(payload)
    expect((await verifyTestWindowsCLIPreloader(input)).imageCount).toBe(3)
    await expect(verifyTestWindowsCLIPreloader({ ...input, publicKeyFile: value.publisher.privateKeyFile }))
      .rejects.toThrow("QA_WINDOWS_CLI_PRELOADER_PIN_REJECTED")
    await expect(verifyTestWindowsCLIPreloader({ ...input, target: "win32-arm64" })).rejects.toThrow("QA_WINDOWS_CLI_PRELOADER_RECEIPT_REJECTED")
    await put({ ...payload, purpose: "desktop-sidecar" })
    await expect(verifyTestWindowsCLIPreloader(input)).rejects.toThrow()
    await put({ ...payload, images: [...images].reverse() })
    await expect(verifyTestWindowsCLIPreloader(input)).rejects.toThrow("QA_WINDOWS_CLI_PRELOADER_RECEIPT_REJECTED")
    await put(payload)
    const wrongPin = path.join(directory, "wrong-public.pem")
    await fs.writeFile(wrongPin, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }))
    await expect(verifyTestWindowsCLIPreloader({ ...input, publicKeyFile: wrongPin }))
      .rejects.toThrow("QA_WINDOWS_CLI_PRELOADER_RECEIPT_REJECTED")
    await fs.appendFile(input.executable, "changed")
    await expect(verifyTestWindowsCLIPreloader(input)).rejects.toThrow("QA_WINDOWS_CLI_PRELOADER_IMAGE_CHANGED")
  } finally { await fs.rm(value.root, { recursive: true, force: true }) }
})

test("original Windows preloader receipt binds all three fixed images, role and target", async () => {
  const value = await fixture()
  try {
    const main = path.join(value.root, "main")
    await fs.mkdir(path.join(main, "chunks"), { recursive: true })
    const images = await Promise.all(["native-image-factory.node", "node.js", "sidecar.js"].map(async (name) => {
      const bytes = Buffer.from(`synthetic preloader image: ${name}`)
      await fs.writeFile(path.join(main, name === "sidecar.js" ? "" : "chunks", name), bytes, { mode: 0o600 })
      return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
    }))
    const payload = { domain: "dac.windows-native-preloader.v1", purpose: "desktop-sidecar", target: "win32-x64", images }
    const receipt = { payload, signature: sign(null, Buffer.from(CanonicalJson.stringify(payload)), createPrivateKey(await fs.readFile(value.publisher.privateKeyFile))).toString("hex") }
    await fs.writeFile(path.join(main, "chunks/native-preloader.installation.json"), CanonicalJson.stringify(receipt), { mode: 0o600 })
    expect((await verifyTestWindowsPreloader({ main, target: "win32-x64", publicKeyFile: value.publisher.publicKeyFile })).imageCount).toBe(3)
    await expect(verifyTestWindowsPreloader({ main, target: "win32-arm64", publicKeyFile: value.publisher.publicKeyFile }))
      .rejects.toThrow("QA_WINDOWS_PRELOADER_RECEIPT_REJECTED")
    await fs.appendFile(path.join(main, "chunks/node.js"), "changed")
    await expect(verifyTestWindowsPreloader({ main, target: "win32-x64", publicKeyFile: value.publisher.publicKeyFile }))
      .rejects.toThrow("QA_WINDOWS_PRELOADER_IMAGE_CHANGED")
  } finally { await fs.rm(value.root, { recursive: true, force: true }) }
})
