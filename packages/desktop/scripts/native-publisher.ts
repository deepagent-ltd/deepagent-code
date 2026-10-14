#!/usr/bin/env bun
import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { prepareNativePublisher, cleanupNativePublisher, verifyNativePublisherKeys,
  guardTestNativeAssets, verifyTestNativeReceipt, verifyTestWindowsPreloader,
  sealTestNativeCLI, verifyTestWindowsCLIPreloader } from "./test-native-publisher"
import { verifyMacNativeAssets } from "./mac-native-assets"

class Refused extends Error {
  constructor(readonly code: string) { super(code) }
}

/** Select only the configured imported certificate; never substitute the QA ad-hoc identity. */
export function releaseMacAssetIdentity(input: { signed: boolean; certificateName?: string; identities: string }) {
  if (!input.signed) return null
  const name = input.certificateName?.trim()
  if (!name || name === "-" || /[\r\n]/.test(input.certificateName ?? "")) throw new Refused("RELEASE_MAC_CERTIFICATE_REJECTED")
  const selected = Array.from(input.identities.matchAll(/^\s*\d+\)\s+([0-9a-f]{40})\s+"([^"\r\n]+)"\s*$/gim))
    .filter((entry) => entry[2].startsWith("Developer ID Application:") &&
      (entry[1].toLowerCase() === name.toLowerCase() || entry[2].includes(name)))
  if (selected.length !== 1) throw new Refused("RELEASE_MAC_CERTIFICATE_REJECTED")
  return selected[0][1]
}

export async function prepareReleaseNativePublisher(input: {
  runnerTemp: string; environmentFile: string; version: string; runID: string; attempt: string;
  macAssetSigningIdentity: string | null
}) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(input.version) ||
    !/^\d+$/.test(input.runID) || !/^\d+$/.test(input.attempt))
    throw new Refused("RELEASE_NATIVE_IDENTITY_REJECTED")
  return prepareNativePublisher({ ...input, target: `${process.platform}-${process.arch}`, release: true,
    releaseID: `dac-desktop-${input.version}-${process.platform}-${process.arch}-gh${input.runID}.${input.attempt}` })
}

/** Seal final OS-signed CLI bytes in the same job that compiled their public pin.
 * Only the existing native issuer creates receipts; keys never cross job boundaries. */
export async function sealReleaseNativeCLI(input: {
  directory: string; target: string; version: string; releaseID: string;
  sourceCommit: string; sourceTree: string; privateKeyFile: string; publicKeyFile: string
}) {
  if (!["darwin-arm64", "darwin-x64", "win32-x64"].includes(input.target) ||
    input.target !== `${process.platform}-${process.arch}` ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(input.version) ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(input.releaseID) ||
    ![input.sourceCommit, input.sourceTree].every((value) => /^[a-f0-9]{40,64}$/.test(value)))
    throw new Refused("RELEASE_CLI_IDENTITY_REJECTED")
  const { Schema } = await import("effect")
  const { NativeInstallationSchema } = await import("../../deepagent-code/src/installation/native-installation.schema")
  const directory = await fs.realpath(input.directory)
  if (directory !== input.directory) throw new Refused("RELEASE_CLI_DIRECTORY_REJECTED")
  const prefix = `deepagent-code-${input.target.replace("win32", "windows")}`
  const names = input.target.endsWith("-x64") ? [prefix, `${prefix}-baseline`] : [prefix]
  return await Promise.all(names.map(async (name) => {
    const packageFile = path.join(directory, name, "package.json")
    const metadata = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
      name: Schema.String, version: Schema.String, preferUnplugged: Schema.Boolean,
      os: Schema.Array(Schema.String), cpu: Schema.Array(Schema.String), libc: Schema.optional(Schema.Array(Schema.String)),
      deepagentCodeBuild: Schema.Struct({ sourceCommit: Schema.String, sourceDirty: Schema.Boolean, binarySha256: Schema.String }),
    })), { onExcessProperty: "error" })(await fs.readFile(packageFile, "utf8"))
    if (metadata.name !== name || metadata.version !== input.version ||
      metadata.deepagentCodeBuild?.sourceCommit !== input.sourceCommit || metadata.deepagentCodeBuild?.sourceDirty !== false)
      throw new Refused("RELEASE_CLI_SOURCE_REJECTED")
    const executable = path.join(directory, name, "bin", `deepagent-code${input.target.startsWith("win32-") ? ".exe" : ""}`)
    const components = Schema.decodeUnknownSync(Schema.fromJsonString(NativeInstallationSchema.Components), {
      onExcessProperty: "error",
    })(await fs.readFile(`${executable}.native-components.json`, "utf8"))
    if (components.target !== input.target || components.sourceCommit !== input.sourceCommit || components.sourceTree !== input.sourceTree)
      throw new Refused("RELEASE_CLI_SOURCE_REJECTED")
    const assets = await guardTestNativeAssets({ executable, target: input.target, kind: "cli" })
    const sealed = await sealTestNativeCLI({ executable, ...input })
    const receipt = await verifyTestNativeReceipt({ executable, ...input })
    if (receipt.signerHash !== sealed.signerHash) throw new Refused("RELEASE_CLI_PUBLISHER_CHANGED")
    const preloader = input.target.startsWith("win32-")
      ? await verifyTestWindowsCLIPreloader({ executable, ...input }) : undefined
    // Authenticode/codesign modifies the executable after compilation. The
    // package digest must describe those exact final, sealed bytes.
    await fs.writeFile(packageFile, JSON.stringify({ ...metadata,
      deepagentCodeBuild: { ...metadata.deepagentCodeBuild, binarySha256: sealed.executableHash },
    }, null, 2))
    return { name, executable, ...sealed, ...assets, state: "verified_build_receipt",
      ...(preloader ? { preloader } : {}), functionalAcceptance: false, privateKeyUploaded: false }
  }))
}

/** Exact build receipts only. This never executes the app or marks functional acceptance passed. */
export async function guardReleaseNativePackage(input: {
  directory: string; target: string; channel: string; releaseID: string;
  privateKeyFile?: string; publicKeyFile?: string
}) {
  if (!input.privateKeyFile || !input.publicKeyFile || input.target !== `${process.platform}-${process.arch}` ||
    !["prod", "beta"].includes(input.channel) || !/^[A-Za-z0-9_.-]{1,128}$/.test(input.releaseID))
    throw new Refused("RELEASE_NATIVE_ENVIRONMENT_REJECTED")
  const publisher = await verifyNativePublisherKeys(input.privateKeyFile, input.publicKeyFile)
  const product = input.channel === "prod" ? "DeepAgent Code" : "DeepAgent Code Beta"
  const packed = new Map([["darwin-arm64", "mac-arm64"], ["darwin-x64", "mac"],
    ["linux-x64", "linux-unpacked"], ["win32-x64", "win-unpacked"]]).get(input.target)
  if (!packed) throw new Refused("RELEASE_NATIVE_TARGET_REJECTED")
  const directory = await fs.realpath(input.directory)
  const app = input.target.startsWith("darwin-") ? path.join(directory, packed, `${product}.app`) : undefined
  const main = path.join(app ? path.join(app, "Contents/Resources") : path.join(directory, packed, "resources"),
    "app.asar.unpacked/out/main")
  const runtime = app
    ? path.join(app, `Contents/Frameworks/${product} Helper.app/Contents/MacOS/${product} Helper`)
    : path.join(directory, packed, input.target.startsWith("win32-") ? `${product}.exe`
      : input.channel === "prod" ? "deepagent-code" : "deepagent-code-beta")
  const module = path.join(main, "chunks/node.js")
  const assets = await guardTestNativeAssets({ executable: module, target: input.target, kind: "desktop" })
  const receipt = await verifyTestNativeReceipt({ executable: module, runtime, target: input.target,
    releaseID: input.releaseID, publicKeyFile: input.publicKeyFile })
  if (receipt.signerHash !== publisher.signerHash) throw new Refused("RELEASE_NATIVE_PUBLISHER_CHANGED")
  if (app) await verifyMacNativeAssets(path.dirname(module), runtime)
  const preloader = input.target.startsWith("win32-")
    ? await verifyTestWindowsPreloader({ main, target: input.target, publicKeyFile: input.publicKeyFile }) : undefined
  return { state: "verified_build_receipt", target: input.target, releaseID: input.releaseID,
    signerHash: receipt.signerHash, receiptHash: receipt.receiptHash, ...assets,
    ...(preloader ? { preloader } : {}), functionalAcceptance: false, privateKeyUploaded: false }
}

if (import.meta.main) {
  const phase = process.argv[2]
  try {
    if (phase === "cleanup") {
      console.log(JSON.stringify(await cleanupNativePublisher({ runnerTemp: process.env.RUNNER_TEMP ?? "", release: true,
        privateKeyFile: process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY,
        publicKeyFile: process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY })))
    } else if (phase === "prepare") {
      if (process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY || process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY)
        throw new Refused("RELEASE_NATIVE_EXISTING_PUBLISHER_REJECTED")
      const signed = process.platform === "darwin" && process.env.DAC_NATIVE_APPLE_SIGNED === "1"
      const identities = signed ? (await promisify(execFile)("/usr/bin/security",
        ["find-identity", "-v", "-p", "codesigning"], { maxBuffer: 65_536 })).stdout : ""
      const publisher = await prepareReleaseNativePublisher({ runnerTemp: process.env.RUNNER_TEMP ?? "",
        environmentFile: process.env.GITHUB_ENV ?? "", version: process.env.DEEPAGENT_CODE_VERSION ?? "",
        runID: process.env.GITHUB_RUN_ID ?? "", attempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
        macAssetSigningIdentity: releaseMacAssetIdentity({ signed, certificateName: process.env.CSC_NAME, identities }) })
      console.log(JSON.stringify({ state: "prepared", target: publisher.target, releaseID: publisher.releaseID,
        signerHash: publisher.signerHash, keyStorage: "RUNNER_TEMP", privateKeyUploaded: false, functionalAcceptance: false }))
    } else if (phase === "seal-cli") {
      console.log(JSON.stringify(await sealReleaseNativeCLI({ directory: path.resolve("packages/deepagent-code/dist"),
        target: `${process.platform}-${process.arch}`, version: process.env.DEEPAGENT_CODE_VERSION ?? "",
        releaseID: process.env.DEEPAGENT_CODE_RELEASE_ID ?? "",
        sourceCommit: process.env.DEEPAGENT_CODE_CANDIDATE_COMMIT ?? "",
        sourceTree: process.env.DEEPAGENT_CODE_CANDIDATE_TREE ?? "",
        privateKeyFile: process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY ?? "",
        publicKeyFile: process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY ?? "" })))
    } else if (phase === "guard") {
      console.log(JSON.stringify(await guardReleaseNativePackage({ directory: path.resolve("packages/desktop/dist"),
        target: `${process.platform}-${process.arch}`, channel: process.env.DEEPAGENT_CODE_CHANNEL ?? "",
        releaseID: process.env.DEEPAGENT_CODE_RELEASE_ID ?? "",
        privateKeyFile: process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY,
        publicKeyFile: process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY })))
    } else throw new Refused("RELEASE_NATIVE_PHASE_REJECTED")
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" &&
      /^[A-Z0-9_]{1,128}$/.test(error.code) ? error.code : "RELEASE_NATIVE_PUBLISHER_REFUSED"
    console.error(JSON.stringify({ state: "refused", phase, code, functionalAcceptance: false }))
    process.exitCode = 1
  }
}
