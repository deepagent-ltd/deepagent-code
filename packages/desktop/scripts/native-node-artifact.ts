import fs from "node:fs/promises"
import path from "node:path"
import { createHash, createPrivateKey, createPublicKey } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { constants } from "node:fs"
import type { AfterPackContext, Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const privateKeyPath = () => {
  const value = process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY?.trim()
  if (process.env.DEEPAGENT_CODE_RELEASE_NATIVE_REQUIRED === "1" &&
    (!value || !process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY?.trim() ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(process.env.DEEPAGENT_CODE_RELEASE_ID?.trim() ?? "")))
    throw new Error("Required Native release publisher is missing its key or release identity")
  return value
}
type MacSignOptions = Parameters<Exclude<NonNullable<NonNullable<Configuration["mac"]>["sign"]>, string>>[0]

/** The publisher owns this builder hook. Paths come only from the actual staged product;
 * no runtime/HTTP caller may supply a descriptor, alternative module or interpreter. */
export async function sealInstalledNativeNode(
  context: Pick<AfterPackContext, "appOutDir" | "electronPlatformName" | "packager">,
) {
  const name = context.packager.appInfo.productFilename
  if (context.electronPlatformName === "win32") return sealWindowsPackage(context)
  if (context.electronPlatformName === "linux") return sealLinuxPackage(context)
  if (context.electronPlatformName !== "darwin") return { state: "unsupported_platform" as const }
  const app = path.join(context.appOutDir, `${name}.app`)
  return sealMacApp(app, name)
}

async function sealLinuxPackage(context: Pick<AfterPackContext, "appOutDir" | "packager">) {
  const executable = new Map([
    ["DeepAgent Code", "deepagent-code"],
    ["DeepAgent Code Dev", "deepagent-code-dev"],
    ["DeepAgent Code Beta", "deepagent-code-beta"],
  ]).get(context.packager.appInfo.productName)
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch) ||
    !executable || context.packager.appInfo.sanitizedProductName !== context.packager.appInfo.productName ||
    context.packager.appInfo.productFilename !== executable ||
    !path.isAbsolute(context.appOutDir) || await fs.realpath(context.appOutDir) !== context.appOutDir ||
    !("executableName" in context.packager) || typeof context.packager.executableName !== "string" ||
    context.packager.executableName !== executable || path.basename(context.packager.executableName) !== context.packager.executableName)
    throw new Error("Linux Native sealing requires the exact target-platform product")
  const directory = path.join(context.appOutDir, "resources/app.asar.unpacked/out/main/chunks")
  const module = path.join(directory, "node.js")
  if (await exists(`${module}.native-installation.json`))
    throw new Error("Linux Native package cannot inherit another stage's publisher receipt")
  const configured = privateKeyPath()
  if (!configured) return { state: "publisher_not_configured" as const }
  const publicPin = process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY?.trim()
  if (!publicPin) throw new Error("Linux Native package sealing requires its compiled public release pin")
  const pin = publicPin.includes("-----BEGIN") ? publicPin : await fs.readFile(publicPin, "utf8")
  const signerHash = createHash("sha256").update(createPublicKey(createPrivateKey(await fs.readFile(configured)))
    .export({ type: "spki", format: "der" })).digest("hex")
  requireNativePublisherSigner(signerHash, pin)
  const target = process.arch === "x64" ? "linux-x64" as const : "linux-arm64" as const
  const runtime = path.join(context.appOutDir, context.packager.executableName)
  const { verifyLinuxNativeAssets } = await import("./linux-native-assets")
  const verified = await verifyLinuxNativeAssets({ directory, target })
  const { Schema } = await import("effect")
  const { CanonicalJson } = await import("@deepagent-code/core/util/canonical-json")
  const { NativeInstallationSchema } = await import("../../deepagent-code/src/installation/native-installation.schema")
  const metadata = await observeLinuxPackageImage(`${module}.native-components.json`, NativeInstallationSchema.COMPONENTS_LIMIT)
  const components = Schema.decodeUnknownSync(Schema.fromJsonString(NativeInstallationSchema.Components), {
    onExcessProperty: "error",
  })(metadata.bytes.toString("utf8"))
  const assets = components.components.filter((entry) => entry.path.startsWith("packages/work-file-helper/bin/"))
  if (metadata.bytes.toString("utf8") !== CanonicalJson.stringify(components) || components.target !== target ||
    components.sourceCommit !== verified.manifest.sourceCommit || components.sourceTree !== verified.manifest.sourceTree ||
    assets.length !== verified.manifest.assets.length || verified.manifest.assets.some((entry) =>
      assets.filter((asset) => asset.path === entry.path && asset.bytes === entry.bytes && asset.sha256 === entry.sha256).length !== 1))
    throw new Error("Linux Native package differs from its compiled asset inventory")
  const observed = await Promise.all([module, runtime, ...verified.files].map((filename) => observeLinuxPackageImage(filename)))
  if (!observed[0].bytes.includes(Buffer.from(pin)) &&
    !observed[0].bytes.includes(Buffer.from(JSON.stringify(pin).slice(1, -1))))
    throw new Error("Linux Native module is missing its compiled public release pin")
  const { fileURLToPath } = await import("node:url")
  const signed = await execFileAsync("bun", [
    fileURLToPath(new URL("../../deepagent-code/script/sign-native-node.ts", import.meta.url)),
    "--module", module, "--runtime", runtime, "--key", configured,
    "--release", process.env.DEEPAGENT_CODE_RELEASE_ID?.trim() || "dac-installed-local-candidate",
  ], { maxBuffer: 32_768 })
  const result = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
    payload: NativeInstallationSchema.NodePayload, signerHash: Schema.String,
  })), { onExcessProperty: "error" })(signed.stdout)
  requireNativePublisherSigner(result.signerHash, pin)
  const current = await Promise.all([module, runtime, ...verified.files].map((filename) => observeLinuxPackageImage(filename)))
  const currentMetadata = await observeLinuxPackageImage(`${module}.native-components.json`, NativeInstallationSchema.COMPONENTS_LIMIT)
  if (result.signerHash !== signerHash || result.payload.target !== target ||
    result.payload.sourceCommit !== components.sourceCommit || result.payload.sourceTree !== components.sourceTree ||
    result.payload.componentsHash !== metadata.sha256 || result.payload.executable.sha256 !== observed[0].sha256 ||
    result.payload.runtime.sha256 !== observed[1].sha256 || currentMetadata.stamp !== metadata.stamp ||
    currentMetadata.sha256 !== metadata.sha256 || current.some((entry, index) =>
      entry.stamp !== observed[index].stamp || entry.sha256 !== observed[index].sha256))
    throw new Error("Linux Native issuer returned another fixed package cohort")
  return { state: "sealed" as const, module, runtime, moduleHash: result.payload.executable.sha256,
    runtimeHash: result.payload.runtime.sha256, signerHash, assetsManifestHash: verified.manifestHash }
}

async function observeLinuxPackageImage(filename: string, limit = 268_435_456) {
  if (await fs.realpath(filename) !== filename) throw new Error("Linux Native package image path rejected")
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(limit) || (before.mode & 0o022n) !== 0n)
      throw new Error("Linux Native package image rejected")
    const bytes = await file.readFile()
    const stamp = (value: typeof before) => [value.dev, value.ino, value.size, value.mode, value.nlink, value.mtimeNs, value.ctimeNs].join(":")
    if (bytes.length !== Number(before.size) || stamp(before) !== stamp(await file.stat({ bigint: true })) ||
      stamp(before) !== stamp(await fs.lstat(filename, { bigint: true })) || await fs.realpath(filename) !== filename)
      throw new Error("Linux Native package image changed")
    return { bytes, stamp: stamp(before), sha256: createHash("sha256").update(bytes).digest("hex") }
  } finally { await file.close() }
}

/** Windows afterPack runs before rcedit. It may validate the fixed cohort,
 * but only afterSign may seal the final interpreter bytes, even for unsigned QA. */
export async function prepareWindowsNativeNodePackage(
  context: Pick<AfterPackContext, "appOutDir" | "electronPlatformName" | "packager">,
) {
  if (context.electronPlatformName !== "win32") return { state: "unsupported_platform" as const }
  const directory = path.join(context.appOutDir, "resources/app.asar.unpacked/out/main")
  const receipts = [path.join(directory, "chunks/node.js.native-installation.json"),
    path.join(directory, "chunks/native-preloader.installation.json")]
  if ((await Promise.all(receipts.map(exists))).some(Boolean))
    throw new Error("Windows Native package cannot inherit another stage's publisher receipt")
  if (!privateKeyPath()) return { state: "publisher_not_configured" as const }
  await windowsPackageImages(context)
  return { state: "prepared" as const }
}

async function sealWindowsPackage(context: Pick<AfterPackContext, "appOutDir" | "electronPlatformName" | "packager">) {
  const configured = privateKeyPath()
  const prepared = await prepareWindowsNativeNodePackage(context)
  if (!configured) return prepared
  const files = await windowsPackageImages(context)
  const publicPin = process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY?.trim()
  if (!publicPin) throw new Error("Windows Native package sealing requires its compiled public release pin")
  const pin = publicPin.includes("-----BEGIN") ? publicPin : await fs.readFile(publicPin, "utf8")
  const key = createPrivateKey(await fs.readFile(configured))
  const signerHash = createHash("sha256").update(createPublicKey(key).export({ type: "spki", format: "der" })).digest("hex")
  requireNativePublisherSigner(signerHash, pin)
  const { fileURLToPath } = await import("node:url")
  const { withWindowsNativePublisherHost } = await import("../../deepagent-code/script/build-windows-native-bootstrap")
  const signed = await withWindowsNativePublisherHost(files.module, (host) => execFileAsync(host, [
    fileURLToPath(new URL("../../deepagent-code/script/sign-native-node.ts", import.meta.url)),
    "--module", files.module, "--runtime", files.runtime, "--key", configured,
    "--release", process.env.DEEPAGENT_CODE_RELEASE_ID?.trim() || "dac-installed-local-candidate",
  ], { maxBuffer: 32_768 }))
  const { Schema } = await import("effect")
  const { NativeInstallationSchema } = await import("../../deepagent-code/src/installation/native-installation.schema")
  const result = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
    payload: NativeInstallationSchema.NodePayload, signerHash: Schema.String,
  })), { onExcessProperty: "error" })(signed.stdout)
  requireNativePublisherSigner(result.signerHash, pin)
  if (result.signerHash !== signerHash || result.payload.target !== `win32-${process.arch}` ||
    result.payload.executable.sha256 !== files.moduleHash || result.payload.runtime.sha256 !== files.runtimeHash)
    throw new Error("Windows Native issuer returned another fixed package cohort")
  const { signWindowsNativeSidecar, windowsNativePublisherPin } = await import("../../deepagent-code/script/build-windows-native-bootstrap")
  const ticket = await signWindowsNativeSidecar({ mainDirectory: files.directory, privateKey: key,
    bootstrapHash: files.bootstrapHash, publisherPin: windowsNativePublisherPin(pin) })
  return { state: "sealed" as const, module: files.module, runtime: files.runtime,
    moduleHash: result.payload.executable.sha256, runtimeHash: result.payload.runtime.sha256,
    signerHash, preloaderHash: ticket.sha256 }
}

async function windowsPackageImages(context: Pick<AfterPackContext, "appOutDir" | "packager">) {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch) ||
    !["DeepAgent Code", "DeepAgent Code Dev", "DeepAgent Code Beta"].includes(context.packager.appInfo.productFilename) ||
    !path.isAbsolute(context.appOutDir) || await fs.realpath(context.appOutDir) !== context.appOutDir)
    throw new Error("Windows Native sealing requires the exact target-platform product")
  const directory = path.join(context.appOutDir, "resources/app.asar.unpacked/out/main")
  const module = path.join(directory, "chunks/node.js")
  const runtime = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  const { Schema } = await import("effect")
  const { NativeInstallationSchema } = await import("../../deepagent-code/src/installation/native-installation.schema")
  const metadata = await fs.lstat(`${module}.native-components.json`)
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > NativeInstallationSchema.COMPONENTS_LIMIT)
    throw new Error("Windows Native package component inventory rejected")
  const components = Schema.decodeUnknownSync(Schema.fromJsonString(NativeInstallationSchema.Components), {
    onExcessProperty: "error",
  })(await fs.readFile(`${module}.native-components.json`, "utf8"))
  const bootstrap = components.components.filter((entry) => entry.path ===
    `packages/work-file-helper/bin/win32-${process.arch}/native-image-factory.node`)
  if (components.target !== `win32-${process.arch}` || bootstrap.length !== 1)
    throw new Error("Windows Native package is missing its original bootstrap inventory")
  const observed = await Promise.all([module, runtime, path.join(directory, "sidecar.js"),
    path.join(directory, "chunks/native-image-factory.node")].map(async (filename) => {
      const before = await fs.lstat(filename, { bigint: true })
      if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 268_435_456n ||
        await fs.realpath(filename) !== filename) throw new Error("Windows Native package image rejected")
      const bytes = await fs.readFile(filename)
      const after = await fs.lstat(filename, { bigint: true })
      const stamp = (value: typeof before) => [value.dev, value.ino, value.size, value.nlink, value.mtimeNs, value.ctimeNs].join(":")
      if (stamp(before) !== stamp(after) || bytes.length !== Number(before.size))
        throw new Error("Windows Native package image changed")
      return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
    }))
  if (observed[3].bytes !== bootstrap[0].bytes || observed[3].sha256 !== bootstrap[0].sha256)
    throw new Error("Windows Native bootstrap differs from its compiled inventory")
  return { directory, module, runtime, moduleHash: observed[0].sha256,
    runtimeHash: observed[1].sha256, bootstrapHash: observed[3].sha256 }
}

async function sealMacApp(app: string, name: string) {
  const module = path.join(app, "Contents/Resources/app.asar.unpacked/out/main/chunks/node.js")
  const metadata = `${module}.native-components.json`
  const receipt = `${module}.native-installation.json`
  const configured = privateKeyPath()
  if (!configured) {
    if (await exists(receipt)) throw new Error("Native Node package cannot inherit an old publisher receipt")
    return { state: "publisher_not_configured" as const }
  }
  if (!(await exists(metadata))) throw new Error("Native Node package is missing its compiled component inventory")
  if (await exists(receipt)) throw new Error("Native Node package already carries a receipt for another stage")
  const runtime = path.join(app, `Contents/Frameworks/${name} Helper.app/Contents/MacOS/${name} Helper`)
  const { verifyMacNativeAssets } = await import("./mac-native-assets")
  await verifyMacNativeAssets(path.dirname(module), runtime)
  const { fileURLToPath } = await import("node:url")
  // Keep the existing publisher implementation in its own Bun build-tool process;
  // the installed app never imports this script or gains a signing operation.
  const signed = await execFileAsync(
    "bun",
    [
      fileURLToPath(new URL("../../deepagent-code/script/sign-native-node.ts", import.meta.url)),
      "--module",
      await fs.realpath(module),
      "--runtime",
      await fs.realpath(runtime),
      "--key",
      configured,
      "--release",
      process.env.DEEPAGENT_CODE_RELEASE_ID?.trim() || "dac-installed-local-candidate",
    ],
    { maxBuffer: 32_768 },
  )
  const result = JSON.parse(signed.stdout) as {
    payload?: { runtime?: { sha256?: string }; executable?: { sha256?: string } }
    signerHash?: string
  }
  if (
    !/^[0-9a-f]{64}$/.test(result.payload?.runtime?.sha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(result.payload?.executable?.sha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(result.signerHash ?? "")
  )
    throw new Error("Native Node publisher returned an invalid artifact receipt")
  const publicPin = process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY?.trim()
  if (!publicPin) throw new Error("Native Node package sealing requires its compiled public release pin")
  requireNativePublisherSigner(result.signerHash!, publicPin.includes("-----BEGIN")
    ? publicPin : await fs.readFile(publicPin, "utf8"))
  return {
    state: "sealed" as const,
    module,
    runtime,
    runtimeHash: result.payload!.runtime!.sha256!,
    moduleHash: result.payload!.executable!.sha256!,
    signerHash: result.signerHash!,
  }
}

export function requireNativePublisherSigner(signerHash: string, publicPin: string) {
  if (publicPin.includes("PRIVATE KEY") || !publicPin.includes("-----BEGIN PUBLIC KEY-----"))
    throw new Error("Native Node package sealing requires a public release pin")
  const publicKey = createPublicKey(publicPin)
  if (publicKey.asymmetricKeyType !== "ed25519" || !/^[0-9a-f]{64}$/.test(signerHash) ||
    createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex") !== signerHash)
    throw new Error("Native Node publisher signer does not match the compiled public release pin")
}

/** First let electron-builder's real osx-sign implementation finish every nested image.
 * After the fixed utility bytes are sealed, sign only the outer .app again. Signing the
 * helper a second time would invalidate its exact Native Node runtime fingerprint. */
export async function signMacWithNativeNode(options: MacSignOptions) {
  if (!privateKeyPath()) throw new Error("Signed Native Node packaging requires the release publisher key")
  if (!process.env.DEEPAGENT_CODE_RELEASE_ID?.trim())
    throw new Error("Signed Native Node packaging requires an explicit release identity")
  if (
    await exists(
      path.join(options.app, "Contents/Resources/app.asar.unpacked/out/main/chunks/node.js.native-installation.json"),
    )
  )
    throw new Error("Native Node package already carries a receipt for another signing stage")
  const { createRequire } = await import("node:module")
  const owner = createRequire(createRequire(import.meta.url).resolve("electron-builder"))
  const dependency = createRequire(owner.resolve("app-builder-lib"))
  const osx: { signAsync(options: MacSignOptions): Promise<void> } = await import(
    dependency.resolve("@electron/osx-sign")
  )
  const perFile = options.optionsForFile?.(options.app)
  if (Array.isArray(perFile?.entitlements) || perFile?.additionalArguments?.includes("--deep"))
    throw new Error("Native Node outer signing requires fixed entitlements and forbids recursive re-signing")
  const directory = path.join(options.app, "Contents/Resources/app.asar.unpacked/out/main/chunks")
  const { verifyMacNativeAssets } = await import("./mac-native-assets")
  const verified = await verifyMacNativeAssets(directory,
    path.join(options.app, `Contents/Frameworks/${path.basename(options.app, ".app")} Helper.app/Contents/MacOS/${path.basename(options.app, ".app")} Helper`))
  const { verifyManagedBrowserInputPackAsset } = await import("./managed-browser-input-assets")
  const browserInputDirectory = path.join(options.app,
    "Contents/Resources/app.asar.unpacked/out/main/managed-browser-input")
  const browserInput = await verifyManagedBrowserInputPackAsset({ directory: browserInputDirectory })
  if (!browserInput) throw new Error("Signed managed browser package requires its fixed input observer")
  if (process.env.DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY?.trim().toLowerCase() !== options.identity?.toLowerCase())
    throw new Error("Signed Native Node package requires all native assets pre-signed by the selected certificate")
  const fixed = await Promise.all(
    [...verified.files, path.join(browserInputDirectory, browserInput.filename)].map(async (filename) => {
      await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", filename])
      return filename
    }),
  )
  const ignored = options.ignore
  await osx.signAsync({
    ...options,
    ignore: (filename) =>
      fixed.includes(filename) ||
      (typeof ignored === "function"
        ? ignored(filename)
        : (typeof ignored === "string" ? [ignored] : (ignored ?? [])).some((pattern) =>
            new RegExp(pattern).test(filename),
          )),
  })
  const name = path.basename(options.app, ".app")
  const sealed = await sealMacApp(options.app, name)
  if (sealed.state !== "sealed") return
  if (!options.identity) throw new Error("Native Node outer signing requires the selected real signing identity")
  const flags = Array.isArray(perFile?.signatureFlags)
    ? perFile.signatureFlags
    : (perFile?.signatureFlags?.split(",") ?? [])
  const runtimeFlags = [...new Set([...flags, ...(perFile?.hardenedRuntime !== false ? ["runtime"] : [])])]
  const args = [
    "--force",
    "--sign",
    options.identity,
    ...(options.keychain ? ["--keychain", options.keychain] : []),
    ...(runtimeFlags.length ? ["--options", runtimeFlags.join(",")] : []),
    ...(perFile?.entitlements ? ["--entitlements", perFile.entitlements] : []),
    ...(perFile?.requirements ? ["--requirements", perFile.requirements] : []),
    ...(perFile?.timestamp
      ? [`--timestamp=${perFile.timestamp}`]
      : options.identity === "-"
        ? ["--timestamp=none"]
        : ["--timestamp"]),
    ...(perFile?.additionalArguments ?? []),
    options.app,
  ]
  await execFileAsync("/usr/bin/codesign", args)
  await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", options.app])
  const runtime = await fs.readFile(sealed.runtime)
  if (createHash("sha256").update(runtime).digest("hex") !== sealed.runtimeHash)
    throw new Error("Outer signing changed the sealed Native Node utility interpreter")
}

function exists(filename: string) {
  return fs.lstat(filename).then(
    () => true,
    () => false,
  )
}
