#!/usr/bin/env bun
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Schema } from "effect"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../../deepagent-code/src/installation/native-installation.schema"

const execute = promisify(execFile)
const targets = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]
class Refused extends Error {
  constructor(readonly code: string) { super(code) }
}

/** This publisher exists only for one CI job. Its private key never belongs to
 * the checkout, installer, source inventory, output log, or uploaded report. */
export async function prepareTestNativePublisher(input: {
  runnerTemp: string
  environmentFile: string
  target: string
  releaseID: string
}) {
  return prepareNativePublisher(input)
}

/** SystemRoot is supplied by the trusted runner environment. Resolve the two
 * Windows system tools directly; Git Bash's GNU whoami and COMSPEC are unrelated. */
export function windowsNativePublisherTools(systemRoot = process.env.SystemRoot) {
  if (!systemRoot || !/^[A-Za-z]:[\\/]/.test(systemRoot) || /[\r\n\0<>"|?*]/.test(systemRoot) ||
    systemRoot.split(/[\\/]/).some((part) => part === "." || part === ".."))
    throw new Refused("QA_PUBLISHER_WINDOWS_ROOT_REJECTED")
  return {
    owner: path.win32.join(systemRoot, "System32", "whoami.exe"),
    acl: path.win32.join(systemRoot, "System32", "icacls.exe"),
  }
}

export async function prepareNativePublisher(input: {
  runnerTemp: string
  environmentFile: string
  target: string
  releaseID: string
  release?: true
  macAssetSigningIdentity?: string | null
}) {
  if (!targets.includes(input.target) || input.target !== `${process.platform}-${process.arch}` ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(input.releaseID)) throw new Refused("QA_PUBLISHER_TARGET_REJECTED")
  const root = await fs.realpath(input.runnerTemp)
  if (root !== input.runnerTemp || !path.isAbsolute(root) || /[\r\n]/.test(root) ||
    !inside(root, path.resolve(input.environmentFile))) throw new Refused("QA_PUBLISHER_TEMP_REJECTED")
  const identity = input.release ? input.macAssetSigningIdentity : process.platform === "darwin" ? "-" : undefined
  if (input.release && identity !== null && identity !== undefined && !/^[0-9a-f]{40}$/i.test(identity))
    throw new Refused("RELEASE_NATIVE_ASSET_IDENTITY_REJECTED")
  const environment = await fs.lstat(input.environmentFile)
  if (!environment.isFile() || environment.isSymbolicLink() || environment.nlink !== 1 ||
    await fs.realpath(input.environmentFile) !== path.resolve(input.environmentFile))
    throw new Refused("QA_PUBLISHER_TEMP_REJECTED")
  const windows = process.platform === "win32" ? windowsNativePublisherTools() : undefined
  const directory = await fs.mkdtemp(path.join(root, input.release ? "dac-release-native-publisher-" : "dac-test-native-publisher-"))
  const privateKeyFile = path.join(directory, "publisher-private.pem")
  const publicKeyFile = path.join(directory, "publisher-public.pem")
  try {
    await fs.chmod(directory, 0o700)
    if (windows) {
      const owner = await execute(windows.owner, ["/user", "/fo", "csv", "/nh"], { maxBuffer: 8192 })
        .catch(() => { throw new Refused("QA_PUBLISHER_OWNER_COMMAND_FAILED") })
      const sid = /"(S-1-5-[0-9-]+)"/.exec(owner.stdout)?.[1]
      if (!sid) throw new Refused("QA_PUBLISHER_OWNER_UNAVAILABLE")
      // This changes only our newly-created directory's ACL, never an OS policy.
      await execute(windows.acl, [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { maxBuffer: 8192 })
        .catch(() => { throw new Refused("QA_PUBLISHER_ACL_COMMAND_FAILED") })
    }
    const keys = generateKeyPairSync("ed25519")
    await fs.writeFile(privateKeyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 })
    await fs.writeFile(publicKeyFile, keys.publicKey.export({ type: "spki", format: "pem" }), { flag: "wx", mode: 0o644 })
    await fs.appendFile(input.environmentFile, [
      `DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY=${privateKeyFile}`,
      `DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY=${publicKeyFile}`,
      `DEEPAGENT_CODE_RELEASE_ID=${input.releaseID}`,
      ...(input.release ? ["DEEPAGENT_CODE_RELEASE_NATIVE_REQUIRED=1"] : []),
      ...(process.platform === "darwin" ? [`DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY=${identity ?? ""}`] : []),
      "",
    ].join("\n"))
    return { directory, privateKeyFile, publicKeyFile, target: input.target, releaseID: input.releaseID,
      signerHash: digest(keys.publicKey.export({ type: "spki", format: "der" })) }
  } catch (error) {
    await Promise.all([privateKeyFile, publicKeyFile].map((name) => fs.rm(name, { force: true })))
      .then(() => fs.rmdir(directory))
      .catch(() => { throw new Refused("QA_PUBLISHER_TEMP_CLEANUP_FAILED") })
    throw error
  }
}

/** Regular compiled CLI artifacts use the existing Payload/Manifest contract,
 * rather than a Node receipt that would attest an unrelated interpreter. */
export async function sealTestNativeCLI(input: {
  executable: string
  target: string
  releaseID: string
  privateKeyFile: string
  publicKeyFile: string
}) {
  const components = await readComponents(input.executable, input.target)
  const keys = await verifyNativePublisherKeys(input.privateKeyFile, input.publicKeyFile)
  if (input.target.startsWith("win32-")) {
    if (process.platform !== "win32" || input.target !== `win32-${process.arch}`)
      throw new Refused("QA_WINDOWS_CLI_NATIVE_ISSUER_REQUIRED")
    const { withWindowsNativePublisherHost } = await import("../../deepagent-code/script/build-windows-native-bootstrap")
    const { fileURLToPath } = await import("node:url")
    const { signWindowsNativeCLI } = await import("../../deepagent-code/script/sign-windows-native-cli")
    const issued = await withWindowsNativePublisherHost(input.executable, (host) => execute(host, [
      fileURLToPath(new URL("../../deepagent-code/script/sign-native-node.ts", import.meta.url)),
      "--cli", "--module", input.executable, "--runtime", input.executable,
      "--release", input.releaseID, "--key", input.privateKeyFile,
    ], { maxBuffer: 32_768 }))
    const sealed = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
      payload: NativeInstallationSchema.Payload, signerHash: Schema.String,
    })), { onExcessProperty: "error" })(issued.stdout)
    const preloader = await signWindowsNativeCLI({ executable: input.executable, privateKey: keys.privateKey })
    if (sealed.signerHash !== keys.signerHash || preloader.signerHash !== keys.signerHash ||
      sealed.payload.target !== input.target || sealed.payload.componentsHash !== digest(CanonicalJson.stringify(components)))
      throw new Refused("QA_WINDOWS_CLI_ISSUER_BINDING_REJECTED")
    return { state: "sealed", target: input.target, releaseID: input.releaseID, signerHash: keys.signerHash,
      executableHash: sealed.payload.executable.sha256, receiptHash: digest(await fs.readFile(`${input.executable}${NativeInstallationSchema.SIDECAR_SUFFIX}`)),
      preloaderReceiptHash: preloader.receiptHash, nativeRuntimeQualified: false }
  }
  const executable = await fingerprint(input.executable)
  const payload = new NativeInstallationSchema.Payload({ domain: NativeInstallationSchema.DOMAIN,
    releaseID: input.releaseID, target: input.target, sourceCommit: components.sourceCommit,
    sourceTree: components.sourceTree, componentsHash: digest(CanonicalJson.stringify(components)), executable })
  const manifest = new NativeInstallationSchema.Manifest({ payload,
    signature: sign(null, Buffer.from(CanonicalJson.stringify(payload)), keys.privateKey).toString("hex") })
  if (CanonicalJson.stringify(executable) !== CanonicalJson.stringify(await fingerprint(input.executable)))
    throw new Refused("QA_CLI_CHANGED_DURING_SEAL")
  const file = await fs.open(`${input.executable}${NativeInstallationSchema.SIDECAR_SUFFIX}`, "wx", 0o644)
  try {
    await file.writeFile(CanonicalJson.stringify(manifest), "utf8")
    await file.sync()
  } finally { await file.close() }
  return { state: "sealed", target: input.target, releaseID: input.releaseID, signerHash: keys.signerHash,
    executableHash: executable.sha256, receiptHash: digest(CanonicalJson.stringify(manifest)), nativeRuntimeQualified: false }
}

export async function verifyTestNativeReceipt(input: {
  executable: string
  runtime?: string
  target: string
  releaseID: string
  publicKeyFile: string
}) {
  const pin = await fs.readFile(input.publicKeyFile, "utf8")
  const key = createPublicKey(pin)
  if (pin.includes("PRIVATE KEY") || key.asymmetricKeyType !== "ed25519") throw new Refused("QA_PUBLIC_PIN_REJECTED")
  const components = await readComponents(input.executable, input.target)
  const text = await fs.readFile(`${input.executable}${NativeInstallationSchema.SIDECAR_SUFFIX}`, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new Refused(input.runtime && input.target.startsWith("linux-") ? "LINUX_NODE_PACKAGE_RECEIPT_MISSING" : "QA_NATIVE_RECEIPT_MISSING")
    throw error
  })
  if (Buffer.byteLength(text) > NativeInstallationSchema.MANIFEST_LIMIT) throw new Refused("QA_RECEIPT_LIMIT_REJECTED")
  const receipt = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Union([
    NativeInstallationSchema.Manifest, NativeInstallationSchema.NodeManifest,
  ])), { onExcessProperty: "error" })(text)
  if (CanonicalJson.stringify(receipt) !== text || receipt.payload.releaseID !== input.releaseID ||
    receipt.payload.target !== input.target || receipt.payload.sourceCommit !== components.sourceCommit ||
    receipt.payload.sourceTree !== components.sourceTree ||
    receipt.payload.componentsHash !== digest(CanonicalJson.stringify(components)) ||
    receipt.payload.domain !== (input.runtime ? NativeInstallationSchema.NODE_DOMAIN : NativeInstallationSchema.DOMAIN) ||
    !verify(null, Buffer.from(CanonicalJson.stringify(receipt.payload)), key, Buffer.from(receipt.signature, "hex")))
    throw new Refused("QA_RECEIPT_BINDING_REJECTED")
  if (CanonicalJson.stringify(await fingerprint(input.executable)) !== CanonicalJson.stringify(receipt.payload.executable))
    throw new Refused("QA_EXECUTABLE_BYTES_REJECTED")
  if (input.runtime && (!('runtime' in receipt.payload) ||
    CanonicalJson.stringify(await fingerprint(input.runtime)) !== CanonicalJson.stringify(receipt.payload.runtime)))
    throw new Refused("QA_RUNTIME_BYTES_REJECTED")
  const bytes = await fs.readFile(input.executable)
  // Both current producers embed this exact pin. A receipt alone cannot enable
  // a candidate whose build silently omitted the runtime verification defines.
  if (!bytes.includes(Buffer.from(pin)) && !bytes.includes(Buffer.from(JSON.stringify(pin).slice(1, -1))))
    throw new Refused("QA_COMPILED_PIN_MISSING")
  return { signerHash: digest(key.export({ type: "spki", format: "der" })), receiptHash: digest(text), components }
}

export async function guardTestNativeAssets(input: {
  executable: string
  target: string
  kind: "desktop" | "cli"
}) {
  const components = await readComponents(input.executable, input.target)
  const prefix = `packages/work-file-helper/bin/${input.target}/`
  const assets = components.components.filter((entry) => entry.path.startsWith(prefix))
  const names = input.target.startsWith("win32-")
    ? ["native-image-factory.node", "deepagent-work-file-helper.exe", "deepagent-work-storage-cleanup.exe",
      "deepagent-work-process-supervisor.exe", "bun-command-runtime.exe"]
    : ["deepagent-work-file-helper", "deepagent-work-storage-cleanup", "bun-command-runtime",
      ...(input.target.startsWith("linux-") ? ["deepagent-work-process-supervisor"] : [])]
  if (names.some((name) => assets.filter((entry) => entry.path === prefix + name).length !== 1))
    throw new Refused("QA_FIXED_NATIVE_ASSETS_MISSING")
  await Promise.all(assets.map(async (entry) => {
    const actual = await fingerprint(path.join(path.dirname(input.executable), entry.path.slice(prefix.length)))
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new Refused("QA_FIXED_NATIVE_ASSET_CHANGED")
  }))
  if (input.target.startsWith("linux-") && !assets.some((entry) => entry.path.startsWith(prefix + "runtime-closure/")))
    throw new Refused("QA_LINUX_RUNTIME_CLOSURE_MISSING")
  return { assetCount: assets.length }
}

export async function verifyTestWindowsCLIPreloader(input: { executable: string; target: string; publicKeyFile: string }) {
  const text = await fs.readFile(path.join(path.dirname(input.executable), "native-preloader.installation.json"), "utf8")
  if (Buffer.byteLength(text) > 16_384) throw new Refused("QA_WINDOWS_CLI_PRELOADER_RECEIPT_REJECTED")
  const pin = await fs.readFile(input.publicKeyFile, "utf8")
  const key = createPublicKey(pin)
  if (pin.includes("PRIVATE KEY") || key.asymmetricKeyType !== "ed25519")
    throw new Refused("QA_WINDOWS_CLI_PRELOADER_PIN_REJECTED")
  const receipt = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
    payload: Schema.Struct({ domain: Schema.Literal("dac.windows-native-preloader.v1"),
      purpose: Schema.Literal("compiled-bun-cli"), target: Schema.Literals(["win32-x64", "win32-arm64"]),
      images: Schema.Array(Schema.Struct({ name: Schema.Literals(["native-image-factory.node", "deepagent-code.exe", "deepagent-code.exe.native-components.json"]),
        bytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(268_435_456)),
        sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      })).check(Schema.isMinLength(3), Schema.isMaxLength(3)) }),
    signature: Schema.String.check(Schema.isPattern(/^[a-f0-9]{128}$/)),
  })), { onExcessProperty: "error" })(text)
  if (path.basename(input.executable) !== "deepagent-code.exe" || receipt.payload.target !== input.target ||
    CanonicalJson.stringify(receipt) !== text ||
    receipt.payload.images.map((image) => image.name).join(",") !== "native-image-factory.node,deepagent-code.exe,deepagent-code.exe.native-components.json" ||
    !verify(null, Buffer.from(CanonicalJson.stringify(receipt.payload)), key,
      Buffer.from(receipt.signature, "hex"))) throw new Refused("QA_WINDOWS_CLI_PRELOADER_RECEIPT_REJECTED")
  await Promise.all(receipt.payload.images.map(async (image) => {
    const actual = await fingerprint(path.join(path.dirname(input.executable), image.name))
    if (actual.bytes !== image.bytes || actual.sha256 !== image.sha256) throw new Refused("QA_WINDOWS_CLI_PRELOADER_IMAGE_CHANGED")
  }))
  return { receiptHash: digest(text), imageCount: 3 }
}

export async function verifyTestWindowsPreloader(input: { main: string; target: string; publicKeyFile: string }) {
  const text = await fs.readFile(path.join(input.main, "chunks/native-preloader.installation.json"), "utf8")
  if (Buffer.byteLength(text) > 16_384) throw new Refused("QA_WINDOWS_PRELOADER_RECEIPT_REJECTED")
  const receipt = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
    payload: Schema.Struct({ domain: Schema.Literal("dac.windows-native-preloader.v1"),
      purpose: Schema.Literal("desktop-sidecar"), target: Schema.Literals(["win32-x64", "win32-arm64"]),
      images: Schema.Array(Schema.Struct({ name: Schema.Literals(["native-image-factory.node", "node.js", "sidecar.js"]),
        bytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(268_435_456)),
        sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      })).check(Schema.isMinLength(3), Schema.isMaxLength(3)) }),
    signature: Schema.String.check(Schema.isPattern(/^[a-f0-9]{128}$/)),
  })), { onExcessProperty: "error" })(text)
  if (receipt.payload.target !== input.target || CanonicalJson.stringify(receipt) !== text ||
    receipt.payload.images.map((image) => image.name).join(",") !== "native-image-factory.node,node.js,sidecar.js" ||
    !verify(null, Buffer.from(CanonicalJson.stringify(receipt.payload)), createPublicKey(await fs.readFile(input.publicKeyFile)),
      Buffer.from(receipt.signature, "hex"))) throw new Refused("QA_WINDOWS_PRELOADER_RECEIPT_REJECTED")
  await Promise.all(receipt.payload.images.map(async (image) => {
    const actual = await fingerprint(path.join(input.main, image.name === "sidecar.js" ? "" : "chunks", image.name))
    if (actual.bytes !== image.bytes || actual.sha256 !== image.sha256) throw new Refused("QA_WINDOWS_PRELOADER_IMAGE_CHANGED")
  }))
  return { receiptHash: digest(text), imageCount: 3 }
}

export async function cleanupTestNativePublisher(input: { runnerTemp: string; privateKeyFile?: string; publicKeyFile?: string }) {
  return cleanupNativePublisher(input)
}

export async function cleanupNativePublisher(input: {
  runnerTemp: string; privateKeyFile?: string; publicKeyFile?: string; release?: true
}) {
  if (!input.privateKeyFile && !input.publicKeyFile) return { state: "not_prepared" }
  const root = await fs.realpath(input.runnerTemp)
  if (root !== input.runnerTemp || !input.privateKeyFile || !input.publicKeyFile || !inside(root, input.privateKeyFile) ||
    path.resolve(input.privateKeyFile) !== input.privateKeyFile || path.resolve(input.publicKeyFile) !== input.publicKeyFile ||
    path.dirname(input.privateKeyFile) !== path.dirname(input.publicKeyFile) ||
    path.basename(input.privateKeyFile) !== "publisher-private.pem" || path.basename(input.publicKeyFile) !== "publisher-public.pem" ||
    !path.basename(path.dirname(input.privateKeyFile)).startsWith(input.release ? "dac-release-native-publisher-" : "dac-test-native-publisher-"))
    throw new Refused("QA_PUBLISHER_CLEANUP_REJECTED")
  const directory = path.dirname(input.privateKeyFile)
  const physical = await fs.lstat(directory)
  if (path.dirname(directory) !== root || !physical.isDirectory() || physical.isSymbolicLink() ||
    await fs.realpath(directory) !== directory) throw new Refused("QA_PUBLISHER_CLEANUP_REJECTED")
  await Promise.all([input.privateKeyFile, input.publicKeyFile].map((name) => fs.rm(name, { force: true })))
  await fs.rmdir(directory)
  return { state: "removed" }
}

async function readComponents(executable: string, target: string) {
  if (!targets.includes(target)) throw new Refused("QA_TARGET_REJECTED")
  const text = await fs.readFile(`${executable}.native-components.json`, "utf8")
  if (Buffer.byteLength(text) > NativeInstallationSchema.COMPONENTS_LIMIT) throw new Refused("QA_COMPONENTS_LIMIT_REJECTED")
  const value = Schema.decodeUnknownSync(Schema.fromJsonString(NativeInstallationSchema.Components), {
    onExcessProperty: "error",
  })(text)
  const names = value.components.map((entry) => entry.path)
  if (value.target !== target || CanonicalJson.stringify(value) !== text || new Set(names).size !== names.length ||
    names.join("\n") !== names.toSorted().join("\n")) throw new Refused("QA_COMPONENTS_REJECTED")
  return value
}

export async function verifyNativePublisherKeys(privateKeyFile: string, publicKeyFile: string) {
  const key = createPrivateKey(await fs.readFile(privateKeyFile))
  const pin = createPublicKey(await fs.readFile(publicKeyFile))
  if (key.asymmetricKeyType !== "ed25519" || pin.asymmetricKeyType !== "ed25519" ||
    !createPublicKey(key).export({ type: "spki", format: "der" }).equals(pin.export({ type: "spki", format: "der" })))
    throw new Refused("QA_PUBLISHER_PIN_CHANGED")
  return { privateKey: key, signerHash: digest(pin.export({ type: "spki", format: "der" })) }
}

async function fingerprint(filename: string) {
  if (!path.isAbsolute(filename) || await fs.realpath(filename) !== filename) throw new Refused("QA_PHYSICAL_FILE_REJECTED")
  const file = await fs.open(filename, "r")
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(NativeInstallationSchema.EXECUTABLE_LIMIT) ||
      (process.platform !== "win32" && (before.mode & 0o022n) !== 0n)) throw new Refused("QA_PHYSICAL_FILE_REJECTED")
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(65_536)
    const count = { bytes: 0 }
    while (true) {
      const read = await file.read(buffer, 0, buffer.length, null)
      if (!read.bytesRead) break
      count.bytes += read.bytesRead
      if (BigInt(count.bytes) > before.size) throw new Refused("QA_FILE_CHANGED")
      hash.update(buffer.subarray(0, read.bytesRead))
    }
    const stamp = (value: typeof before) => [value.dev, value.ino, value.size, value.mode, value.nlink, value.mtimeNs, value.ctimeNs].join(":")
    if (BigInt(count.bytes) !== before.size || stamp(before) !== stamp(await file.stat({ bigint: true })) ||
      stamp(before) !== stamp(await fs.lstat(filename, { bigint: true })) || await fs.realpath(filename) !== filename)
      throw new Refused("QA_FILE_CHANGED")
    return { bytes: count.bytes, sha256: hash.digest("hex") }
  } finally { await file.close() }
}

function inside(root: string, filename: string) {
  const relative = path.relative(root, filename)
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative) && !/[\r\n]/.test(filename)
}
function digest(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex") }

if (import.meta.main) {
  const phase = process.argv[2]
  const target = process.env.DAC_TEST_PACKAGE_TARGET ?? ""
  const releaseID = process.env.DEEPAGENT_CODE_RELEASE_ID ?? `dac-test-${target}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
  const privateKeyFile = process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY
  const publicKeyFile = process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY
  const report = path.resolve("packages/desktop/dist/test-native-qualification.json")
  const state: Record<string, unknown> = { schemaVersion: 1, target, releaseID, phase,
    operatingSystemSigning: false, privateKeyUploaded: false, runtimeChecksRelaxed: false,
    functionalAcceptance: false, nativeWorkExecution: "not_exercised", state: "refused" }
  try {
    if (phase === "prepare") {
      if (privateKeyFile || publicKeyFile) throw new Refused("QA_EXISTING_RELEASE_PUBLISHER_REJECTED")
      const publisher = await prepareTestNativePublisher({ runnerTemp: process.env.RUNNER_TEMP ?? "",
        environmentFile: process.env.GITHUB_ENV ?? "", target, releaseID })
      console.log(JSON.stringify({ target, releaseID, signerHash: publisher.signerHash, state: "prepared", keyStorage: "RUNNER_TEMP" }))
    } else if (phase === "cleanup") {
      console.log(JSON.stringify(await cleanupTestNativePublisher({ runnerTemp: process.env.RUNNER_TEMP ?? "", privateKeyFile, publicKeyFile })))
    } else {
      if (!privateKeyFile || !publicKeyFile || !targets.includes(target) || target !== `${process.platform}-${process.arch}`)
        throw new Refused("QA_NATIVE_ENVIRONMENT_REJECTED")
      const cli = path.resolve(`packages/deepagent-code/dist-test-cli/deepagent-code-${target.replace("win32", "windows")}/bin/deepagent-code${target.startsWith("win32-") ? ".exe" : ""}`)
      if (phase === "seal-cli") console.log(JSON.stringify(await sealTestNativeCLI({ executable: cli, target, releaseID, privateKeyFile, publicKeyFile })))
      else if (phase === "guard") {
        const product = "DeepAgent Code Dev"
        const { inspectTestPackageExecutable } = await import("./run-test-package-smoke")
        const staged = await inspectTestPackageExecutable({ directory: path.resolve("packages/desktop/dist"), target })
        const app = target.startsWith("darwin-") ? path.resolve(path.dirname(staged.executable), "../..") : undefined
        const main = app ? path.join(app, "Contents/Resources/app.asar.unpacked/out/main") : path.join(path.dirname(staged.executable), "resources/app.asar.unpacked/out/main")
        const runtime = app ? path.join(app, `Contents/Frameworks/${product} Helper.app/Contents/MacOS/${product} Helper`) : staged.executable
        const module = path.join(main, "chunks/node.js")
        // Known unsupported contracts fail before a window/version smoke can be
        // presented as Native qualification. Diagnostics remain a separate artifact.
        const desktopAssets = await guardTestNativeAssets({ executable: module, target, kind: "desktop" })
        const desktop = await verifyTestNativeReceipt({ executable: module, runtime, target, releaseID, publicKeyFile })
        Object.assign(state, { desktop: { state: "qualified_build_proof", signerHash: desktop.signerHash, receiptHash: desktop.receiptHash, ...desktopAssets } })
        if (target.startsWith("win32-"))
          Object.assign(state, { windowsPreloader: await verifyTestWindowsPreloader({ main, target, publicKeyFile }) })
        const cliAssets = await guardTestNativeAssets({ executable: cli, target, kind: "cli" })
        const cliReceipt = await verifyTestNativeReceipt({ executable: cli, target, releaseID, publicKeyFile })
        const cliPreloader = target.startsWith("win32-")
          ? await verifyTestWindowsCLIPreloader({ executable: cli, target, publicKeyFile }) : undefined
        Object.assign(state, { state: "qualified_build_proof", desktop: { signerHash: desktop.signerHash, receiptHash: desktop.receiptHash, ...desktopAssets },
          cli: { signerHash: cliReceipt.signerHash, receiptHash: cliReceipt.receiptHash, ...cliAssets, ...(cliPreloader ? { preloader: cliPreloader } : {}) },
          knownFunctionalGaps: target.startsWith("linux-") ? ["linux_work_write_not_qualified_by_this_proof"]
            : target.startsWith("win32-") ? ["windows_managed_command_not_qualified_by_this_proof"] : [] })
        await fs.mkdir(path.dirname(report), { recursive: true })
        await Bun.write(report, JSON.stringify(state, null, 2) + "\n")
        console.log(JSON.stringify({ state: state.state, target, functionalAcceptance: false }))
      } else throw new Refused("QA_PHASE_REJECTED")
    }
  } catch (error) {
    Object.assign(state, { code: error instanceof Refused ? error.code : "QA_NATIVE_GUARD_UNAVAILABLE",
      unsupportedContracts: [],
      knownFunctionalGaps: target.startsWith("linux-") ? ["linux_work_write_not_qualified_by_this_proof"] : [] })
    await fs.mkdir(path.dirname(report), { recursive: true })
    await Bun.write(report, JSON.stringify(state, null, 2) + "\n")
    console.error(JSON.stringify({ state: "refused", target, phase, code: state.code }))
    process.exitCode = 1
  }
}
