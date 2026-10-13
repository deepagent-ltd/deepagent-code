#!/usr/bin/env bun
import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { prepareNativePublisher, cleanupNativePublisher, verifyNativePublisherKeys,
  guardTestNativeAssets, verifyTestNativeReceipt, verifyTestWindowsPreloader } from "./test-native-publisher"
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
